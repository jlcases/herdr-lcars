// Respaldo para sesiones de Claude Code arrancadas sin OpenTelemetry: sigue el transcript JSONL.
// Da tokens, coste estimado, modelo, turnos y herramientas, pero no TTFT (queda a null; nunca se
// finge un cero). En cuanto la sesión empieza a exportar OTLP, este seguidor se calla.
import { PROJECTS, findSessionFile, readAssistantRow, isUserPrompt } from './claude.mjs';
import { tailJsonl } from './jsonl.mjs';
import { mapLimit } from './concurrency.mjs';
import { isSafeSessionId } from './identifiers.mjs';

const POLL_MS = 1500;

class Follower {
  constructor(sessionId, file, store, onEvent) {
    this.sessionId = sessionId; this.file = file; this.store = store; this.onEvent = onEvent;
    this.offset = 0; this.reading = false; this.initial = true;
    this.lastUserTs = null;
    this.pending = new Map(); // requestId -> {first, last, usage, model, tools, userTs, sidechain, stopReason}
  }

  async readNew() {
    if (this.reading) return false;
    this.reading = true;
    try {
      const { changed, offset } = await tailJsonl(this.file, this.offset, (o) => this.handle(o));
      this.offset = offset;
      this.flush();
      this.initial = false;
      return changed;
    } catch (e) {
      if (e.code !== 'ENOENT') this.onEvent?.({ kind: 'warn', message: `transcript ${this.sessionId}: ${e.message}` });
      return false;
    } finally { this.reading = false; }
  }

  handle(o) {
    const s = this.store.get(this.sessionId);
    if (!s.accepts('transcript')) return; // la sesión ya exporta OTLP: esto solo duplicaría
    const ts = o.timestamp ? Date.parse(o.timestamp) : null;

    if (o.type === 'user') {
      // La llegada de un `user` (orden o resultado de herramienta) cierra el turno de API anterior.
      this.flush();
      this.lastUserTs = ts;
      if (isUserPrompt(o) && s.addTurn(o.uuid) && !this.initial) this.onEvent?.({ kind: 'prompt', sessionId: this.sessionId, ts });
      return;
    }
    if (o.type === 'assistant') {
      const row = readAssistantRow(o);
      if (!row) return;
      if (!this.pending.has(row.requestId) && this.pending.size >= 1000) this.flush();
      let p = this.pending.get(row.requestId);
      if (!p) { p = { first: ts, last: ts, usage: null, model: row.model, tools: [], userTs: this.lastUserTs, sidechain: row.sidechain }; this.pending.set(row.requestId, p); }
      p.last = ts ?? p.last;
      if (row.usage && (row.usage.output_tokens || 0) >= (p.usage?.output_tokens || 0)) p.usage = row.usage;
      p.tools.push(...row.tools);
      if (row.stopReason) p.stopReason = row.stopReason;
      return;
    }
    if (o.type === 'system' && o.subtype === 'turn_duration' && !this.initial) {
      this.onEvent?.({ kind: 'turn_done', sessionId: this.sessionId, ts, durationMs: +o.durationMs || 0 });
    }
  }

  flush() {
    const s = this.store.get(this.sessionId);
    if (!s.accepts('transcript')) { this.pending.clear(); return; }
    for (const [rid, p] of this.pending) {
      this.pending.delete(rid);
      if (!p.usage) continue;
      const u = p.usage;
      s.addRequest({
        ts: p.last || Date.now(), requestId: rid, model: p.model,
        input: u.input_tokens || 0, output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
        cacheCreation: u.cache_creation,
        // Sin marca de TTFT: lo que se mide aquí es el turno completo, de orden a respuesta.
        durationMs: p.userTs && p.last ? Math.max(0, p.last - p.userTs) : 0, ttftMs: null, costUsd: null,
        stopReason: p.stopReason || null, success: true, kind: p.sidechain ? 'subagent' : 'main',
      }, 'transcript');
      for (const [key, name] of p.tools) s.addTool({ ts: p.last, key, name, success: true });
    }
  }
}

export class TranscriptWatcher {
  constructor(store, onEvent, { roots = () => [PROJECTS] } = {}) {
    this.store = store; this.onEvent = onEvent;
    this.roots = typeof roots === 'function' ? roots : () => roots;
    this.followers = new Map();
    this.missing = new Map();  // sessionId -> {tries, next}: reintentos con espera creciente
    this.resolving = new Set();
    this.timer = null;
  }

  /** Sesiones a seguir (las que aún no tienen una fuente mejor). */
  sync(sessionIds) {
    const want = new Set(sessionIds.filter(isSafeSessionId));
    for (const sid of [...this.followers.keys()]) if (!want.has(sid)) this.followers.delete(sid);
    for (const sid of [...this.missing.keys()]) if (!want.has(sid)) this.missing.delete(sid);

    const now = Date.now();
    for (const sid of want) {
      if (this.followers.has(sid) || this.resolving.has(sid)) continue;
      const miss = this.missing.get(sid);
      if (miss && now < miss.next) continue; // localizar cuesta recorrer todos los proyectos
      this.resolving.add(sid);
      findSessionFile(sid, this.roots()).then((file) => {
        if (file) { this.missing.delete(sid); this.followers.set(sid, new Follower(sid, file, this.store, this.onEvent)); }
        else { const m = this.missing.get(sid) || { tries: 0 }; m.tries++; m.next = now + Math.min(60_000, 2000 * m.tries); this.missing.set(sid, m); }
      }).catch(() => {}).finally(() => this.resolving.delete(sid));
    }
    this.timer ??= setInterval(() => this.poll(), POLL_MS);
  }

  /** Un solo temporizador para todos los seguidores, con la E/S agrupada. */
  poll() { return mapLimit(this.followers.values(), 16, (f) => f.readNew()); }

  close() { clearInterval(this.timer); this.timer = null; this.followers.clear(); }
}
