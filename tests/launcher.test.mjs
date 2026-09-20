// Launcher en Node (bin/plugin.mjs). Usa procesos reales y un puente falso que solo responde
// /api/state, de modo que se ejecuta igual en Windows, macOS y Linux sin Herdr ni `sh`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  Launcher, LauncherError, belongsToBridge, commandLineOf, configValue, isHealthy, preparePrivateFiles,
  resolveLayout, validateSettings,
} from '../server/launcher.mjs';
import { expectMode, symlinkOrSkip } from './helpers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const FAKE_BRIDGE = `
import http from 'node:http';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ bootId: 'fake', herdr: { ok: true }, accounts: [], agents: [] }));
}).listen(port, '127.0.0.1');
setInterval(() => {}, 1 << 30);
`;

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    }).on('error', reject);
  });
}

async function sandbox(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-launcher-'));
  const bridgeScript = path.join(dir, 'bridge.mjs');
  await fsp.writeFile(bridgeScript, FAKE_BRIDGE);
  const state = path.join(dir, 'state');
  const port = await freePort();
  const env = {
    ...process.env, HOME: dir, USERPROFILE: dir,
    HERDR_PLUGIN_ROOT: ROOT, HERDR_PLUGIN_STATE_DIR: state, HERDR_PLUGIN_CONFIG_DIR: state,
    LCARS_PORT: String(port), LCARS_LOW_QUOTA: '10', NODE_BIN: '',
  };
  await fsp.mkdir(state, { recursive: true });
  const launcher = new Launcher({ root: ROOT, env, home: dir, bridgeScript, log: () => {} });
  t.after(async () => {
    await launcher.stop().catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { dir, state, port, env, launcher, bridgeScript };
}

test('config.env: gana la última línea, se quitan comillas y CRLF, y nada se evalúa', () => {
  assert.equal(configValue('LCARS_PORT=1\nLCARS_PORT=2\n', 'LCARS_PORT'), '2');
  assert.equal(configValue('LCARS_PORT="4701"\r\n', 'LCARS_PORT'), '4701');
  assert.equal(configValue("NODE_BIN='C:\\Program Files\\nodejs\\node.exe'\n", 'NODE_BIN'), 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(configValue('# LCARS_PORT=9\n', 'LCARS_PORT', '4700'), '4700', 'un comentario no es un valor');
  assert.equal(configValue('LCARS_PORT=$(touch x)\n', 'LCARS_PORT'), '$(touch x)');
});

test('ajustes: enteros acotados, con los mismos mensajes y código 2 que el launcher POSIX', () => {
  assert.deepEqual(validateSettings({ port: '4700', lowQuota: '10' }), { port: 4700, lowQuota: 10 });
  for (const [input, message] of [
    [{ port: 'abc', lowQuota: '10' }, /LCARS_PORT debe ser un entero/],
    [{ port: '4700', lowQuota: '-1' }, /LCARS_LOW_QUOTA debe ser un entero/],
    [{ port: '70000', lowQuota: '10' }, /LCARS_PORT fuera de rango/],
    [{ port: '0', lowQuota: '10' }, /LCARS_PORT fuera de rango/],
    [{ port: '4700', lowQuota: '101' }, /LCARS_LOW_QUOTA fuera de rango/],
    [{ port: '4700', lowQuota: '0001' }, /fuera de rango/],
  ]) {
    assert.throws(() => validateSettings(input), (error) => error instanceof LauncherError && error.status === 2 && message.test(error.message));
  }
});

test('launcher: config.env no se ejecuta como shell', async (t) => {
  const { dir, state, env } = await sandbox(t);
  const marker = path.join(dir, 'executed');
  await fsp.writeFile(path.join(state, 'config.env'), `LCARS_PORT=$(touch ${marker})\nLCARS_LOW_QUOTA=10\n`);
  const launcher = new Launcher({ root: ROOT, env: { ...env, LCARS_PORT: '' }, home: dir });
  await assert.rejects(launcher.init(), (error) => error.status === 2);
  await assert.rejects(fsp.access(marker));
});

test('launcher: crea config.env y accounts.json por defecto, sin secretos y sin pisar los existentes', async (t) => {
  const { state, launcher } = await sandbox(t);
  await launcher.init();
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(state, 'accounts.json'), 'utf8')), { version: 1, profiles: [] });
  assert.match(await fsp.readFile(path.join(state, 'config.env'), 'utf8'), /^LCARS_PORT=4700$/m);
  expectMode(await fsp.stat(state), 0o700);
  expectMode(await fsp.stat(path.join(state, 'accounts.json')), 0o600);
  await fsp.writeFile(path.join(state, 'accounts.json'), '{"version":1,"profiles":[{"id":"x"}]}\n');
  await new Launcher({ root: ROOT, env: launcher.env, home: state, log: () => {} }).init();
  assert.match(await fsp.readFile(path.join(state, 'accounts.json'), 'utf8'), /"id":"x"/, 'una segunda ejecución nunca pisa la configuración');
});

test('launcher: rechaza enlaces simbólicos en sus ficheros privados', async (t) => {
  const { dir, state, env } = await sandbox(t);
  const outside = path.join(dir, 'outside');
  await fsp.writeFile(outside, 'LCARS_PORT=4700\n');
  if (!await symlinkOrSkip(t, outside, path.join(state, 'config.env'))) return;
  await assert.rejects(new Launcher({ root: ROOT, env, home: dir }).init(), /fichero privado no puede ser un enlace/);
  assert.equal(await fsp.readFile(outside, 'utf8'), 'LCARS_PORT=4700\n');
});

test('launcher: el diseño de directorios sigue las variables de Herdr y cae al perfil del usuario', () => {
  const given = resolveLayout({ HERDR_PLUGIN_ROOT: '/r', HERDR_PLUGIN_STATE_DIR: '/s', HERDR_PLUGIN_CONFIG_DIR: '/c', HERDR_PLUGIN_ID: 'x.y' }, { home: '/home/ana' });
  assert.deepEqual([given.root, given.stateDir, given.configDir, given.pluginId], ['/r', '/s', '/c', 'x.y']);
  assert.equal(given.confFile, path.join('/c', 'config.env'));
  const fallback = resolveLayout({}, { home: '/home/ana', root: '/r' });
  assert.equal(fallback.stateDir, path.join('/home/ana', '.cache', 'lcars-bridge'));
  assert.equal(fallback.configDir, fallback.stateDir);
});

test('launcher: arranca el puente, es idempotente y lo para sin dejar rastro', async (t) => {
  const { state, port, launcher } = await sandbox(t);
  await launcher.init();
  assert.equal(await isHealthy(port), false);
  await launcher.start();
  assert.equal(await isHealthy(port), true);
  const pid = Number((await fsp.readFile(path.join(state, 'bridge.pid'), 'utf8')).trim());
  assert.ok(pid > 0);
  assert.equal(await launcher.alive(), true);
  expectMode(await fsp.stat(path.join(state, 'contexts')), 0o700);
  assert.match(await fsp.readFile(path.join(state, 'bridge.log'), 'utf8'), /--- arranque /);

  await launcher.start();
  assert.equal(Number((await fsp.readFile(path.join(state, 'bridge.pid'), 'utf8')).trim()), pid, 'un segundo start no lanza otro puente');

  await launcher.stop();
  await assert.rejects(fsp.access(path.join(state, 'bridge.pid')));
  for (let i = 0; i < 30 && await isHealthy(port); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await isHealthy(port), false);
});

test('launcher: un puerto ocupado por otro proceso nunca se adopta ni se mata', async (t) => {
  const { port, launcher } = await sandbox(t);
  const intruder = http.createServer((req, res) => res.end(JSON.stringify({ bootId: 'ajeno', herdr: { ok: true } })));
  await new Promise((resolve) => intruder.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => intruder.close(resolve)));
  await launcher.init();
  await assert.rejects(launcher.start(), /ya responde, pero el proceso no pertenece a LCARS for Herdr/);
  assert.equal(await isHealthy(port), true, 'el proceso ajeno sigue vivo');
});

test('launcher: un PID reciclado de otro proceso nunca se mata', async (t) => {
  const { state, launcher } = await sandbox(t);
  await launcher.init();
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  t.after(() => sleeper.kill());
  await fsp.writeFile(path.join(state, 'bridge.pid'), `${sleeper.pid}\n`);
  assert.equal(await launcher.alive(), false, 'el PID existe pero su línea de comandos no es el puente');
  await launcher.stop();
  assert.equal(sleeper.exitCode, null);
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
});

test('launcher: NODE_BIN inválido se rechaza con un mensaje claro', async (t) => {
  const { launcher } = await sandbox(t);
  await launcher.init();
  launcher.settings.nodeBin = path.join(os.tmpdir(), 'no-existe', 'node');
  await assert.rejects(launcher.start(), /NODE_BIN=.* no sirve/);
});

test('launcher: rota el registro cuando supera 5 MiB', async (t) => {
  const { state, launcher } = await sandbox(t);
  await launcher.init();
  const log = path.join(state, 'bridge.log');
  const handle = await fsp.open(log, 'w'); await handle.truncate(5 * 1024 * 1024 + 1); await handle.close();
  await launcher.start();
  assert.ok((await fsp.stat(`${log}.1`)).size > 5 * 1024 * 1024);
  assert.ok((await fsp.stat(log)).size < 1024 * 1024);
});

test('la línea de comandos de un proceso identifica al puente de esta instalación', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-cmdline-'));
  const script = path.join(dir, 'lcars-bridge.mjs');
  await fsp.writeFile(script, 'setInterval(() => {}, 1 << 30);\n');
  const child = spawn(process.execPath, [script, '--port', '4700'], { stdio: 'ignore' });
  t.after(async () => { child.kill(); await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  assert.ok((await commandLineOf(child.pid)).includes('lcars-bridge.mjs'), 'se lee la línea de comandos de un proceso ajeno');
  assert.equal(await belongsToBridge(child.pid, script), true);
  if (process.platform === 'win32') {
    assert.equal(await belongsToBridge(child.pid, script.replaceAll('\\', '/').toUpperCase()), true, 'en Windows la ruta no distingue barras ni mayúsculas');
  }
  assert.equal(await belongsToBridge(child.pid, path.join(os.tmpdir(), 'otro', 'lcars-bridge.mjs')), false);
  assert.equal(await belongsToBridge(0, script), false);
  assert.equal(await belongsToBridge(2 ** 30, script), false, 'un PID inexistente no es del puente');
});

test('preparePrivateFiles se niega a usar un directorio que sea un enlace', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-launcher-link-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const real = path.join(dir, 'real'); await fsp.mkdir(real);
  const link = path.join(dir, 'link');
  if (!await symlinkOrSkip(t, real, link)) return;
  await assert.rejects(preparePrivateFiles(resolveLayout({ HERDR_PLUGIN_STATE_DIR: link, HERDR_PLUGIN_CONFIG_DIR: link }, { root: ROOT })), /directorio privado no puede ser un enlace/);
});
