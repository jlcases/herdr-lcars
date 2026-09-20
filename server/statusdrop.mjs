// El statusline de Claude Code recibe por stdin un JSON con contexto, coste, caché y límites.
// El wrapper bin/lcars-statusline lo deja en ~/.cache/lcars-bridge/status/<session_id>.json y aquí se lee.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CACHE_HOME } from './claude.mjs';
import { mapLimit } from './concurrency.mjs';
import { isSafeSessionId } from './identifiers.mjs';
import { readJSONFile } from './safe-json-file.mjs';

export const STATUS_DIR = path.join(CACHE_HOME, 'lcars-bridge', 'status');
const MAX_DROP_BYTES = 1024 * 1024;
const MAX_DROP_FILES = 4096;

export const isStatusDropName = (name) => typeof name === 'string'
  && name.endsWith('.json') && isSafeSessionId(name.slice(0, -5));
const PROFILE_ID = /^[a-z][a-z0-9_-]{0,31}$/;

export class StatusDropWatcher {
  constructor(store, onDrop, { dir = STATUS_DIR } = {}) {
    this.store = store; this.onDrop = onDrop; this.dir = dir;
    this.mtimes = new Map(); this.timer = null; this.watcher = null; this.scanning = false; this._deb = null;
  }

  async start() {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.dir, 0o700);
    await this.scan();
    try {
      // fs.watch dice qué fichero cambió: leer solo ese evita barrer todo el directorio en cada
      // escritura de statusline (con 200 agentes eso era un barrido permanente).
      this.watcher = fs.watch(this.dir, (_ev, filename) => {
        if (isStatusDropName(filename)) this.readDrop(filename);
        else { clearTimeout(this._deb); this._deb = setTimeout(() => this.scan(), 200); }
      });
      this.watcher.on('error', () => {
        this.watcher?.close(); this.watcher = null; // el sondeo de 5 s sigue cubriendo el directorio
      });
    } catch { /* sin fs.watch: nos vale el sondeo */ }
    this.timer = setInterval(() => this.scan(), 5000);
  }

  /** Lee un único volcado. Devuelve false si ya estaba al día o no sirve. */
  async readDrop(name) {
    if (!isStatusDropName(name)) return false;
    const sid = name.slice(0, -5), file = path.join(this.dir, name);
    const now = Date.now();
    try {
      const st = await fsp.lstat(file);
      if (!st.isFile() || st.size > MAX_DROP_BYTES) return false;
      if (now - st.mtimeMs > 7 * 86400_000) { await fsp.unlink(file).catch(() => {}); this.mtimes.delete(sid); return false; }
      if (now - st.mtimeMs > 86400_000) return false; // sesión vieja: ni contexto ni cuota vigentes
      if (this.mtimes.get(sid) === st.mtimeMs) return false;
      const json = await readJSONFile(file, { maxBytes: MAX_DROP_BYTES });
      let profileId = null;
      try {
        const profileFile = path.join(this.dir, `${sid}.profile`);
        const profileStat = await fsp.lstat(profileFile);
        if (profileStat.isFile() && profileStat.size <= 64) {
          const candidate = (await fsp.readFile(profileFile, 'utf8')).trim();
          if (PROFILE_ID.test(candidate)) profileId = candidate;
          await fsp.chmod(profileFile, 0o600);
        }
      } catch { /* una sesión sin perfil explícito sigue siendo válida */ }
      await fsp.chmod(file, 0o600);
      this.mtimes.set(sid, st.mtimeMs);
      this.store.get(sid).setStatus(json, st.mtimeMs);
      this.onDrop?.(sid, json, { profileId, at: st.mtimeMs });
      // Los límites de cuenta son globales: gana el volcado más reciente de verdad, no el último que
      // devuelva readdir (en el primer barrido entran también ficheros antiguos).
      if (json.rate_limits && st.mtimeMs >= (this.latestLimits?.at || 0)) this.latestLimits = { at: st.mtimeMs, ...json.rate_limits };
      return true;
    } catch { return false; } // escritura a medias: se recoge en el siguiente pase
  }

  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      let names; try { names = await fsp.readdir(this.dir); } catch { return; }
      const drops = names.filter(isStatusDropName).slice(0, MAX_DROP_FILES);
      const live = new Set(drops.map((name) => name.slice(0, -5)));
      for (const sessionId of this.mtimes.keys()) if (!live.has(sessionId)) this.mtimes.delete(sessionId);
      await mapLimit(drops, 16, (name) => this.readDrop(name));
    } finally { this.scanning = false; }
  }

  close() {
    clearInterval(this.timer); clearTimeout(this._deb);
    this.timer = null; this._deb = null;
    this.watcher?.close(); this.watcher = null;
  }
}
