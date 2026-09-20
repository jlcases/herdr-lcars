// Codex CLI: sigue los rollouts JSONL de `~/.codex/sessions/AAAA/MM/DD/rollout-<fecha>-<sesión>.jsonl`.
// Es la fuente más completa después de OTLP: trae tokens por respuesta (con el razonamiento aparte),
// modelo y esfuerzo, y duración y TTFT reales por turno, además de contexto usado y cuota del plan.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tailJsonl, firstLine } from '../jsonl.mjs';
import { mapLimit } from '../concurrency.mjs';
import { isSafeSessionId } from '../identifiers.mjs';
import { pathKey } from '../paths.mjs';

const DEFAULT_ROOT = process.env.LCARS_CODEX_SESSIONS || path.join(os.homedir(), '.codex', 'sessions');
const POLL_MS = 1500;
const FRESH_MS = 6 * 3600_000;
const CWD_INDEX_TTL_MS = 3_000;
const u = (x) => x || 0;
let cwdIndexPromise = null, cwdIndexAt = 0, cwdIndexKey = '';

const normalizedRoots = (roots) => [...new Set((Array.isArray(roots) ? roots : [roots])
  .filter((root) => typeof root === 'string' && root && path.isAbsolute(root)).map((root) => path.resolve(root)))].slice(0, 32);

// Codex nombra los directorios con la fecha LOCAL, no UTC: usarla evita quedarse ciego varias horas al día.
const localDayDir = (root, offsetDays = 0) => {
  const d = new Date(Date.now() - offsetDays * 86400000);
  return path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
};

const findIn = async (dir, sessionId) => {
  if (!isSafeSessionId(sessionId)) return null;
  let names; try { names = await fsp.readdir(dir); } catch { return null; }
  const hit = names.find((n) => n.endsWith(`${sessionId}.jsonl`));
  if (!hit) return null;
  const file = path.join(dir, hit);
  try { return (await fsp.lstat(file)).isFile() ? file : null; } catch { return null; }
};

/** Rollout de una sesión. Casi siempre está en los últimos días; el árbol completo es el último recurso. */
async function locate(sessionId, roots) {
  if (!isSafeSessionId(sessionId)) return null;
  for (const root of normalizedRoots(roots)) {
    for (const dir of [localDayDir(root, 0), localDayDir(root, 1), localDayDir(root, 2)]) {
      const hit = await findIn(dir, sessionId);
      if (hit) return hit;
    }
    let years; try { years = (await fsp.readdir(root)).filter((name) => /^\d{4}$/.test(name)).slice(-20); } catch { continue; }
    for (const y of years) {
      let months; try { months = (await fsp.readdir(path.join(root, y))).filter((name) => /^(?:0[1-9]|1[0-2])$/.test(name)); } catch { continue; }
      for (const m of months) {
        let days; try { days = (await fsp.readdir(path.join(root, y, m))).filter((name) => /^(?:0[1-9]|[12]\d|3[01])$/.test(name)); } catch { continue; }
        const hits = await mapLimit(days, 16, (d) => findIn(path.join(root, y, m, d), sessionId));
        const hit = hits.find(Boolean);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/** Índice compartido de rollouts recientes; 200 panes no vuelven a leer las mismas cabeceras. */
async function recentByCwd(roots) {
  const safeRoots = normalizedRoots(roots), key = safeRoots.join('\0');
  if (cwdIndexPromise && key === cwdIndexKey && Date.now() - cwdIndexAt < CWD_INDEX_TTL_MS) return cwdIndexPromise;
  cwdIndexAt = Date.now();
  cwdIndexKey = key;
  cwdIndexPromise = (async () => {
  const cands = [];
  for (const root of safeRoots) {
    for (const dir of [localDayDir(root, 0), localDayDir(root, 1)]) {
      let names; try { names = (await fsp.readdir(dir)).filter((name) => name.endsWith('.jsonl')).slice(0, 5000); } catch { continue; }
      const stats = await mapLimit(names, 16, async (n) => {
        const f = path.join(dir, n);
        try { const st = await fsp.lstat(f); return st.isFile() && Date.now() - st.mtimeMs < FRESH_MS ? [st.mtimeMs, f] : null; } catch { return null; }
      });
      cands.push(...stats.filter(Boolean));
    }
  }
  cands.sort((a, b) => b[0] - a[0]);
    const metas = await mapLimit(cands.slice(0, 1000), 16, async ([mtime, file]) => {
    // La primera línea (session_meta) lleva las instrucciones base y puede ocupar decenas de KB.
    try {
        const o = JSON.parse(await firstLine(file));
        const sessionId = o.payload?.session_id || o.payload?.id;
        return o.type === 'session_meta' && typeof o.payload?.cwd === 'string' && isSafeSessionId(sessionId)
          ? { mtime, file, cwd: o.payload.cwd, sessionId } : null;
      } catch { return null; }
    });
    const index = new Map();
    for (const meta of metas.filter(Boolean)) if (!index.has(pathKey(meta.cwd))) index.set(pathKey(meta.cwd), meta);
    return index;
  })().catch((error) => { cwdIndexPromise = null; throw error; });
  return cwdIndexPromise;
}

/** Rollout reciente cuyo cwd coincide, para panes cuyo id de sesión Herdr no reporta. */
async function locateByCwd(cwd, roots) {
  if (typeof cwd !== 'string' || !cwd || cwd.length > 4096) return null;
  return (await recentByCwd(roots)).get(pathKey(cwd)) || null;
}

class Follower {
  constructor(sessionId, file, store, onEvent) {
    this.sessionId = sessionId; this.file = file; this.store = store; this.onEvent = onEvent;
    this.offset = 0; this.reading = false; this.initial = true;
    this.model = null; this.turns = new Map();
  }

  async readNew() {
    if (this.reading) return false;
    this.reading = true;
    try {
      const { changed, offset } = await tailJsonl(this.file, this.offset, (o) => this.handle(o));
      this.offset = offset; this.initial = false;
      return changed;
    } catch (e) {
      if (e.code !== 'ENOENT') this.onEvent?.({ kind: 'warn', message: `codex ${this.sessionId}: ${e.message}` });
      return false;
    } finally { this.reading = false; }
  }

  handle(o) {
    const ts = o.timestamp ? Date.parse(o.timestamp) : Date.now();
    const p = o.payload || {};
    const s = this.store.get(this.sessionId);

    if (o.type === 'turn_context') {
      if (p.model) { this.model = typeof p.model === 'string' ? p.model.slice(0, 200) : null; }
      const eff = p.collaboration_mode?.settings?.reasoning_effort;
      s.setIdentity({ model: this.model, effort: eff });
      return;
    }
    if (o.type === 'token_usage_record') {
      const us = p.usage || {}, rid = p.response_id || `${p.turn_id}:${o.ordinal}`;
      const ok = s.addRequest({
        ts, requestId: rid, model: this.model,
        input: Math.max(0, u(us.input_tokens) - u(us.cached_input_tokens)), output: u(us.output_tokens),
        cacheRead: u(us.cached_input_tokens), cacheWrite: u(us.cache_write_input_tokens),
        reasoning: u(us.reasoning_output_tokens), durationMs: 0, ttftMs: null, costUsd: null,
        success: true, kind: 'main', turnId: p.turn_id || null,
      }, 'codex');
      if (ok && p.turn_id) {
        const t = this.turns.get(p.turn_id) || { requestIds: [] };
        if (t.requestIds.length < 100) t.requestIds.push(rid);
        this.turns.set(p.turn_id, t);
      }
      return;
    }
    if (o.type !== 'event_msg') return;

    if (p.type === 'task_started') {
      if (!this.turns.has(p.turn_id) && this.turns.size >= 1000) this.turns.delete(this.turns.keys().next().value);
      this.turns.set(p.turn_id, { requestIds: [] });
      s.addTurn(p.turn_id);
      if (!this.initial) this.onEvent?.({ kind: 'prompt', sessionId: this.sessionId, ts });
    } else if (p.type === 'task_complete') {
      this.closeTurn(s, p, ts);
    } else if (p.type === 'token_count') {
      const info = p.info || {}, last = info.last_token_usage || {};
      if (info.model_context_window) {
        s.setContext({
          usedPercent: Math.min(100, 100 * u(last.input_tokens) / info.model_context_window),
          size: info.model_context_window,
          current: { input_tokens: u(last.input_tokens), output_tokens: u(last.output_tokens), cache_read_input_tokens: u(last.cached_input_tokens) },
        });
      }
      if (p.rate_limits) {
        const win = (w) => w && { used_percentage: w.used_percent, resets_at: w.resets_at, window_minutes: w.window_minutes };
        s.setRateLimits({ source: 'codex', plan: p.rate_limits.plan_type, primary: win(p.rate_limits.primary), secondary: win(p.rate_limits.secondary) }, ts);
      }
    } else if (p.type === 'item_completed') {
      const it = p.item || {}, kind = it.type || '';
      if (/tool|command|patch|search|mcp/i.test(kind)) {
        s.addTool({ ts, key: it.id || `${p.turn_id}:${o.ordinal}`, name: kind.replace(/Call$|Item$/, ''), success: it.status !== 'failed' });
      }
    }
  }

  /** Funde las respuestas del turno en un registro con la duración y el TTFT que Codex sí mide. */
  closeTurn(s, p, ts) {
    const t = this.turns.get(p.turn_id);
    this.turns.delete(p.turn_id);
    if (t?.requestIds.length) {
      const recs = s.requests.filter((r) => t.requestIds.includes(r.requestId));
      if (recs.length) {
        const sum = (k) => recs.reduce((n, r) => n + (r[k] || 0), 0);
        for (const r of recs) { s._apply(r, -1); s.requests.splice(s.requests.indexOf(r), 1); }
        s.addRequest({
          ts, requestId: `turn:${p.turn_id}`, model: this.model,
          input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'),
          reasoning: sum('reasoning'), durationMs: u(p.duration_ms), ttftMs: u(p.time_to_first_token_ms) || null,
          costUsd: null, stopReason: p.error ? 'error' : 'end_turn', success: !p.error, kind: 'main',
        }, 'codex');
      }
    }
    if (this.initial) return;
    if (p.error) this.onEvent?.({ kind: 'api_error', sessionId: this.sessionId, ts, error: p.error.codex_error_info || p.error.message, model: this.model });
    else this.onEvent?.({ kind: 'turn_done', sessionId: this.sessionId, ts, durationMs: u(p.duration_ms) });
  }
}

export class CodexAdapter {
  static kind = 'codex';
  constructor(store, onEvent, { roots = () => [DEFAULT_ROOT] } = {}) {
    this.store = store; this.onEvent = onEvent;
    this.roots = typeof roots === 'function' ? roots : () => roots;
    this.followers = new Map();
    this.byPane = new Map();
    this.missing = new Map();   // paneId -> {tries, next}: sin esto se rastrearía el disco cada segundo
    this.missingSessions = new Map(); // sessionId -> backoff de la búsqueda del rollout
    this.resolving = new Set();
    this.timer = null;
  }

  /** agents: [{paneId, sessionId|null, cwd}]. Devuelve paneId → sessionId resuelto. */
  async sync(agents) {
    const roots = normalizedRoots(this.roots());
    const live = new Set(agents.map((a) => a.paneId));
    for (const m of [this.byPane, this.missing]) for (const pane of [...m.keys()]) if (!live.has(pane)) m.delete(pane);

    const want = new Map();
    const now = Date.now();
    for (const a of agents) {
      const candidate = a.sessionId || this.byPane.get(a.paneId);
      const sid = isSafeSessionId(candidate) ? candidate : null;
      if (sid) { want.set(a.paneId, sid); continue; }
      const miss = this.missing.get(a.paneId);
      if (this.resolving.has(a.paneId) || (miss && now < miss.next)) continue;
      this.resolving.add(a.paneId);
      locateByCwd(a.cwd, roots).then((hit) => {
        if (hit) { this.byPane.set(a.paneId, hit.sessionId); this.missing.delete(a.paneId); }
        else { const m = this.missing.get(a.paneId) || { tries: 0 }; m.tries++; m.next = now + Math.min(60_000, 2000 * m.tries); this.missing.set(a.paneId, m); }
      }).catch(() => {}).finally(() => this.resolving.delete(a.paneId));
    }

    const wantSids = new Set(want.values());
    for (const [sid, f] of this.followers) if (!wantSids.has(sid)) { f?.close?.(); this.followers.delete(sid); }
    for (const sid of [...this.missingSessions.keys()]) if (!wantSids.has(sid)) this.missingSessions.delete(sid);
    for (const sid of wantSids) {
      if (this.followers.has(sid)) continue;
      const miss = this.missingSessions.get(sid);
      if (miss && now < miss.next) continue;
      this.followers.set(sid, null); // reserva el hueco mientras se localiza el fichero
      locate(sid, roots).then((file) => {
        if (file) { this.missingSessions.delete(sid); this.followers.set(sid, new Follower(sid, file, this.store, this.onEvent)); }
        else {
          this.followers.delete(sid);
          const state = this.missingSessions.get(sid) || { tries: 0 };
          state.tries++; state.next = Date.now() + Math.min(60_000, 2_000 * state.tries);
          this.missingSessions.set(sid, state);
        }
      }).catch(() => {
        this.followers.delete(sid);
        const state = this.missingSessions.get(sid) || { tries: 0 };
        state.tries++; state.next = Date.now() + Math.min(60_000, 2_000 * state.tries);
        this.missingSessions.set(sid, state);
      });
    }
    this.timer ??= setInterval(() => this.poll(), POLL_MS);
    return want;
  }

  poll() { return mapLimit([...this.followers.values()].filter(Boolean), 16, (f) => f.readNew()); }
  close() { clearInterval(this.timer); this.timer = null; this.followers.clear(); this.missingSessions.clear(); }
}
