// Wrapper del statusline en Node (bin/lcars-statusline.mjs): mismas garantías que la versión POSIX,
// ejecutado con procesos reales y sin `sh`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StatusDropWatcher, writeStatusDrop } from '../server/statusdrop.mjs';
import { expectMode } from './helpers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'bin', 'lcars-statusline.mjs');
const run = (input, args, env) => spawnSync(process.execPath, [SCRIPT, ...args], {
  input, encoding: 'utf8', env: { ...process.env, LCARS_ACCOUNT_PROFILE: '', ...env },
});

async function cache(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-statusline-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { dir, status: path.join(dir, 'lcars-bridge', 'status') };
}

test('statusline (node): solo usa session_id seguros y escribe de forma privada', async (t) => {
  const { dir, status } = await cache(t);
  const valid = '{"session_id":"safe-session_1","cost":2}\n';
  const result = run(valid, [], { XDG_CACHE_HOME: dir, LCARS_ACCOUNT_PROFILE: 'claude-work' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fsp.readFile(path.join(status, 'safe-session_1.json'), 'utf8'), valid);
  assert.equal(await fsp.readFile(path.join(status, 'safe-session_1.profile'), 'utf8'), 'claude-work\n');
  expectMode(await fsp.stat(status), 0o700);
  expectMode(await fsp.stat(path.join(status, 'safe-session_1.json')), 0o600);
  expectMode(await fsp.stat(path.join(status, 'safe-session_1.profile')), 0o600);
  assert.deepEqual((await fsp.readdir(status)).sort(), ['safe-session_1.json', 'safe-session_1.profile'], 'no quedan temporales');

  for (const hostile of ['../../escape', 'a/b', 'a\\b', '', 'x'.repeat(201)]) {
    const rejected = run(`{"session_id":"${hostile}"}\n`, [], { XDG_CACHE_HOME: dir });
    assert.equal(rejected.status, 0);
  }
  assert.deepEqual((await fsp.readdir(status)).sort(), ['safe-session_1.json', 'safe-session_1.profile'], 'ningún id hostil escribe nada');
  await assert.rejects(fsp.access(path.join(dir, 'escape.json')));
});

test('statusline (node): sin perfil en el entorno se retira el perfil anterior; uno inválido no se guarda', async (t) => {
  const { dir, status } = await cache(t);
  const payload = '{"session_id":"s1"}\n';
  run(payload, [], { XDG_CACHE_HOME: dir, LCARS_ACCOUNT_PROFILE: 'claude-work' });
  await fsp.access(path.join(status, 's1.profile'));
  run(payload, [], { XDG_CACHE_HOME: dir });
  await assert.rejects(fsp.access(path.join(status, 's1.profile')));
  run(payload, [], { XDG_CACHE_HOME: dir, LCARS_ACCOUNT_PROFILE: '../malo' });
  await assert.rejects(fsp.access(path.join(status, 's1.profile')));
});

test('statusline (node): encadena el comando original con el mismo stdin y su código de salida', async (t) => {
  const { dir } = await cache(t);
  const payload = '{"session_id":"chain-1","model":"ñandú"}\n';
  const echo = run(payload, [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], { XDG_CACHE_HOME: dir });
  assert.equal(echo.status, 0);
  assert.equal(echo.stdout, payload, 'el comando original recibe el JSON intacto, con acentos');
  const failing = run(payload, [process.execPath, '-e', 'process.exit(7)'], { XDG_CACHE_HOME: dir });
  assert.equal(failing.status, 7, 'el código de salida del comando original se conserva');
});

test('statusline (node): un comando encadenado inexistente no impide el volcado', async (t) => {
  const { dir, status } = await cache(t);
  const result = run('{"session_id":"chain-2"}\n', [path.join(dir, 'no-existe')], { XDG_CACHE_HOME: dir });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /lcars-statusline/);
  await fsp.access(path.join(status, 'chain-2.json'));
});

test('statusline (node): un comando que no lee stdin no cuelga ni rompe el wrapper', async (t) => {
  const { dir } = await cache(t);
  const big = `{"session_id":"chain-3","pad":"${'x'.repeat(512 * 1024)}"}\n`;
  const result = run(big, [process.execPath, '-e', 'process.stdout.write("ok")'], { XDG_CACHE_HOME: dir });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ok');
});

test('el volcado que escribe el wrapper lo lee el StatusDropWatcher', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-drop-roundtrip-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.equal(await writeStatusDrop('{"session_id":"round-1","cost":{"total_cost_usd":1.5}}', { dir, profile: 'claude-work' }), true);
  assert.equal(await writeStatusDrop('{"session_id":"../x"}', { dir, profile: 'claude-work' }), false);
  const received = [];
  const store = { get: (sessionId) => ({ setStatus: (json) => received.push([sessionId, json]) }) };
  const watcher = new StatusDropWatcher(store, (sid, json, meta) => received.push([sid, meta.profileId]), { dir });
  t.after(() => watcher.close());
  await watcher.scan();
  assert.deepEqual(received.map(([sid]) => sid), ['round-1', 'round-1']);
  assert.equal(received.find(([, value]) => typeof value === 'string')[1], 'claude-work');
});
