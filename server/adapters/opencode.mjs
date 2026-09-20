// OpenCode: lee su base SQLite con el binario `sqlite3` del sistema, sin dependencias. Cada mensaje del
// asistente trae coste real, tokens (con caché y razonamiento), modelo, proveedor y tiempos, así que es
// la única fuente que aporta coste medido en vez de estimado por tarifa.
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isSafeSessionId } from '../identifiers.mjs';

const DB = process.env.OPENCODE_DB || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db');
const POLL_MS = 3000;

function query(sql) {
  return new Promise((resolve, reject) => {
    execFile('sqlite3', ['-json', '-readonly', DB, sql], { maxBuffer: 32 * 1024 * 1024, timeout: 8000 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(stdout.trim() ? JSON.parse(stdout) : []); } catch (e) { reject(e); }
    });
  });
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const list = (xs) => xs.map(q).join(',') || "''";

export class OpenCodeAdapter {
  static kind = 'opencode';
  constructor(store, onEvent) {
    this.store = store; this.onEvent = onEvent;
    this.sessions = new Map();  // sessionId -> {since, initial}
    this.byPane = new Map();
    this.missing = new Map();
    this.ready = null;          // ¿hay base y binario sqlite3?
    this.busy = false;
    this.timer = null;
  }

  async available() {
    if (this.ready !== null) return this.ready;
    try { await fsp.access(DB); await query('select 1'); this.ready = true; }
    catch (e) { this.ready = false; this.onEvent?.({ kind: 'warn', message: `opencode desactivado: ${e.message}` }); }
    return this.ready;
  }

  async sync(agents) {
    if (!(await this.available())) return new Map();
    const live = new Set(agents.map((a) => a.paneId));
    for (const m of [this.byPane, this.missing]) for (const pane of [...m.keys()]) if (!live.has(pane)) m.delete(pane);

    // Resolución por directorio de trabajo para los panes sin id de sesión, en una sola consulta.
    const now = Date.now();
    const unresolved = agents.filter((a) => !a.sessionId && typeof a.cwd === 'string' && a.cwd.length <= 4096
      && !this.byPane.has(a.paneId) && !(this.missing.get(a.paneId)?.next > now)).slice(0, 1000);
    if (unresolved.length) {
      try {
        const rows = await query(`select id, directory from session where directory in (${list(unresolved.map((a) => a.cwd))}) and parent_id is null and time_updated > ${now - 12 * 3600_000} order by time_updated desc`);
        const byDir = new Map();
        for (const r of rows) if (!byDir.has(r.directory)) byDir.set(r.directory, r.id);
        for (const a of unresolved) {
          const sid = byDir.get(a.cwd);
          if (isSafeSessionId(sid)) { this.byPane.set(a.paneId, sid); this.missing.delete(a.paneId); }
          else { const m = this.missing.get(a.paneId) || { tries: 0 }; m.tries++; m.next = now + Math.min(60_000, 3000 * m.tries); this.missing.set(a.paneId, m); }
        }
      } catch (e) { this.onEvent?.({ kind: 'warn', message: `opencode: ${e.message}` }); }
    }

    const want = new Map();
    for (const a of agents) {
      const sid = a.sessionId || this.byPane.get(a.paneId);
      if (isSafeSessionId(sid)) want.set(a.paneId, sid);
    }
    const wantSids = new Set(want.values());
    for (const sid of [...this.sessions.keys()]) if (!wantSids.has(sid)) this.sessions.delete(sid);
    let added = false;
    for (const sid of wantSids) if (!this.sessions.has(sid)) { this.sessions.set(sid, { since: 0, cursor: '', initial: true }); added = true; }
    this.timer ??= setInterval(() => this.poll(), POLL_MS);
    if (added) this.poll(); // solo al aparecer una sesión: el resto va a la cadencia del temporizador
    return want;
  }

  /** Una sola consulta para todas las sesiones: antes era un proceso `sqlite3` por sesión y segundo. */
  async poll() {
    if (this.busy || !this.sessions.size) return;
    this.busy = true;
    try {
      const ids = [...this.sessions.keys()];
      const predicates = ids.map((id) => {
        const state = this.sessions.get(id);
        return `(coalesce(s.parent_id,s.id)=${q(id)} and (m.time_updated > ${state.since} or (m.time_updated = ${state.since} and m.id > ${q(state.cursor)})))`;
      }).join(' or ');
      const rows = await query(`select m.id, m.session_id, m.time_created, m.time_updated, m.data, s.parent_id, coalesce(s.parent_id, s.id) root
        from message m join session s on s.id = m.session_id
        where ${predicates}
        order by m.time_updated asc, m.id asc limit 2000`);
      const toolMessages = [];
      for (const r of rows) {
        const st = this.sessions.get(r.root);
        if (!st) continue;
        const updated = Number(r.time_updated), rowId = String(r.id ?? '');
        if (!Number.isFinite(updated) || updated < 0 || !rowId) continue;
        if (updated > st.since) { st.since = updated; st.cursor = rowId; }
        else if (updated === st.since && rowId > st.cursor) st.cursor = rowId;
        let d; try { d = JSON.parse(r.data); } catch { continue; }
        const s = this.store.get(r.root);
        if (d.role === 'user') {
          if (!r.parent_id && s.addTurn(r.id) && !st.initial) this.onEvent?.({ kind: 'prompt', sessionId: r.root, ts: r.time_created });
          continue;
        }
        if (d.role !== 'assistant' || !d.time?.completed) continue; // aún generando
        const t = d.tokens || {}, dur = (d.time.completed || 0) - (d.time.created || 0);
        s.addRequest({
          ts: d.time.completed, requestId: r.id, model: d.modelID || null,
          input: t.input || 0, output: t.output || 0, reasoning: t.reasoning || 0,
          cacheRead: t.cache?.read || 0, cacheWrite: t.cache?.write || 0,
          durationMs: dur > 0 ? dur : 0, ttftMs: null,
          costUsd: typeof d.cost === 'number' ? d.cost : null,
          stopReason: d.finish || null, success: !d.error,
          kind: r.parent_id ? 'subagent' : 'main', agentName: r.parent_id ? (d.agent || 'subagent') : null,
        }, 'opencode');
        if (typeof r.id === 'string' && r.id.length <= 256) toolMessages.push(r.id);
        if (d.error && !st.initial) this.onEvent?.({ kind: 'api_error', sessionId: r.root, ts: d.time.completed, error: d.error?.name || d.error?.data?.message || 'error', model: d.modelID });
      }
      if (toolMessages.length) await this.readTools(toolMessages, rows);
      for (const st of this.sessions.values()) st.initial = false;
    } catch (e) { this.onEvent?.({ kind: 'warn', message: `opencode: ${e.message}` }); }
    finally { this.busy = false; }
  }

  /** Herramientas de esos mensajes. La clave es el id de la parte: un mensaje en curso se relee. */
  async readTools(messageIds, rows) {
    const rootOf = new Map(rows.map((r) => [r.id, r.root]));
    try {
      const tools = await query(`select id, message_id, json_extract(data,'$.tool') tool, json_extract(data,'$.state.status') status
        from part where json_extract(data,'$.type')='tool' and message_id in (${list(messageIds)})`);
      for (const tr of tools) {
        if (tr.status !== 'completed' && tr.status !== 'error') continue;
        const root = rootOf.get(tr.message_id);
        if (root) this.store.get(root).addTool({ ts: Date.now(), key: tr.id, name: tr.tool, success: tr.status !== 'error' });
      }
    } catch { /* esquema distinto: sin herramientas */ }
  }

  close() { clearInterval(this.timer); this.timer = null; this.sessions.clear(); }
}
