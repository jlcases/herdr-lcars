// Cliente del socket UNIX de Herdr (protocolo JSON por líneas).
// Una conexión de petición/respuesta por llamada; el snapshot completo cuesta ~10 ms,
// así que la fuente de verdad es un sondeo periódico + suscripciones por pane para inmediatez.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export const DEFAULT_SOCKET = path.join(os.homedir(), '.config', 'herdr', 'herdr.sock');

let seq = 0;
const nextId = () => `lcars:${Date.now()}:${++seq}`;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES = 1024 * 1024;

/** Envía una petición y devuelve el primer mensaje de respuesta. */
export function request(method, params = {}, { socketPath = DEFAULT_SOCKET, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const sock = net.createConnection(socketPath);
    // Decodificador por streaming: un carácter multibyte partido entre dos segmentos TCP
    // se corrompería si convirtiéramos cada trozo por separado (los títulos llevan acentos).
    const decoder = new StringDecoder('utf8');
    let buf = '', received = 0, settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); fn(value);
    };
    const timer = setTimeout(() => { sock.destroy(); finish(reject, new Error(`herdr timeout: ${method}`)); }, timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ id, method, params }) + '\n'));
    sock.on('data', (chunk) => {
      received += chunk.length;
      buf += decoder.write(chunk);
      if (received > MAX_RESPONSE_BYTES) {
        sock.destroy();
        finish(reject, Object.assign(new Error(`respuesta de herdr demasiado grande: ${method}`), { code: 'HERDR_RESPONSE_TOO_LARGE' }));
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      sock.end();
      try {
        const msg = JSON.parse(buf.slice(0, nl));
        if (msg.error) finish(reject, Object.assign(new Error(msg.error.message || 'herdr error'), { code: msg.error.code }));
        else finish(resolve, msg.result);
      } catch (e) { finish(reject, e); }
    });
    sock.on('error', (e) => finish(reject, e));
    sock.on('close', () => { if (!settled) finish(reject, new Error(`herdr cerro la conexion sin respuesta: ${method}`)); });
  });
}

export const snapshot = (opts) => request('session.snapshot', {}, opts).then((r) => r.snapshot);
export const focusPane = (paneId, opts) => request('pane.focus', { pane_id: paneId }, opts);
export const worktreeList = (cwd, opts) => request('worktree.list', { cwd }, opts);
export const paneSplit = (targetPaneId, { cwd, direction = 'right', env = {} } = {}, opts) =>
  request('pane.split', { target_pane_id: targetPaneId, direction, cwd, env, focus: false }, opts);
export const paneClose = (paneId, opts) => request('pane.close', { pane_id: paneId }, opts);
export const agentStart = (name, kind, paneId, args = [], opts) =>
  request('agent.start', { name, kind, pane_id: paneId, args, timeout_ms: 60000 }, { timeoutMs: 70000, ...opts });
export const agentPrompt = (target, text, { timeoutMs = 180000 } = {}, opts) =>
  request('agent.prompt', { target, text, wait: { timeout_ms: timeoutMs } }, { timeoutMs: timeoutMs + 10000, ...opts });
export const agentGet = (target, opts) => request('agent.get', { target }, opts);

export const readPane = (paneId, lines = 40, opts) =>
  request('pane.read', { pane_id: paneId, source: 'recent_unwrapped', lines, strip_ansi: true }, { timeoutMs: 5000, ...opts });

/**
 * Suscripción persistente a cambios de estado de agente por pane.
 * Emite 'status' con {pane_id, workspace_id, agent_status, agent, title}.
 * Se reconstruye cuando cambia el conjunto de panes con agente.
 */
export class StatusSubscription extends EventEmitter {
  constructor({ socketPath = DEFAULT_SOCKET } = {}) {
    super();
    this.socketPath = socketPath;
    this.paneIds = new Set();
    this.sock = null;
    this.retryTimer = null;
    this.stopped = false;
  }

  setPanes(paneIds) {
    const next = [...new Set(paneIds.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 120))].slice(0, 1000);
    this.stopped = false;
    if (this.sock && next.length === this.paneIds.size) {
      let same = true;
      for (const p of next) if (!this.paneIds.has(p)) { same = false; break; }
      if (same) return;
    }
    this.paneIds = new Set(next);
    this.reconnect();
  }

  reconnect() {
    clearTimeout(this.retryTimer); this.retryTimer = null;
    this.disconnect();
    if (this.stopped || this.paneIds.size === 0) return;
    const sock = net.createConnection(this.socketPath);
    this.sock = sock;
    const decoder = new StringDecoder('utf8');
    let buf = '', bufferedBytes = 0;
    sock.on('connect', () => {
      const subscriptions = [...this.paneIds].map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id }));
      sock.write(JSON.stringify({ id: nextId(), method: 'events.subscribe', params: { subscriptions } }) + '\n');
    });
    sock.on('data', (chunk) => {
      bufferedBytes += chunk.length;
      buf += decoder.write(chunk);
      if (bufferedBytes > MAX_EVENT_LINE_BYTES) {
        this.emit('warn', new Error('evento de herdr demasiado grande'));
        sock.destroy();
        return;
      }
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        bufferedBytes = Buffer.byteLength(buf, 'utf8');
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.event === 'pane.agent_status_changed' && msg.data) this.emit('status', msg.data);
          else if (msg.error) {
            this.emit('warn', new Error(msg.error.message));
            if (msg.error.code === 'invalid_request') { this.paneIds = new Set(); sock.end(); }
          }
        } catch { /* línea parcial o ruido */ }
      }
    });
    const retry = () => {
      if (this.sock !== sock) return;
      this.sock = null;
      if (!this.stopped && this.paneIds.size && !this.retryTimer) {
        this.retryTimer = setTimeout(() => { this.retryTimer = null; this.reconnect(); }, 2000);
        this.retryTimer.unref?.();
      }
    };
    sock.on('error', (e) => { this.emit('warn', e); retry(); });
    sock.on('close', retry);
  }

  disconnect() {
    if (this.sock) { const s = this.sock; this.sock = null; s.removeAllListeners('close'); s.destroy(); }
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    this.disconnect();
  }
}
