// Pi: sigue el JSONL exacto que su integración de Herdr reporta para cada pane.
//
// La ruta es solo una referencia de entrada: debe pertenecer a una raíz de sesiones permitida y la
// cabecera debe confirmar id y cwd antes de que cualquier fila llegue al almacén común. El contenido
// conversacional nunca se conserva ni sale al navegador; solo se extraen métricas y nombres de tools.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firstLine, tailJsonl } from '../jsonl.mjs';
import { isSafeSessionId } from '../identifiers.mjs';
import { isInsidePath, pathKey, realPath, samePath } from '../paths.mjs';
import { mapLimit } from '../concurrency.mjs';
import { readJSONFile } from '../safe-json-file.mjs';

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
const DEFAULT_ROOT = process.env.LCARS_PI_SESSIONS || path.join(AGENT_DIR, 'sessions');
const DEFAULT_MODELS = process.env.LCARS_PI_MODELS || path.join(AGENT_DIR, 'models.json');
const POLL_MS = 1500;
const MAX_ROOTS = 32;
const MAX_PROJECT_DIRS = 5000;
const MAX_SESSION_FILES = 5000;
const MODEL_REFRESH_MS = 10_000;

const boundedString = (value, max) => typeof value === 'string' && value.length <= max ? value : null;
const numberOrNull = (value, max = 1e12) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(number, max) : null;
};
const timeOf = (value) => {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
};
const normalizedRoots = (roots) => [...new Set((Array.isArray(roots) ? roots : [roots])
  .filter((root) => typeof root === 'string' && root && path.isAbsolute(root))
  .map((root) => path.resolve(root)))].slice(0, MAX_ROOTS);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

function loopbackEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1'].includes(host);
  } catch { return null; }
}

/** Valida una ruta reportada por Pi sin permitir que se convierta en un lector arbitrario. */
export async function inspectPiSessionFile(file, { roots = [DEFAULT_ROOT], cwd = null } = {}) {
  const safeRoots = normalizedRoots(roots);
  if (typeof file !== 'string' || !file || file.length > 4096 || file.includes('\0') || !path.isAbsolute(file)) {
    fail('PI_INVALID_PATH', 'ruta de sesión Pi no válida');
  }
  const candidate = path.resolve(file);
  if (path.extname(candidate).toLowerCase() !== '.jsonl'
    || !safeRoots.some((root) => isInsidePath(root, candidate))) {
    fail('PI_PATH_OUTSIDE_ROOT', 'la sesión Pi no pertenece a una raíz permitida');
  }

  const stat = await fsp.lstat(candidate);
  if (stat.isSymbolicLink()) fail('ELOOP', 'no se siguen enlaces simbólicos');
  if (!stat.isFile()) fail('PI_INVALID_FILE_TYPE', 'la sesión Pi no es un fichero regular');

  const [real, ...realRoots] = await Promise.all([realPath(candidate), ...safeRoots.map(async (root) => {
    try { return await realPath(root); } catch { return null; }
  })]);
  if (!realRoots.some((root) => root && isInsidePath(root, real))) {
    fail('PI_PATH_OUTSIDE_ROOT', 'la sesión Pi resuelve fuera de una raíz permitida');
  }

  let header;
  try { header = JSON.parse(await firstLine(real)); }
  catch (error) { fail(error.code || 'PI_INVALID_HEADER', 'cabecera de sesión Pi no válida'); }
  const sessionId = header?.type === 'session' ? (header.id || header.session?.id) : null;
  const sessionCwd = header?.type === 'session' ? (header.cwd || header.session?.cwd) : null;
  if (!isSafeSessionId(sessionId)) fail('PI_INVALID_SESSION_ID', 'cabecera Pi sin id de sesión válido');
  if (typeof sessionCwd !== 'string' || !path.isAbsolute(sessionCwd) || sessionCwd.length > 4096) {
    fail('PI_INVALID_CWD', 'cabecera Pi sin directorio válido');
  }
  if (cwd && !samePath(sessionCwd, cwd)) fail('PI_CWD_MISMATCH', 'la sesión Pi no pertenece al pane');
  return { file: real, sessionId, cwd: sessionCwd };
}

async function locateById(sessionId, roots, cwd) {
  if (!isSafeSessionId(sessionId)) return null;
  const suffixes = [`_${sessionId}.jsonl`, `${sessionId}.jsonl`];
  for (const root of normalizedRoots(roots)) {
    let entries;
    try { entries = (await fsp.readdir(root, { withFileTypes: true })).slice(0, MAX_PROJECT_DIRS); }
    catch { continue; }
    const direct = entries.filter((entry) => entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix)))
      .map((entry) => path.join(root, entry.name));
    const nested = await mapLimit(entries.filter((entry) => entry.isDirectory()), 16, async (entry) => {
      const dir = path.join(root, entry.name);
      try {
        const names = (await fsp.readdir(dir)).slice(0, MAX_SESSION_FILES);
        const name = names.find((item) => suffixes.some((suffix) => item.endsWith(suffix)));
        return name ? path.join(dir, name) : null;
      } catch { return null; }
    });
    for (const candidate of [...direct, ...nested.filter(Boolean)]) {
      try { return await inspectPiSessionFile(candidate, { roots: [root], cwd }); }
      catch { /* otra sesión o una entrada no fiable: se sigue buscando */ }
    }
  }
  return null;
}

class PiModelCatalog {
  constructor(file, onWarn) {
    this.file = file; this.onWarn = onWarn; this.models = new Map();
    this.mtimeMs = -1; this.nextCheck = 0; this.lastError = null;
  }

  async refresh(force = false) {
    const now = Date.now();
    if (!force && now < this.nextCheck) return;
    this.nextCheck = now + MODEL_REFRESH_MS;
    try {
      const stat = await fsp.lstat(this.file);
      if (stat.mtimeMs === this.mtimeMs) return;
      const raw = await readJSONFile(this.file, { maxBytes: 4 * 1024 * 1024 });
      const next = new Map();
      const providers = raw?.providers && typeof raw.providers === 'object' && !Array.isArray(raw.providers)
        ? Object.entries(raw.providers).slice(0, 200) : [];
      for (const [provider, config] of providers) {
        if (!boundedString(provider, 120) || !config || typeof config !== 'object') continue;
        const local = loopbackEndpoint(config.baseUrl);
        for (const model of (Array.isArray(config.models) ? config.models : []).slice(0, 5000)) {
          const id = boundedString(model?.id, 500);
          if (!id) continue;
          next.set(`${provider}\0${id}`, {
            contextWindow: numberOrNull(model.contextWindow, 10_000_000),
            local,
          });
        }
      }
      this.models = next; this.mtimeMs = stat.mtimeMs; this.lastError = null;
    } catch (error) {
      const signature = `${error.code || error.name}:${error.message}`;
      if (signature !== this.lastError) this.onWarn?.(`pi modelos: ${error.code || error.message}`);
      this.lastError = signature;
    }
  }

  lookup(provider, model) { return this.models.get(`${provider}\0${model}`) || null; }
}

class PiFollower {
  constructor(sessionId, file, store, onEvent, catalog) {
    this.sessionId = sessionId; this.file = file; this.store = store; this.onEvent = onEvent; this.catalog = catalog;
    this.offset = 0; this.reading = false; this.initial = true; this.provider = null; this.model = null;
  }

  identity(session, provider = this.provider, model = this.model) {
    this.provider = boundedString(provider, 120) || this.provider;
    this.model = boundedString(model, 500) || this.model;
    const info = this.catalog.lookup(this.provider, this.model);
    session.setIdentity({ model: this.model, provider: this.provider, local: info?.local });
    return info;
  }

  handle(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    const session = this.store.get(this.sessionId);
    const completedAt = timeOf(row.timestamp);
    if (row.type === 'model_change') {
      this.identity(session, row.provider, row.modelId);
      return;
    }
    if (row.type !== 'message' || !row.message || typeof row.message !== 'object') return;
    const message = row.message;
    if (message.role === 'user') {
      if (session.addTurn(row.id) && !this.initial) this.onEvent?.({ kind: 'prompt', sessionId: this.sessionId, ts: completedAt });
      return;
    }
    if (message.role === 'toolResult') {
      session.addTool({
        ts: completedAt, key: message.toolCallId || row.id, name: message.toolName,
        success: message.isError !== true,
      });
      return;
    }
    if (message.role !== 'assistant') return;

    const info = this.identity(session, message.provider, message.model);
    const usage = message.usage && typeof message.usage === 'object' ? message.usage : {};
    const start = numberOrNull(message.timestamp, Number.MAX_SAFE_INTEGER);
    const durationMs = start && completedAt >= start ? completedAt - start : 0;
    const stopReason = boundedString(message.stopReason, 120);
    const success = !['error', 'aborted'].includes(stopReason) && !message.errorMessage;
    const reportedCost = numberOrNull(usage.cost?.total, 1e9);
    const added = session.addRequest({
      ts: completedAt, requestId: message.responseId || row.id, model: this.model,
      input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
      reasoning: usage.reasoning, durationMs, ttftMs: null, costUsd: reportedCost,
      stopReason, success, kind: 'main',
    }, 'pi');

    const totalTokens = numberOrNull(usage.totalTokens);
    if (totalTokens > 0 && info?.contextWindow > 0) {
      session.setContext({
        usedPercent: Math.min(100, 100 * totalTokens / info.contextWindow), size: info.contextWindow,
        current: {
          input_tokens: usage.input, output_tokens: usage.output,
          cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: usage.cacheWrite,
        },
      });
    }
    if (!added || this.initial) return;
    if (!success) this.onEvent?.({
      kind: 'api_error', sessionId: this.sessionId, ts: completedAt,
      error: boundedString(message.errorMessage, 2000) || stopReason || 'error', model: this.model,
    });
    else if (stopReason !== 'toolUse') this.onEvent?.({ kind: 'turn_done', sessionId: this.sessionId, ts: completedAt, durationMs });
  }

  async readNew() {
    if (this.reading) return false;
    this.reading = true;
    try {
      const result = await tailJsonl(this.file, this.offset, (row) => this.handle(row));
      this.offset = result.offset; this.initial = false;
      return result.changed;
    } catch (error) {
      if (error.code !== 'ENOENT') this.onEvent?.({ kind: 'warn', message: `pi ${this.sessionId}: ${error.code || error.message}` });
      return false;
    } finally { this.reading = false; }
  }
}

export class PiAdapter {
  static kind = 'pi';

  constructor(store, onEvent, {
    roots = () => [DEFAULT_ROOT], modelsFile = DEFAULT_MODELS, pollMs = POLL_MS,
  } = {}) {
    this.store = store; this.onEvent = onEvent;
    this.roots = typeof roots === 'function' ? roots : () => roots;
    this.catalog = new PiModelCatalog(modelsFile, (message) => this.onEvent?.({ kind: 'warn', message }));
    this.pollMs = Math.max(250, Number(pollMs) || POLL_MS);
    this.byPane = new Map(); this.followers = new Map(); this.failures = new Map();
    this.timer = null; this.polling = false;
  }

  recordFailure(paneId, reference, error) {
    const now = Date.now(), previous = this.failures.get(paneId);
    const tries = previous?.reference === reference ? previous.tries + 1 : 1;
    const next = now + Math.min(60_000, 2_000 * tries);
    this.failures.set(paneId, { reference, tries, next });
    if (!previous || previous.reference !== reference || now >= previous.next) {
      this.onEvent?.({ kind: 'warn', message: `pi ${paneId}: ${error.code || error.message}` });
    }
  }

  async resolve(agent, roots) {
    const reference = agent.sessionPath ? `path:${agent.sessionPath}`
      : isSafeSessionId(agent.sessionId) ? `id:${agent.sessionId}` : null;
    if (!reference) { this.byPane.delete(agent.paneId); return null; }
    const cwdKey = pathKey(agent.cwd);
    const cached = this.byPane.get(agent.paneId);
    if (cached?.reference === reference && cached.cwdKey === cwdKey) return cached;
    const failed = this.failures.get(agent.paneId);
    if (failed?.reference === reference && Date.now() < failed.next) return null;
    try {
      const hit = agent.sessionPath
        ? await inspectPiSessionFile(agent.sessionPath, { roots, cwd: agent.cwd })
        : await locateById(agent.sessionId, roots, agent.cwd);
      if (!hit) fail('PI_SESSION_NOT_FOUND', 'sesión Pi no encontrada');
      const resolved = { ...hit, reference, cwdKey };
      this.byPane.set(agent.paneId, resolved); this.failures.delete(agent.paneId);
      return resolved;
    } catch (error) {
      this.byPane.delete(agent.paneId); this.recordFailure(agent.paneId, reference, error);
      return null;
    }
  }

  /** agents: [{paneId, sessionId|null, sessionPath|null, cwd}]. null revoca una resolución anterior. */
  async sync(agents) {
    const roots = normalizedRoots(this.roots());
    const live = new Set(agents.map((agent) => agent.paneId));
    for (const map of [this.byPane, this.failures]) {
      for (const paneId of [...map.keys()]) if (!live.has(paneId)) map.delete(paneId);
    }
    await this.catalog.refresh();
    const resolved = await mapLimit(agents, 8, (agent) => this.resolve(agent, roots));
    const want = new Map(), files = new Map();
    agents.forEach((agent, index) => {
      const hit = resolved[index];
      want.set(agent.paneId, hit?.sessionId || null);
      if (hit) files.set(hit.sessionId, hit.file);
    });

    for (const [sessionId] of this.followers) if (!files.has(sessionId)) this.followers.delete(sessionId);
    let added = false;
    for (const [sessionId, file] of files) {
      const current = this.followers.get(sessionId);
      if (current?.file === file) continue;
      this.followers.set(sessionId, new PiFollower(sessionId, file, this.store, this.onEvent, this.catalog));
      added = true;
    }
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), this.pollMs);
      this.timer.unref?.();
    }
    if (added) await this.poll();
    return want;
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.catalog.refresh();
      await mapLimit([...this.followers.values()], 16, (follower) => follower.readNew());
    } finally { this.polling = false; }
  }

  close() {
    clearInterval(this.timer); this.timer = null;
    this.byPane.clear(); this.followers.clear(); this.failures.clear();
  }
}
