// Cadencia de la capa mecánica. La memoria se escribe sola mientras los motores trabajan.
//
// Separado del caso de uso a propósito: `IngestActivity` sabe QUÉ observar y esto sabe CUÁNDO.
// Sin esta separación, el ritmo acabaría dentro del dominio o dentro del servidor HTTP.
import { mapLimit } from '../concurrency.mjs';

export class ActivityScheduler {
  /**
   * @param {{ingest: {run: Function}, clock: {now: () => number}, everyMs?: number, log?: object}} deps
   */
  constructor({ ingest, clock, everyMs = 30_000, concurrency = 6, log = null }) {
    this.ingest = ingest;
    this.clock = clock;
    this.everyMs = everyMs;
    this.concurrency = Math.max(1, Math.min(32, Number(concurrency) || 6));
    this.log = log;
    this.lastRun = new Map();  // cwd -> marca de tiempo
    this.inFlight = new Set(); // cwd que ya se está observando
    this.contextByCwd = new Map();
    this.lastError = new Map(); // cwd -> firma; evita repetir el mismo aviso en cada sondeo
  }

  /** Un motor por directorio: observar dos veces el mismo árbol daría los mismos ficheros. */
  static #pick(agents) {
    const byCwd = new Map();
    for (const a of agents) {
      if (!a?.cwd) continue;
      // Gana el que está trabajando: es el que está cambiando el árbol ahora mismo.
      const prev = byCwd.get(a.cwd);
      if (!prev || (a.status === 'working' && prev.status !== 'working')) byCwd.set(a.cwd, a);
    }
    return [...byCwd.values()];
  }

  /**
   * Observa los contextos que toque. Nunca lanza: la memoria es un extra, no puede tumbar el panel.
   * @returns {Promise<number>} cuántos contextos se observaron en esta pasada
   */
  async sync(agents) {
    const now = this.clock.now();
    const seen = new Set();
    const due = ActivityScheduler.#pick(agents).filter((a) => {
      const key = this.contextByCwd.get(a.cwd) ?? a.cwd;
      if (seen.has(key) || this.inFlight.has(key) || now - (this.lastRun.get(key) ?? 0) < this.everyMs) return false;
      seen.add(key); return true;
    });

    await mapLimit(due, this.concurrency, async (a) => {
      const key = this.contextByCwd.get(a.cwd) ?? a.cwd;
      this.inFlight.add(key); this.lastRun.set(key, now);
      try {
        const result = await this.ingest.run({ cwd: a.cwd, engineKind: a.agent, sessionId: a.sessionId ?? null, paneId: a.paneId });
        if (result?.contextId && result.contextId !== key) {
          this.contextByCwd.set(a.cwd, result.contextId);
          this.lastRun.set(result.contextId, now);
        }
        this.lastError.delete(a.cwd);
      } catch (e) {
        const signature = `${e?.code ?? 'ERROR'}:${e?.message ?? 'error desconocido'}`;
        if (this.lastError.get(a.cwd) !== signature) {
          this.log?.warn?.(`memoria de contexto (${a.cwd}): ${e?.message ?? 'error desconocido'}`);
          this.lastError.set(a.cwd, signature);
        }
      } finally { this.inFlight.delete(key); }
    });
    return due.length;
  }

  /** Olvida los directorios que ya no tiene ningún agente, para no crecer sin fin. */
  prune(agents) {
    const live = new Set(agents.map((a) => a?.cwd).filter(Boolean));
    for (const cwd of [...this.contextByCwd.keys()]) if (!live.has(cwd)) this.contextByCwd.delete(cwd);
    for (const cwd of [...this.lastError.keys()]) if (!live.has(cwd)) this.lastError.delete(cwd);
    const liveKeys = new Set([...live].map((cwd) => this.contextByCwd.get(cwd) ?? cwd));
    for (const key of [...this.lastRun.keys()]) if (!liveKeys.has(key)) this.lastRun.delete(key);
  }
}
