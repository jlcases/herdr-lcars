// Herdr como ejecutor de agentes. Encapsula las dos carreras medidas al arrancar un motor.
import * as herdr from '../../herdr.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export class HerdrAgentRuntime {
  constructor({ socketPath = undefined, attempts = { shell: 12, ready: 40 }, delayMs = 500 } = {}) {
    this.opts = { socketPath };
    const clamp = (value, fallback, max) => Math.max(1, Math.min(max, Math.trunc(Number(value)) || fallback));
    this.attempts = { shell: clamp(attempts?.shell, 12, 100), ready: clamp(attempts?.ready, 40, 200) };
    this.delayMs = Math.max(50, Math.min(5_000, Math.trunc(Number(delayMs)) || 500));
  }

  async splitPane(paneId, { cwd, direction = 'right', env = {} }) {
    const split = await herdr.paneSplit(paneId, { cwd, direction, env }, this.opts);
    return split?.pane?.pane_id ?? null;
  }

  closePane(paneId) { return herdr.paneClose(paneId, this.opts); }

  /**
   * Un panel recién abierto tarda un instante en llegar a su prompt, y Herdr exige una shell libre.
   * Solo se reintenta ese error concreto; cualquier otro sale enseguida.
   */
  async startAgent(name, kind, paneId) {
    let last;
    for (let i = 0; i < this.attempts.shell; i++) {
      try { return await herdr.agentStart(name, kind, paneId, [], this.opts); }
      catch (e) {
        last = e;
        if (!/not an available shell|no such pane/i.test(e.message)) throw e;
        await wait(this.delayMs);
      }
    }
    throw last;
  }

  /**
   * Que el nombre resuelva no basta: `agent.prompt` exige además que el agente esté activo, y hay
   * un hueco entre ambas cosas por el que se perdía la entrega.
   */
  async waitReady(name) {
    let last = 'sin respuesta';
    for (let i = 0; i < this.attempts.ready; i++) {
      try {
        const a = (await herdr.agentGet(name, this.opts))?.agent;
        if (a?.interactive_ready || ['idle', 'done'].includes(a?.agent_status)) return a;
        if (a?.agent_status === 'blocked') throw Object.assign(new Error('el motor nuevo arrancó pidiendo confirmación; atiéndelo en su panel'), { fatal: true });
        last = `estado ${a?.agent_status}`;
      } catch (e) {
        if (e.fatal) throw e;
        last = e.message;
      }
      await wait(this.delayMs);
    }
    throw new Error(`el motor nuevo no quedó listo (${last})`);
  }

  prompt(name, text) { return herdr.agentPrompt(name, text, {}, this.opts); }

  async readPane(paneId, lines) {
    const out = await herdr.readPane(paneId, lines, this.opts);
    return out?.read?.text ?? out?.text ?? '';
  }
}
