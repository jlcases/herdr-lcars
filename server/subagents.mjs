// Subagentes de Claude Code: cada sesión guarda en `<sesión>/subagents/agent-<id>.jsonl` (+ `.meta.json`)
// el transcript de cada subagente lanzado con la herramienta Agent. De ahí sale la granularidad por
// agente: tipo, descripción, tokens, coste, herramientas y si sigue trabajando.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PROJECTS, findSessionDir, readAssistantRow } from './claude.mjs';
import { tailJsonl } from './jsonl.mjs';
import { SessionTelemetry } from './telemetry.mjs';
import { mapLimit } from './concurrency.mjs';
import { isSafeSessionId } from './identifiers.mjs';

const SCAN_MS = 3000;
const ACTIVE_MS = 20_000;        // sin escribir en 20 s → ya no está trabajando
const SETTLING_MS = 5 * 60_000;  // después de este margen lo damos por terminado
const RECENT_MS = 6 * 3600_000;  // ignoramos ficheros más viejos de 6 h
const MAX_PER_SESSION = 40;
const CONCURRENCY = 16;
const MAX_META_BYTES = 64 * 1024;

const agentIdOf = (name) => {
  const match = /^agent-([A-Za-z0-9_-]{1,200})\.jsonl$/.exec(name);
  return match?.[1] || null;
};

class SubagentFile {
  constructor(agentId, file) {
    this.agentId = agentId; this.file = file;
    this.tel = new SessionTelemetry(agentId); // reutiliza dedupe, coste y totales
    this.pending = new Map();
    this.offset = 0; this.reading = false; this.gone = false;
    this.type = null; this.description = null; this.depth = null;
    this.startedAt = null; this.lastActivity = 0; this.lastStop = null; this.mtime = 0; this.lastText = '';
  }

  async loadMeta() {
    try {
      const file = this.file.replace(/\.jsonl$/, '.meta.json');
      const stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.size > MAX_META_BYTES) return;
      const m = JSON.parse(await fsp.readFile(file, 'utf8'));
      this.type = typeof m.agentType === 'string' ? m.agentType.slice(0, 80) : null;
      this.description = typeof m.description === 'string' ? m.description.slice(0, 500) : null;
      this.depth = Number.isInteger(m.spawnDepth) && m.spawnDepth >= 0 && m.spawnDepth <= 100 ? m.spawnDepth : null;
    } catch { /* sin metadatos */ }
  }

  async readNew() {
    if (this.reading || this.gone) return false;
    this.reading = true;
    try {
      const { changed, offset, mtimeMs } = await tailJsonl(this.file, this.offset, (o) => this.handle(o));
      this.offset = offset; this.mtime = mtimeMs;
      this.flush();
      return changed;
    } catch (e) {
      if (e.code === 'ENOENT') this.gone = true;
      return false;
    } finally { this.reading = false; }
  }

  handle(o) {
    const ts = o.timestamp ? Date.parse(o.timestamp) : null;
    if (ts) { this.startedAt ??= ts; this.lastActivity = Math.max(this.lastActivity, ts); }
    if (o.type === 'user') { this.flush(); return; }
    if (o.type !== 'assistant') return;
    const row = readAssistantRow(o);
    if (!row) return;
    if (!this.pending.has(row.requestId) && this.pending.size >= 1000) this.flush();
    let p = this.pending.get(row.requestId);
    if (!p) { p = { ts, usage: null, model: row.model, tools: [] }; this.pending.set(row.requestId, p); }
    p.ts = ts ?? p.ts;
    if (row.usage && (row.usage.output_tokens || 0) >= (p.usage?.output_tokens || 0)) p.usage = row.usage;
    p.tools.push(...row.tools);
    if (row.stopReason) this.lastStop = row.stopReason;
    if (row.text) this.lastText = row.text.slice(-300);
  }

  flush() {
    for (const [rid, p] of this.pending) {
      this.pending.delete(rid);
      if (!p.usage) continue;
      const u = p.usage;
      this.tel.addRequest({
        ts: p.ts || Date.now(), requestId: rid, model: p.model,
        input: u.input_tokens || 0, output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
        cacheCreation: u.cache_creation, durationMs: 0, ttftMs: null, costUsd: null, success: true, kind: 'subagent',
      }, 'transcript');
      for (const [key, name] of p.tools) this.tel.addTool({ ts: p.ts, key, name, success: true });
    }
  }

  status(now = Date.now()) {
    if (this.gone) return 'done';
    if (now - this.mtime < ACTIVE_MS) return 'working';
    if (this.lastStop === 'end_turn' || this.lastStop === 'stop_sequence') return 'done';
    return now - this.mtime < SETTLING_MS ? 'idle' : 'done';
  }

  toJSON() {
    const t = this.tel.totals;
    return {
      id: this.agentId, type: this.type, description: this.description, depth: this.depth,
      status: this.status(), startedAt: this.startedAt, lastActivity: this.lastActivity || this.mtime,
      tools: this.tel.tools.count, lastText: this.lastText,
      totals: { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, costUsd: +t.costUsd.toFixed(4), requests: t.requests },
    };
  }
}

export class SubagentWatcher {
  constructor(onEvent, { roots = () => [PROJECTS] } = {}) {
    this.onEvent = onEvent; this.roots = typeof roots === 'function' ? roots : () => roots;
    this.sessions = new Map(); this.timer = null; this.scanning = false;
  }

  /** Sesiones a vigilar (ids de sesión de Claude). */
  sync(sessionIds) {
    const want = new Set(sessionIds.filter(isSafeSessionId));
    if (this.sessions.size !== want.size) for (const sid of [...this.sessions.keys()]) if (!want.has(sid)) this.sessions.delete(sid);
    let added = false;
    for (const sid of want) if (!this.sessions.has(sid)) { this.sessions.set(sid, { dir: undefined, files: new Map(), skip: new Set(), dirty: true, initial: true }); added = true; }
    this.timer ??= setInterval(() => this.scan(), SCAN_MS);
    // Solo se barre al vuelo si hay sesiones nuevas; el resto va a la cadencia del temporizador,
    // que antes quedaba anulada porque el servidor llama a sync() cada segundo.
    if (added) this.scan();
  }

  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await mapLimit([...this.sessions.entries()], CONCURRENCY, ([sid, s]) => this.scanSession(sid, s));
    } finally { this.scanning = false; }
  }

  async scanSession(sid, s) {
    if (s.dir === undefined) s.dir = await findSessionDir(sid, this.roots());
    if (!s.dir) return;
    const base = path.join(s.dir, 'subagents');
    let names; try { names = (await fsp.readdir(base)).slice(0, 5000); } catch { return; }
    const now = Date.now();

    // Candidatos nuevos. Los descartados por antigüedad se memorizan: sin esto se volverían a
    // consultar en disco en cada barrido, para siempre.
    const fresh = names.filter((name) => {
      const id = agentIdOf(name);
      return id && !s.files.has(id) && !s.skip.has(name);
    });
    const cands = (await mapLimit(fresh.slice(0, 1000), CONCURRENCY, async (n) => {
      const file = path.join(base, n);
      try {
        const st = await fsp.lstat(file);
        if (!st.isFile()) return null;
        if (now - st.mtimeMs > RECENT_MS) { s.skip.add(n); return null; }
        return { id: agentIdOf(n), file, mtime: st.mtimeMs };
      } catch { return null; }
    })).filter(Boolean).sort((a, b) => b.mtime - a.mtime); // los más recientes primero
    if (s.skip.size > 10_000) s.skip = new Set([...s.skip].slice(-5_000));

    for (const c of cands) {
      if (s.files.size >= MAX_PER_SESSION) {
        const oldest = [...s.files.values()].filter((x) => x.status(now) === 'done').sort((a, b) => (a.lastActivity || a.mtime) - (b.lastActivity || b.mtime))[0];
        if (!oldest) break;
        s.files.delete(oldest.agentId);
      }
      const f = new SubagentFile(c.id, c.file);
      await f.loadMeta();
      s.files.set(c.id, f);
      s.dirty = true;
      if (!s.initial) this.onEvent?.({ kind: 'subagent_start', sessionId: sid, agentId: c.id, agentType: f.type, description: f.description, ts: now });
    }

    const changed = await mapLimit(s.files.values(), CONCURRENCY, (f) => f.readNew());
    if (changed.some(Boolean)) s.dirty = true;

    // Las transiciones se miden contra el barrido anterior: dentro de uno solo, releer el fichero ya
    // ha adelantado su fecha y «trabajando» nunca llegaría a «terminado».
    for (const f of s.files.values()) {
      const cur = f.status(now), prev = f.lastStatus;
      if (prev === cur) continue;
      f.lastStatus = cur; s.dirty = true;
      if (prev === 'working' && !s.initial) {
        this.onEvent?.({ kind: 'subagent_done', sessionId: sid, agentId: f.agentId, agentType: f.type, description: f.description, ts: now, output: f.tel.totals.output });
      }
    }
    s.initial = false;
  }

  /** Subagentes de una sesión, el más reciente primero. */
  list(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    return [...s.files.values()].map((f) => f.toJSON()).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  }
  takeDirty(sessionId) { const s = this.sessions.get(sessionId); if (!s?.dirty) return false; s.dirty = false; return true; }
  close() { clearInterval(this.timer); this.timer = null; this.sessions.clear(); }
}
