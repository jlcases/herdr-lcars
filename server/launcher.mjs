// Ciclo de vida del puente para el plugin de Herdr: arrancar, parar, abrir, diagnosticar.
//
// Es el equivalente en Node de bin/plugin (shell POSIX). Existe porque Windows no garantiza `sh`;
// Herdr lo invoca con `node bin/plugin.mjs`. Toda la política vive aquí y bin/plugin.mjs solo
// traduce argumentos, de modo que se puede probar sin Herdr y en cualquier plataforma.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import * as herdr from './herdr.mjs';
import { openCommand } from './platform.mjs';

export const DEFAULT_PLUGIN_ID = 'dev.jlcases.herdr-lcars';
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const HEALTH_TIMEOUT_MS = 2_500;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Error con el código de salida que debe devolver el proceso. */
export class LauncherError extends Error {
  constructor(message, status = 1) { super(message); this.status = status; }
}

const defaultConfig = (platform) => `# Configuración de LCARS for Herdr. Se lee en cada arranque del puente.

# Puerto del panel y del receptor OTLP. Si lo cambias, actualiza también
# OTEL_EXPORTER_OTLP_ENDPOINT en ~/.claude/settings.json.
LCARS_PORT=4700

# Aviso de poca cuota: porcentaje restante por debajo del cual se notifica, por cuenta.
LCARS_LOW_QUOTA=10

# Ruta a Node si la detección automática falla (Node 22 o superior).
# NODE_BIN=${platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/opt/homebrew/bin/node'}
`;

const DEFAULT_PROFILES = '{\n  "version": 1,\n  "profiles": []\n}\n';

/** Última línea `CLAVE=valor` del fichero, sin comillas. `config.env` es dato: nunca se evalúa. */
export function configValue(text, key, fallback = '') {
  let value = '';
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith(`${key}=`)) value = line.slice(key.length + 1);
  }
  value = value.replace(/^(["'])(.*)\1$/, '$2').replace(/^["']/, '').replace(/["']$/, '');
  return value || fallback;
}

/** Valida los ajustes con los mismos límites y mensajes que el launcher POSIX. */
export function validateSettings({ port, lowQuota }) {
  if (!/^\d+$/.test(port)) throw new LauncherError('LCARS_PORT debe ser un entero entre 1 y 65535', 2);
  if (!/^\d+$/.test(lowQuota)) throw new LauncherError('LCARS_LOW_QUOTA debe ser un entero entre 0 y 100', 2);
  if (port.length > 5 || Number(port) < 1 || Number(port) > 65535) throw new LauncherError('LCARS_PORT fuera de rango', 2);
  if (lowQuota.length > 3 || Number(lowQuota) > 100) throw new LauncherError('LCARS_LOW_QUOTA fuera de rango', 2);
  return { port: Number(port), lowQuota: Number(lowQuota) };
}

export function resolveLayout(env = process.env, { home = os.homedir(), root } = {}) {
  const pluginRoot = env.HERDR_PLUGIN_ROOT || root;
  const stateDir = env.HERDR_PLUGIN_STATE_DIR || path.join(home, '.cache', 'lcars-bridge');
  const configDir = env.HERDR_PLUGIN_CONFIG_DIR || stateDir;
  return {
    root: pluginRoot,
    pluginId: env.HERDR_PLUGIN_ID || DEFAULT_PLUGIN_ID,
    stateDir, configDir,
    contextDir: path.join(stateDir, 'contexts'),
    pidFile: path.join(stateDir, 'bridge.pid'),
    logFile: path.join(stateDir, 'bridge.log'),
    confFile: path.join(configDir, 'config.env'),
    profilesFile: path.join(configDir, 'accounts.json'),
  };
}

const isMissing = (error) => error?.code === 'ENOENT';
async function refuseLink(target, what) {
  try {
    if ((await fsp.lstat(target)).isSymbolicLink()) throw new LauncherError(`${what} no puede ser un enlace: ${target}`);
  } catch (error) { if (!isMissing(error)) throw error; }
}

/** Crea lo que falte y se niega a seguir enlaces: son ficheros privados, no rutas que resolver. */
export async function preparePrivateFiles(layout, platform = process.platform) {
  for (const dir of new Set([layout.stateDir, layout.configDir])) {
    await refuseLink(dir, 'directorio privado');
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    await fsp.chmod(dir, 0o700).catch(() => {});
  }
  for (const file of [layout.pidFile, layout.logFile, layout.confFile, layout.profilesFile]) await refuseLink(file, 'fichero privado');
  for (const [file, content] of [[layout.confFile, defaultConfig(platform)], [layout.profilesFile, DEFAULT_PROFILES]]) {
    try { await fsp.writeFile(file, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await fsp.chmod(file, 0o600).catch(() => {});
  }
}

async function readSettings(layout, env) {
  const text = await fsp.readFile(layout.confFile, 'utf8').catch(() => '');
  const port = env.LCARS_PORT || configValue(text, 'LCARS_PORT', '4700');
  const lowQuota = env.LCARS_LOW_QUOTA || configValue(text, 'LCARS_LOW_QUOTA', '10');
  return { ...validateSettings({ port, lowQuota }), nodeBin: env.NODE_BIN || configValue(text, 'NODE_BIN', '') };
}

/** ¿Responde un puente de LCARS (no cualquier cosa) en ese puerto? */
export async function isHealthy(port, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const body = await response.json().catch(() => null);
    return Boolean(response.ok && body?.bootId && body?.herdr);
  } catch { return false; }
}

export function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; } // existe pero no es nuestro
}

/** Línea de comandos de un proceso ajeno: `ps` en POSIX, WMI vía PowerShell en Windows. */
export function commandLineOf(pid, { platform = process.platform, execFileImpl = execFile } = {}) {
  const [file, args] = platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`]]
    : ['ps', ['-p', String(Number(pid)), '-o', 'command=']];
  return new Promise((resolve) => {
    // Arrancar PowerShell en frío puede tardar varios segundos (antivirus, equipos cargados). Solo se
    // consulta al parar o arrancar, nunca en un camino caliente, así que es mejor esperar que fallar.
    execFileImpl(file, args, { timeout: 30_000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => resolve(error ? '' : String(stdout || '')));
  });
}

/** Un PID solo se toca si su línea de comandos demuestra que es el puente de esta instalación. */
export async function belongsToBridge(pid, bridgeScript, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) return false;
  const line = await commandLineOf(pid, options);
  const win = (options.platform ?? process.platform) === 'win32';
  const norm = (value) => (win ? value.replaceAll('/', '\\').toLowerCase() : value);
  return norm(line).includes(norm(bridgeScript));
}

async function readPid(file) {
  const raw = (await fsp.readFile(file, 'utf8').catch(() => '')).trim();
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

export class Launcher {
  constructor({ root, env = process.env, platform = process.platform, home = os.homedir(), bridgeScript, log = console.error } = {}) {
    this.env = env; this.platform = platform; this.log = log;
    this.layout = resolveLayout(env, { home, root });
    this.bridgeScript = bridgeScript || path.join(this.layout.root, 'bin', 'lcars-bridge.mjs');
    this.settings = null;
  }

  async init() {
    try { process.umask(0o077); } catch { /* Windows y workers: no aplica */ }
    await preparePrivateFiles(this.layout, this.platform);
    this.settings = await readSettings(this.layout, this.env);
    return this;
  }

  get port() { return this.settings.port; }
  healthy() { return isHealthy(this.port); }
  async alive() { return belongsToBridge(await readPid(this.layout.pidFile), this.bridgeScript, { platform: this.platform }); }

  /** Node que ejecutará el puente: el configurado, o el mismo que ejecuta este launcher. */
  async nodeBin() {
    const configured = this.settings.nodeBin;
    if (!configured) {
      if (Number(process.versions.node.split('.')[0]) < 22) throw new LauncherError('LCARS for Herdr: no encuentro Node 22 o superior.');
      return process.execPath;
    }
    const major = await new Promise((resolve) => {
      execFile(configured, ['-p', 'process.versions.node.split(".")[0]'], { timeout: 8_000, windowsHide: true, encoding: 'utf8' },
        (error, stdout) => resolve(error ? 0 : Number(String(stdout).trim())));
    });
    if (!(major >= 22)) throw new LauncherError(`NODE_BIN=${configured} no sirve (¿falta, no es ejecutable o es anterior a Node 22?)`);
    return configured;
  }

  async prepareContextDir() {
    await refuseLink(this.layout.contextDir, 'directorio de contexto');
    await fsp.mkdir(this.layout.contextDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.layout.contextDir, 0o700).catch(() => {});
  }

  async rotateLog() {
    const size = (await fsp.stat(this.layout.logFile).catch(() => null))?.size ?? 0;
    if (size > MAX_LOG_BYTES) await fsp.rename(this.layout.logFile, `${this.layout.logFile}.1`).catch(() => {});
  }

  async start() {
    const node = await this.nodeBin();
    // Solo se reutiliza el proceso que demuestra pertenecer a esta instalación. Una respuesta HTTP
    // cualquiera en el puerto no concede propiedad sobre el proceso ni permiso para matarlo.
    if (await this.alive()) {
      if (await this.healthy()) return;
      this.kill(await readPid(this.layout.pidFile));
      await wait(1000);
    } else if (await this.healthy()) {
      throw new LauncherError(`el puerto ${this.port} ya responde, pero el proceso no pertenece a LCARS for Herdr`);
    }
    await this.prepareContextDir();
    await this.rotateLog();
    await fsp.appendFile(this.layout.logFile, `\n--- arranque ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} ---\n`, { mode: 0o600 });
    const out = fs.openSync(this.layout.logFile, 'a', 0o600);
    let child;
    try {
      child = spawn(node, [this.bridgeScript, '--port', String(this.port)], {
        detached: true, stdio: ['ignore', out, out], windowsHide: true,
        env: {
          ...this.env,
          LCARS_PORT: String(this.port), LCARS_LOW_QUOTA: String(this.settings.lowQuota),
          LCARS_ACCOUNT_PROFILES: this.layout.profilesFile, HERDR_LCARS_CONTEXT_DIR: this.layout.contextDir,
        },
      });
    } finally { fs.closeSync(out); }
    // Un `spawn` fallido (p. ej. ENOENT) se anuncia como evento asíncrono; sin escucha derribaría el proceso.
    const failed = new Promise((resolve) => child.once('error', resolve));
    child.unref();
    if (!child.pid) throw new LauncherError(`no se pudo lanzar el puente: ${(await failed).message}`);
    await fsp.writeFile(this.layout.pidFile, `${child.pid}\n`, { mode: 0o600 });
    for (let i = 0; i < 25; i++) {
      if (await this.healthy()) return;
      await wait(400);
    }
    throw new LauncherError(`el puente no respondió en el puerto ${this.port}; mira ${this.layout.logFile}`);
  }

  kill(pid) {
    try { process.kill(pid); } catch { /* ya no existe */ }
  }

  async stop() {
    const pid = await readPid(this.layout.pidFile);
    if (await this.alive()) this.kill(pid);
    // Un PID vivo que no se pudo identificar como el puente no se toca, pero tampoco se calla: puede ser
    // un PID reciclado, o que la consulta de la línea de comandos falló.
    else if (pid && processExists(pid)) this.log(`bridge.pid apunta al proceso ${pid}, que no se pudo identificar como el puente; no se toca`);
    await fsp.rm(this.layout.pidFile, { force: true });
  }

  async restart() { await this.stop(); await wait(1000); await this.start(); }

  herdrBin() { return this.env.HERDR_BIN_PATH || 'herdr'; }
  notify(title, body, sound) {
    const args = ['notification', 'show', title, '--body', body, ...(sound ? ['--sound', sound] : [])];
    return new Promise((resolve) => execFile(this.herdrBin(), args, { timeout: 8_000, windowsHide: true }, () => resolve()));
  }

  /** Abre una URL o un fichero con la aplicación predeterminada del sistema. */
  openTarget(target) {
    const [cmd, args] = openCommand(target, this.platform);
    const opener = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    opener.on('error', (error) => this.log(`no se pudo abrir ${target}: ${error.message}`));
    opener.unref();
  }

  async open(view) {
    try { await this.start(); }
    catch (error) {
      await this.notify('LCARS for Herdr', 'No pudo arrancar. Revisa el registro del plugin.', 'request');
      throw error;
    }
    // Cada acción abre exactamente lo que dice: el plano de la nave o la cubierta compacta.
    this.openTarget(`http://127.0.0.1:${this.port}/${view === 'deck' ? 'index.html?classic=1' : 'msd.html'}`);
  }

  async ping() {
    const node = this.settings.nodeBin || process.execPath;
    let body = `Node: ${node}`;
    const healthy = await this.healthy();
    body += healthy ? ` · puente OK en :${this.port}` : ` · puente CAÍDO en :${this.port}`;
    const socketPath = this.env.HERDR_SOCKET_PATH;
    if (socketPath) {
      const reachable = await herdr.request('ping', {}, { socketPath, timeoutMs: 2_000 }).then(() => true, () => false);
      body += reachable ? ' · socket OK' : ' · sin socket';
    } else body += ' · sin socket';
    if (healthy) {
      const state = await fetch(`http://127.0.0.1:${this.port}/api/state`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
        .then((r) => r.json()).catch(() => null);
      body += state ? ` · ${(state.accounts || []).length} cuentas · ${(state.agents || []).length} agentes` : ' · sin datos';
    }
    await this.notify('LCARS for Herdr', body, 'done');
    return body;
  }

  /** Ejecuta un hijo con la terminal heredada y devuelve su código de salida. */
  run(cmd, args) {
    return new Promise((resolve) => {
      const env = { ...this.env, LCARS_PORT: String(this.port) };
      const child = spawn(cmd, args, { stdio: 'inherit', windowsHide: false, env });
      child.on('error', (error) => { this.log(error.message); resolve(1); });
      child.on('close', (code) => resolve(code ?? 1));
    });
  }

  async fuel() {
    await this.start().catch(() => {});
    return this.run(await this.nodeBin(), [path.join(this.layout.root, 'tools', 'fuel.mjs')]);
  }

  // Las teclas solo se pueden atar a acciones, no a panes; esta acción abre el pane por CLI.
  // Herdr exige ids únicos por plugin: en Windows el pane es `fuel-win` (ver herdr-plugin.toml).
  fuelPane() {
    const entrypoint = this.platform === 'win32' ? 'fuel-win' : 'fuel';
    return this.run(this.herdrBin(), ['plugin', 'pane', 'open', '--plugin', this.layout.pluginId, '--entrypoint', entrypoint]);
  }
}
