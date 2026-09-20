// Comportamiento dependiente de plataforma. Cada función recibe `platform`, así que estas pruebas
// se ejecutan igual en cualquier sistema y no necesitan Windows para cubrir la rama de Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultSocketPath, toEndpoint } from '../server/herdr.mjs';
import { isInsidePath, normalizePath, pathKey, pathVariants, realPath, samePath } from '../server/paths.mjs';
import { renameReplace } from '../server/atomic-rename.mjs';
import { openCommand } from '../server/platform.mjs';
import { GitWorkspaceProbe } from '../server/context/adapters/gitWorkspaceProbe.mjs';
import { readJSONFile } from '../server/safe-json-file.mjs';

test('en Windows el socket de Herdr es el named pipe cuyo nombre es la ruta de marca', () => {
  const marker = 'C:\\Users\\ana\\AppData\\Roaming\\herdr\\herdr.sock';
  assert.equal(toEndpoint(marker, 'win32'), `\\\\.\\pipe\\${marker}`);
  assert.equal(toEndpoint(`\\\\.\\pipe\\${marker}`, 'win32'), `\\\\.\\pipe\\${marker}`, 'un pipe ya explícito no se prefija dos veces');
  assert.equal(toEndpoint('/home/ana/.config/herdr/herdr.sock', 'linux'), '/home/ana/.config/herdr/herdr.sock');
  assert.equal(toEndpoint(undefined, 'win32'), undefined);
});

test('la ruta por defecto del socket sigue la convención de cada plataforma', () => {
  assert.equal(
    defaultSocketPath({ platform: 'win32', env: { APPDATA: 'C:\\Users\\ana\\AppData\\Roaming' }, home: 'C:\\Users\\ana' }),
    'C:\\Users\\ana\\AppData\\Roaming\\herdr\\herdr.sock',
  );
  assert.equal(
    defaultSocketPath({ platform: 'win32', env: {}, home: 'C:\\Users\\ana' }),
    'C:\\Users\\ana\\AppData\\Roaming\\herdr\\herdr.sock',
  );
  assert.equal(
    defaultSocketPath({ platform: 'linux', env: {}, home: '/home/ana' }),
    path.join('/home/ana', '.config', 'herdr', 'herdr.sock'),
  );
});

test('las rutas de Windows escritas de formas distintas son la misma carpeta', () => {
  assert.equal(normalizePath('C:/Users/ana/repo', 'win32'), 'C:\\Users\\ana\\repo');
  assert.equal(normalizePath('c:\\Users\\ana\\repo\\', 'win32'), 'C:\\Users\\ana\\repo');
  assert.equal(normalizePath('\\\\?\\C:\\Users\\ana\\repo', 'win32'), 'C:\\Users\\ana\\repo');
  assert.equal(normalizePath('\\\\?\\UNC\\srv\\share\\repo', 'win32'), '\\\\srv\\share\\repo');
  assert.equal(normalizePath('C:\\', 'win32'), 'C:\\');
  assert.ok(samePath('C:/Users/Ana/Repo', 'c:\\users\\ana\\repo\\', 'win32'));
  assert.ok(!samePath('C:\\Users\\ana\\repo', 'C:\\Users\\ana\\repo2', 'win32'));
});

test('en POSIX las rutas no se tocan y distinguen mayúsculas', () => {
  assert.equal(normalizePath('/tmp/A//b/', 'linux'), '/tmp/A//b/');
  assert.equal(pathKey('/tmp/A', 'linux'), '/tmp/A');
  assert.ok(!samePath('/tmp/a', '/tmp/A', 'linux'));
});

test('las variantes de una carpeta cubren cómo la guarda OpenCode (D:/x) y cómo la informa Herdr (D:\\x)', () => {
  assert.deepEqual(pathVariants('d:\\dev\\x\\', 'win32'), ['d:\\dev\\x\\', 'D:\\dev\\x', 'D:/dev/x']);
  assert.deepEqual(pathVariants('D:/dev/x', 'win32'), ['D:/dev/x', 'D:\\dev\\x']);
  assert.deepEqual(pathVariants('/home/ana/x', 'linux'), ['/home/ana/x']);
  assert.equal(pathKey('D:/dev/x', 'win32'), pathKey('D:\\dev\\x', 'win32'), 'ambas formas dan la misma clave de comparación');
});

test('isInsidePath exige frontera de directorio', () => {
  assert.ok(isInsidePath('C:\\repo', 'c:/REPO/src', 'win32'));
  assert.ok(isInsidePath('C:\\repo', 'C:\\repo', 'win32'));
  assert.ok(!isInsidePath('C:\\repo', 'C:\\repo-otro', 'win32'));
  assert.ok(isInsidePath('C:\\', 'C:\\repo', 'win32'));
  assert.ok(isInsidePath('/srv/repo', '/srv/repo/src', 'linux'));
  assert.ok(!isInsidePath('/srv/repo', '/srv/repo2', 'linux'));
});

test('cada plataforma abre el navegador con su orden, sin shell', () => {
  assert.deepEqual(openCommand('http://127.0.0.1:4700/', 'darwin'), ['open', ['http://127.0.0.1:4700/']]);
  assert.deepEqual(openCommand('http://127.0.0.1:4700/', 'linux'), ['xdg-open', ['http://127.0.0.1:4700/']]);
  assert.deepEqual(openCommand('http://127.0.0.1:4700/', 'win32'), ['rundll32', ['url.dll,FileProtocolHandler', 'http://127.0.0.1:4700/']]);
});

test('renameReplace reintenta solo los fallos transitorios de Windows', async () => {
  const transient = (code) => Object.assign(new Error(code), { code });
  let calls = 0;
  await renameReplace('a', 'b', {
    platform: 'win32', delayMs: 1,
    rename: async () => { if (++calls < 3) throw transient('EBUSY'); },
  });
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(renameReplace('a', 'b', {
    platform: 'linux', delayMs: 1, rename: async () => { calls++; throw transient('EPERM'); },
  }), { code: 'EPERM' });
  assert.equal(calls, 1, 'en POSIX un EPERM es real y no se reintenta');

  calls = 0;
  await assert.rejects(renameReplace('a', 'b', {
    platform: 'win32', delayMs: 1, attempts: 4, rename: async () => { calls++; throw transient('EPERM'); },
  }), { code: 'EPERM' });
  assert.equal(calls, 4, 'los reintentos están acotados');

  calls = 0;
  await assert.rejects(renameReplace('a', 'b', {
    platform: 'win32', delayMs: 1, rename: async () => { calls++; throw transient('ENOENT'); },
  }), { code: 'ENOENT' });
  assert.equal(calls, 1, 'un error que no es transitorio sale a la primera');
});

test('la sonda de git identifica un checkout aunque se llegue con otra escritura de la ruta', async () => {
  const root = await realPath(await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-path-test-')));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    await fsp.mkdir(path.join(root, 'src'));
    const probe = new GitWorkspaceProbe();
    const top = await probe.inspect(root);
    const nested = await probe.inspect(path.join(root, 'src'));
    assert.equal(top.checkoutPath, root);
    assert.equal(top.repoRoot, root);
    assert.equal(nested.checkoutPath, top.checkoutPath, 'un subdirectorio resuelve al mismo checkout');
    if (process.platform === 'win32') {
      const forward = await probe.inspect(root.replaceAll('\\', '/').toLowerCase());
      assert.equal(forward.checkoutPath, top.checkoutPath, 'barras y mayúsculas distintas no crean otro contexto');
    }
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('readJSONFile no sigue enlaces simbólicos en ninguna plataforma', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-link-test-'));
  try {
    const real = path.join(dir, 'real.json');
    const link = path.join(dir, 'link.json');
    await fsp.writeFile(real, '{"ok":true}');
    try { await fsp.symlink(real, link); }
    catch (error) {
      if (error.code === 'EPERM') return t.skip('Windows sin privilegio para crear enlaces simbólicos');
      throw error;
    }
    assert.deepEqual(await readJSONFile(real), { ok: true });
    await assert.rejects(readJSONFile(link), (error) => ['ELOOP', 'EMLINK'].includes(error.code));
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('Codex: el rollout se empareja con el pane aunque Herdr y Codex escriban el cwd de forma distinta', { skip: process.platform !== 'win32' && 'las variantes de ruta solo existen en Windows' }, async (t) => {
  const { CodexAdapter } = await import('../server/adapters/codex.mjs');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-codex-cwd-'));
  const adapter = new CodexAdapter({ get: () => ({ setStatus() {}, addRequest() {} }) }, () => {}, { roots: [root] });
  t.after(async () => { adapter.close(); await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const now = new Date();
  const day = path.join(root, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  await fsp.mkdir(day, { recursive: true });
  await fsp.writeFile(path.join(day, 'rollout-2026-09-20T10-00-00-codexsession1.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'codexsession1', cwd: '\\\\?\\d:\\Dev\\Proyecto' } })}\n`);
  const agents = [{ paneId: 'w1:p1', sessionId: null, cwd: 'D:/dev/proyecto' }];
  await adapter.sync(agents);
  for (let i = 0; i < 20 && !(await adapter.sync(agents)).size; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal((await adapter.sync(agents)).get('w1:p1'), 'codexsession1');
});
