#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { startServer } from '../server/index.mjs';

const args = process.argv.slice(2);
const get = (flag, def) => { const i = args.indexOf(flag); return i !== -1 && args[i + 1] ? args[i + 1] : def; };
const port = Number(get('--port', process.env.LCARS_PORT || 4700));
const host = get('--host', '127.0.0.1');
const socketPath = get('--socket', process.env.HERDR_SOCKET_PATH || undefined);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`herdr-lcars [--port 4700] [--host 127.0.0.1] [--socket ~/.config/herdr/herdr.sock] [--open]

LCARS for Herdr: puente de mando para la flota de agentes (solo loopback; no se expone en red).
Receptor OTLP http/json en /v1/logs y /v1/metrics (configura Claude Code con
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port> y OTEL_EXPORTER_OTLP_PROTOCOL=http/json).`);
  process.exit(0);
}

const log = { info: (...a) => console.log(new Date().toISOString(), ...a), warn: (...a) => console.warn(new Date().toISOString(), 'WARN', ...a), error: (...a) => console.error(new Date().toISOString(), 'ERR', ...a) };
process.on('unhandledRejection', (e) => log.error('unhandled:', e?.stack || e));
let app;
let stopping = false;
process.on('uncaughtException', (error) => {
  log.error('uncaught:', error?.stack || error);
  if (stopping) return;
  stopping = true; app?.close();
  setTimeout(() => process.exit(1), 50);
});
try { app = await startServer({ port, host, socketPath, log }); }
catch (error) { log.error(error?.message || error); process.exit(1); }
if (args.includes('--open')) {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const opener = spawn(cmd, [app.url], { stdio: 'ignore', detached: true });
  opener.on('error', (error) => log.warn(`no se pudo abrir el navegador: ${error.message}`));
  opener.unref();
}
const stop = () => { if (stopping) return; stopping = true; app.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
