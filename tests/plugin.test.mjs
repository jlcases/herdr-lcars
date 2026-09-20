import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StatusDropWatcher, isStatusDropName } from '../server/statusdrop.mjs';
import { NEEDS_SH, expectMode, expectPrivate, symlinkOrSkip } from './helpers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('statusline: solo usa session_id seguros y escribe de forma privada', NEEDS_SH, async (t) => {
  const cache = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-status-test-'));
  t.after(() => fsp.rm(cache, { recursive: true, force: true }));
  const script = path.join(ROOT, 'bin', 'lcars-statusline');
  const valid = '{"session_id":"safe-session_1","cost":2}\n';
  const result = spawnSync('sh', [script], { input: valid, encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache, LCARS_ACCOUNT_PROFILE: 'claude-work' } });
  assert.equal(result.status, 0);
  const dir = path.join(cache, 'lcars-bridge', 'status');
  const file = path.join(dir, 'safe-session_1.json');
  assert.equal(await fsp.readFile(file, 'utf8'), valid);
  expectMode(await fsp.stat(dir), 0o700);
  expectMode(await fsp.stat(file), 0o600);
  assert.equal(await fsp.readFile(path.join(dir, 'safe-session_1.profile'), 'utf8'), 'claude-work\n');
  expectMode(await fsp.stat(path.join(dir, 'safe-session_1.profile')), 0o600);

  const malicious = spawnSync('sh', [script], { input: '{"session_id":"../../escape"}\n', encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache } });
  assert.equal(malicious.status, 0);
  assert.equal((await fsp.readdir(dir)).some((name) => name.includes('escape')), false);
});

test('plugin: config.env no se ejecuta como shell', NEEDS_SH, async (t) => {
  const state = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-config-test-'));
  t.after(() => fsp.rm(state, { recursive: true, force: true }));
  const marker = path.join(state, 'executed');
  await fsp.writeFile(path.join(state, 'config.env'), `LCARS_PORT=$(touch ${marker})\nLCARS_LOW_QUOTA=10\n`);
  const result = spawnSync('sh', [path.join(ROOT, 'bin', 'plugin'), 'ping'], {
    encoding: 'utf8', env: { ...process.env, HERDR_PLUGIN_ROOT: ROOT, HERDR_PLUGIN_STATE_DIR: state, HERDR_PLUGIN_CONFIG_DIR: state },
  });
  assert.equal(result.status, 2);
  await assert.rejects(fsp.access(marker));
});

test('plugin: crea accounts.json privado sin secretos', NEEDS_SH, async (t) => {
  const state = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-profiles-test-'));
  t.after(() => fsp.rm(state, { recursive: true, force: true }));
  await fsp.writeFile(path.join(state, 'config.env'), 'LCARS_PORT=4700\nLCARS_LOW_QUOTA=10\nNODE_BIN=/no-existe\n');
  spawnSync('sh', [path.join(ROOT, 'bin', 'plugin'), 'ping'], {
    encoding: 'utf8', env: { ...process.env, HERDR_PLUGIN_ROOT: ROOT, HERDR_PLUGIN_STATE_DIR: state, HERDR_PLUGIN_CONFIG_DIR: state },
  });
  const profiles = JSON.parse(await fsp.readFile(path.join(state, 'accounts.json'), 'utf8'));
  assert.deepEqual(profiles, { version: 1, profiles: [] });
  expectMode(await fsp.stat(path.join(state, 'accounts.json')), 0o600);
});

test('plugin: migra configuración y cuentas por copia privada sin destruir el rollback', NEEDS_SH, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-private-migration-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'new');
  const legacy = path.join(root, 'legacy');
  await fsp.mkdir(legacy, { recursive: true });
  const legacyConfig = 'LCARS_PORT=65531\nLCARS_LOW_QUOTA=7\nNODE_BIN=/no-existe\n';
  const legacyAccounts = '{"version":1,"profiles":[{"id":"work","provider":"claude","label":"Work","home":"~/.claude-work"}]}\n';
  await fsp.writeFile(path.join(legacy, 'config.env'), legacyConfig, { mode: 0o644 });
  await fsp.writeFile(path.join(legacy, 'accounts.json'), legacyAccounts, { mode: 0o644 });

  const env = {
    ...process.env,
    HOME: root,
    HERDR_PLUGIN_ROOT: ROOT,
    HERDR_PLUGIN_STATE_DIR: state,
    HERDR_PLUGIN_CONFIG_DIR: state,
    HERDR_LCARS_LEGACY_CONFIG_DIR: legacy,
    HERDR_LCARS_MIGRATE_FROM: 'dev.jlcases.lcars-bridge',
  };
  const result = spawnSync('sh', [path.join(ROOT, 'bin', 'plugin'), 'ping'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fsp.readFile(path.join(state, 'config.env'), 'utf8'), legacyConfig);
  assert.equal(await fsp.readFile(path.join(state, 'accounts.json'), 'utf8'), legacyAccounts);
  assert.equal(await fsp.readFile(path.join(legacy, 'config.env'), 'utf8'), legacyConfig);
  assert.equal(await fsp.readFile(path.join(legacy, 'accounts.json'), 'utf8'), legacyAccounts);
  expectMode(await fsp.stat(state), 0o700);
  expectMode(await fsp.stat(path.join(state, 'config.env')), 0o600);
  expectMode(await fsp.stat(path.join(state, 'accounts.json')), 0o600);

  await fsp.writeFile(path.join(state, 'accounts.json'), '{"version":1,"profiles":[]}\n');
  const repeated = spawnSync('sh', [path.join(ROOT, 'bin', 'plugin'), 'ping'], { encoding: 'utf8', env });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(await fsp.readFile(path.join(state, 'accounts.json'), 'utf8'), '{"version":1,"profiles":[]}\n',
    'una segunda ejecución nunca pisa la configuración nueva');
});

test('plugin: migra contextos por copia y deja intacto el almacén antiguo', NEEDS_SH, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-context-migration-test-'));
  const state = path.join(root, 'new');
  const legacyContexts = path.join(root, 'legacy-contexts');
  const healthy = path.join(root, 'healthy');
  const fakeNode = path.join(root, 'node');
  let bridgePid;
  t.after(async () => {
    if (bridgePid) { try { process.kill(bridgePid); } catch {} }
    await fsp.rm(root, { recursive: true, force: true });
  });
  await fsp.mkdir(legacyContexts, { recursive: true });
  await fsp.writeFile(path.join(legacyContexts, 'record.json'), '{"schemaVersion":2,"events":[]}\n');
  await fsp.mkdir(state, { recursive: true });
  await fsp.writeFile(path.join(state, 'config.env'), `LCARS_PORT=65532\nLCARS_LOW_QUOTA=10\nNODE_BIN=${fakeNode}\n`);
  await fsp.writeFile(fakeNode, `#!/bin/sh
case "\${1:-}" in
  -e)
    case "\${2:-}" in
      *process.versions.node*) printf '22'; exit 0 ;;
      *) [ -f "$FAKE_HEALTHY_FILE" ] && exit 0 || exit 1 ;;
    esac
    ;;
  */bin/lcars-bridge.mjs)
    : > "$FAKE_HEALTHY_FILE"
    trap 'exit 0' TERM INT
    while :; do sleep 1; done
    ;;
esac
exit 1
`, { mode: 0o700 });

  const env = {
    ...process.env,
    HOME: root,
    FAKE_HEALTHY_FILE: healthy,
    HERDR_PLUGIN_ID: 'dev.jlcases.herdr-lcars',
    HERDR_PLUGIN_ROOT: ROOT,
    HERDR_PLUGIN_STATE_DIR: state,
    HERDR_PLUGIN_CONFIG_DIR: state,
    HERDR_LCARS_LEGACY_CONTEXT_DIR: legacyContexts,
  };
  const start = spawnSync('sh', [path.join(ROOT, 'bin', 'plugin'), 'start'], { encoding: 'utf8', env, timeout: 5_000 });
  assert.equal(start.status, 0, start.stderr);
  bridgePid = Number((await fsp.readFile(path.join(state, 'bridge.pid'), 'utf8')).trim());
  const migrated = path.join(state, 'contexts', 'record.json');
  assert.equal(await fsp.readFile(migrated, 'utf8'), '{"schemaVersion":2,"events":[]}\n');
  assert.equal(await fsp.readFile(path.join(legacyContexts, 'record.json'), 'utf8'), '{"schemaVersion":2,"events":[]}\n');
  expectMode(await fsp.stat(path.join(state, 'contexts')), 0o700);
  expectPrivate(await fsp.stat(migrated), 'los contextos migrados no quedan accesibles a grupo u otros');

  const stop = spawnSync('sh', [path.join(ROOT, 'bin', 'plugin'), 'stop'], { encoding: 'utf8', env });
  assert.equal(stop.status, 0, stop.stderr);
  bridgePid = undefined;
});

test('plugin: rechaza enlaces simbólicos en sus ficheros privados', NEEDS_SH, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-symlink-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  const outside = path.join(root, 'outside');
  await fsp.mkdir(state, { recursive: true });
  await fsp.writeFile(outside, 'LCARS_PORT=4700\n');
  if (!await symlinkOrSkip(t, outside, path.join(state, 'config.env'))) return;
  const result = spawnSync('sh', [path.join(ROOT, 'bin', 'plugin'), 'ping'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: root, HERDR_PLUGIN_ROOT: ROOT, HERDR_PLUGIN_STATE_DIR: state, HERDR_PLUGIN_CONFIG_DIR: state },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fichero privado no puede ser un enlace/);
  assert.equal(await fsp.readFile(outside, 'utf8'), 'LCARS_PORT=4700\n');
});

test('combustible: recibe cuotas por SSE y reserva las ventanas 5 h y 7 d', async () => {
  const source = await fsp.readFile(path.join(ROOT, 'tools', 'fuel.mjs'), 'utf8');
  assert.match(source, /fetch\(`\$\{API\}\/events`/);
  assert.match(source, /event === 'accounts'/);
  assert.match(source, /spec\.id === 'five_hour' \? '5 h'/);
  assert.match(source, /spec\.id === 'seven_day' \? '7 d'/);
  assert.match(source, /SIN SEÑAL · esperando lectura/);
  assert.doesNotMatch(source, /setInterval\(tick/);
});

test('plugin: rechaza Node 20 porque ya está fuera de soporte', NEEDS_SH, async (t) => {
  const state = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-node-test-'));
  t.after(() => fsp.rm(state, { recursive: true, force: true }));
  const fakeNode = path.join(state, 'node20');
  await fsp.writeFile(fakeNode, '#!/bin/sh\nprintf 20\n', { mode: 0o700 });
  await fsp.writeFile(path.join(state, 'config.env'), `LCARS_PORT=4700\nLCARS_LOW_QUOTA=10\nNODE_BIN=${fakeNode}\n`);
  const result = spawnSync('sh', [path.join(ROOT, 'bin', 'plugin'), 'start'], {
    encoding: 'utf8', env: { ...process.env, HERDR_PLUGIN_ROOT: ROOT, HERDR_PLUGIN_STATE_DIR: state, HERDR_PLUGIN_CONFIG_DIR: state },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /anterior a Node 22|no encuentro Node 22/);
});

test('plugin: un PID reciclado de otro proceso nunca se mata', NEEDS_SH, async (t) => {
  const state = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-pid-test-'));
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(async () => { sleeper.kill(); await fsp.rm(state, { recursive: true, force: true }); });
  await fsp.writeFile(path.join(state, 'config.env'), 'LCARS_PORT=4700\nLCARS_LOW_QUOTA=10\n');
  await fsp.writeFile(path.join(state, 'bridge.pid'), `${sleeper.pid}\n`);
  const result = spawnSync('sh', [path.join(ROOT, 'bin', 'plugin'), 'stop'], {
    encoding: 'utf8', env: { ...process.env, HERDR_PLUGIN_ROOT: ROOT, HERDR_PLUGIN_STATE_DIR: state, HERDR_PLUGIN_CONFIG_DIR: state },
  });
  assert.equal(result.status, 0);
  assert.equal(sleeper.exitCode, null);
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
});

test('status drop: solo lee ficheros regulares, acotados y con ID seguro', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-drop-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const received = [];
  const store = { get: (sessionId) => ({ setStatus: (json) => received.push([sessionId, json]) }) };
  const watcher = new StatusDropWatcher(store, null, { dir });
  t.after(() => watcher.close());

  assert.equal(isStatusDropName('safe_1.json'), true);
  assert.equal(isStatusDropName('../escape.json'), false);
  await fsp.writeFile(path.join(dir, 'safe_1.json'), '{"model":{"id":"claude"}}');
  if (!await symlinkOrSkip(t, path.join(dir, 'safe_1.json'), path.join(dir, 'linked.json'))) return;
  const huge = await fsp.open(path.join(dir, 'huge.json'), 'w');
  await huge.truncate(1024 * 1024 + 1); await huge.close();

  await watcher.start();
  assert.deepEqual(received, [['safe_1', { model: { id: 'claude' } }]]);
  assert.equal(await watcher.readDrop('linked.json'), false);
  assert.equal(await watcher.readDrop('huge.json'), false);
  expectMode(await fsp.stat(dir), 0o700);
  expectMode(await fsp.stat(path.join(dir, 'safe_1.json')), 0o600);
});
