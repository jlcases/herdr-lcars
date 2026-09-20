// Repositorio de snapshots de contexto: privado, atomico, versionado y serializado por contexto.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { migrateRecord } from '../domain/record.mjs';
import { readJSONFile } from '../../safe-json-file.mjs';
import { renameReplace } from '../../atomic-rename.mjs';

const STORE_VERSION = 1;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (id) => createHash('sha256').update(id).digest('base64url');
const legacySlug = (id) => Buffer.from(id).toString('base64url').slice(0, 80);

export class FileContextRepository {
  #queues = new Map();
  #prepared = null;

  constructor(dir, { lockTimeoutMs = 5_000, staleLockMs = 30_000 } = {}) {
    this.dir = dir;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
  }

  #file(id) { return path.join(this.dir, `${digest(id)}.json`); }
  #legacyFile(id) { return path.join(this.dir, `${legacySlug(id)}.json`); }

  async #prepare() {
    this.#prepared ??= (async () => {
      await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await fsp.chmod(this.dir, 0o700);
    })().catch((error) => { this.#prepared = null; throw error; });
    return this.#prepared;
  }

  async #readFile(file, expectedId, sourceId, workspace) {
    let raw;
    try {
      raw = await readJSONFile(file, { maxBytes: MAX_RECORD_BYTES });
      await fsp.chmod(file, 0o600);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      const failure = new Error(`registro de contexto ilegible: ${path.basename(file)}`);
      failure.code = 'CONTEXT_CORRUPT';
      failure.cause = error;
      throw failure;
    }
    if (raw?.storeVersion != null && raw.storeVersion !== STORE_VERSION) {
      const failure = new Error(`version de almacenamiento no admitida: ${String(raw.storeVersion)}`);
      failure.code = 'CONTEXT_CORRUPT';
      throw failure;
    }
    const envelope = raw?.storeVersion === STORE_VERSION ? raw : null;
    if (envelope && (!Number.isSafeInteger(envelope.revision) || envelope.revision < 1)) {
      const failure = new Error('revision de contexto no valida');
      failure.code = 'CONTEXT_CORRUPT';
      throw failure;
    }
    const stored = envelope ? envelope.record : raw;
    if (!stored || typeof stored !== 'object') throw new Error('registro de contexto sin snapshot');
    if (envelope?.contextId && envelope.contextId !== sourceId) {
      const collision = new Error('la envoltura pertenece a otro contexto');
      collision.code = 'CONTEXT_KEY_COLLISION';
      throw collision;
    }
    if (stored.contextId && stored.contextId !== sourceId) {
      const collision = new Error('colision detectada en una clave de contexto antigua');
      collision.code = 'CONTEXT_KEY_COLLISION';
      throw collision;
    }
    if (sourceId !== expectedId) {
      const checkoutMatches = stored.checkoutPath && workspace.checkoutPath
        && stored.checkoutPath === workspace.checkoutPath;
      const checkoutAlias = sourceId === workspace.checkoutPath;
      // La clave antigua repo#rama era ambigua entre worktrees. Sin una ruta coincidente no se
      // importa: perder una nota es preferible a filtrar el contexto de otro checkout.
      if (!checkoutMatches && !checkoutAlias) return null;
    }
    const importable = sourceId === expectedId ? stored : { ...stored, version: 1, contextId: expectedId };
    return { record: migrateRecord(importable, expectedId, workspace), revision: envelope?.revision ?? 0,
      needsMigration: sourceId !== expectedId || !envelope || stored.version !== 2 };
  }

  async #loadEntry(contextId, { aliases = [], workspace = {} } = {}) {
    await this.#prepare();
    const current = await this.#readFile(this.#file(contextId), contextId, contextId, workspace);
    if (current) return current;
    for (const alias of [...new Set([contextId, ...aliases])]) {
      const modern = alias === contextId ? null : await this.#readFile(this.#file(alias), contextId, alias, workspace);
      if (modern) return modern;
      const legacy = await this.#readFile(this.#legacyFile(alias), contextId, alias, workspace);
      if (legacy) return legacy;
    }
    return null;
  }

  async load(contextId, options = {}) {
    return (await this.#loadEntry(contextId, options))?.record ?? null;
  }

  async #acquire(file) {
    const lock = `${file}.lock`;
    const deadline = Date.now() + this.lockTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const handle = await fsp.open(lock, 'wx', 0o600);
        await handle.writeFile(`${process.pid}\n${Date.now()}\n`);
        return { lock, handle };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const stat = await fsp.stat(lock);
          if (Date.now() - stat.mtimeMs > this.staleLockMs) { await fsp.unlink(lock); continue; }
        } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
        await wait(20 + Math.floor(Math.random() * 30));
      }
    }
    const error = new Error('tiempo agotado esperando el bloqueo del contexto');
    error.code = 'CONTEXT_LOCK_TIMEOUT';
    throw error;
  }

  async #release(lock) {
    await lock.handle.close().catch(() => {});
    await fsp.unlink(lock.lock).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }

  async #write(file, envelope) {
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fsp.open(tmp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(envelope));
      await handle.sync();
      await handle.close(); handle = null;
      await renameReplace(tmp, file);
      await fsp.chmod(file, 0o600);
      let directory;
      try { directory = await fsp.open(this.dir, 'r'); await directory.sync(); }
      catch { /* no todos los FS permiten fsync de directorio */ }
      finally { await directory?.close().catch(() => {}); }
    } finally {
      await handle?.close().catch(() => {});
      await fsp.unlink(tmp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async #update(contextId, options, mutate) {
    await this.#prepare();
    const file = this.#file(contextId);
    const lock = await this.#acquire(file);
    let primaryError = null;
    try {
      const loaded = await this.#loadEntry(contextId, options);
      const current = loaded?.record ?? options.create();
      const next = await mutate(structuredClone(current));
      if (next == null && loaded && !loaded.needsMigration) return current;
      const record = next ?? current;
      if (!record || record.contextId !== contextId) throw new Error('la transaccion devolvio otro contexto');
      await this.#write(file, { storeVersion: STORE_VERSION, revision: (loaded?.revision ?? 0) + 1, contextId, record });
      return record;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try { await this.#release(lock); }
      catch (releaseError) { if (!primaryError) throw releaseError; }
    }
  }

  update(contextId, options, mutate) {
    const previous = this.#queues.get(contextId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.#update(contextId, options, mutate));
    this.#queues.set(contextId, run);
    return run.finally(() => { if (this.#queues.get(contextId) === run) this.#queues.delete(contextId); });
  }
}
