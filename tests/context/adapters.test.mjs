import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { FileContextRepository } from '../../server/context/adapters/fileContextRepository.mjs';
import { GitWorkspaceProbe, parsePorcelainV2 } from '../../server/context/adapters/gitWorkspaceProbe.mjs';
import { codexThreadSource } from '../../server/context/adapters/threadSources.mjs';
import { emptyRecord } from '../../server/context/domain/record.mjs';
import { contextIdOf } from '../../server/context/domain/ids.mjs';
import { tailJsonl } from '../../server/jsonl.mjs';
import { expectMode } from '../helpers.mjs';

const digest = (id) => createHash('sha256').update(id).digest('base64url');
const legacySlug = (id) => Buffer.from(id).toString('base64url').slice(0, 80);

test('git: porcelain v2 conserva la primera letra, espacios, renombres y conflictos', () => {
  const raw = [
    '# branch.oid abcdef', '# branch.head main',
    '1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb README.md',
    '? package.json',
    '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 nuevo nombre.js', 'viejo nombre.js',
    'u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc conflicto con espacios.js', '',
  ].join('\0');
  const parsed = parsePorcelainV2(raw);
  assert.equal(parsed.branch, 'main');
  assert.equal(parsed.head, 'abcdef');
  assert.deepEqual(parsed.files.map((file) => file.path), [
    'README.md', 'package.json', 'nuevo nombre.js', 'conflicto con espacios.js',
  ]);
  assert.equal(parsed.files[2].previousPath, 'viejo nombre.js');
});

test('git: el adaptador real obtiene rutas exactas con una sola fotografía', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-git-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'LCARS Test'], { cwd: root });
  await fsp.writeFile(path.join(root, 'README.md'), 'uno\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'inicio'], { cwd: root });
  await fsp.writeFile(path.join(root, 'README.md'), 'dos\n');
  await fsp.mkdir(path.join(root, 'server'));
  await fsp.writeFile(path.join(root, 'server', 'archivo con espacios.mjs'), 'export {}\n');
  const snapshot = await new GitWorkspaceProbe().inspect(path.join(root, 'server'));
  assert.equal(snapshot.checkoutPath, await fsp.realpath(root));
  assert.deepEqual(snapshot.files.map((file) => file.path).sort(), ['README.md', 'server/archivo con espacios.mjs']);
  assert.match(snapshot.dirty, /README\.md/);
  assert.ok(snapshot.fingerprint);
});

test('repositorio: escrituras concurrentes son atómicas y no pierden actualizaciones', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-context-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const repository = new FileContextRepository(dir);
  const workspace = { repoRoot: '/repo', branch: 'main', checkoutPath: '/repo' };
  const id = contextIdOf(workspace);
  const options = { workspace, create: () => emptyRecord(id, workspace) };
  await Promise.all(Array.from({ length: 20 }, (_, index) => repository.update(id, options, async (record) => {
    await new Promise((resolve) => setTimeout(resolve, index % 3));
    record.decisions.push({ at: index + 1, text: `d${index}`, by: null });
    record.events += 1;
    return record;
  })));
  const record = await repository.load(id, { workspace });
  assert.equal(record.decisions.length, 20);
  assert.equal(record.events, 20);
  const files = (await fsp.readdir(dir)).filter((file) => file.endsWith('.json'));
  assert.equal(files.length, 1);
  expectMode(await fsp.stat(dir), 0o700);
  expectMode(await fsp.stat(path.join(dir, files[0])), 0o600);
  assert.equal((await fsp.readdir(dir)).some((file) => file.endsWith('.tmp') || file.endsWith('.lock')), false);
});

test('repositorio: IDs con prefijo largo común no colisionan', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-keys-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const repository = new FileContextRepository(dir);
  const prefix = `ctx:v2:${'x'.repeat(200)}`;
  const ids = [`${prefix}:uno`, `${prefix}:dos`];
  await Promise.all(ids.map((id, index) => repository.update(id, {
    create: () => emptyRecord(id, { checkoutPath: `/repo/${index}` }),
  }, (record) => ({ ...record, goal: { text: `goal-${index}`, at: 1, by: null } }))));
  assert.equal((await repository.load(ids[0])).goal.text, 'goal-0');
  assert.equal((await repository.load(ids[1])).goal.text, 'goal-1');
  assert.equal((await fsp.readdir(dir)).filter((file) => file.endsWith('.json')).length, 2);
});

test('repositorio: migra narrativa antigua, descarta mecánica no fiable y falla ante corrupción', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-migrate-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const workspace = { repoRoot: '/repo', branch: 'main', checkoutPath: '/worktree' };
  const id = contextIdOf(workspace);
  const alias = '/repo#main';
  await fsp.writeFile(path.join(dir, `${legacySlug(alias)}.json`), JSON.stringify({
    contextId: alias, checkoutPath: '/worktree', goal: { text: 'seguir', at: 1 }, files: [{ path: 'EADME.md' }], events: 4,
  }));
  const repository = new FileContextRepository(dir);
  const migrated = await repository.load(id, { aliases: [alias], workspace });
  assert.equal(migrated.goal.text, 'seguir');
  assert.equal(migrated.files.length, 0);
  assert.equal(migrated.historyIncomplete, true);
  await repository.update(id, { aliases: [alias], workspace, create: () => emptyRecord(id, workspace) }, () => null);
  assert.ok((await fsp.readdir(dir)).includes(`${digest(id)}.json`), 'la lectura antigua queda consolidada con clave fuerte');

  const otherWorkspace = { ...workspace, checkoutPath: '/otro-worktree' };
  const otherId = contextIdOf(otherWorkspace);
  assert.equal(await repository.load(otherId, { aliases: [alias], workspace: otherWorkspace }), null,
    'una clave antigua ambigua no cruza datos entre worktrees');

  const corruptId = 'ctx:v2:corrupt';
  await fsp.writeFile(path.join(dir, `${digest(corruptId)}.json`), '{no-json');
  await assert.rejects(repository.load(corruptId), (error) => error.code === 'CONTEXT_CORRUPT');

  const invalidId = 'ctx:v2:invalid-schema';
  const invalid = { ...emptyRecord(invalidId), decisions: 'esto no es una lista' };
  await fsp.writeFile(path.join(dir, `${digest(invalidId)}.json`), JSON.stringify({
    storeVersion: 1, revision: 1, contextId: invalidId, record: invalid,
  }));
  await assert.rejects(repository.load(invalidId), (error) => error.code === 'CONTEXT_CORRUPT');
});

test('JSONL: conserva una fila parcial y descarta una fila hostil sin bloquear el seguidor', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-jsonl-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'stream.jsonl');
  await fsp.writeFile(file, '{"a":1}\n{"b"');
  const seen = [];
  let result = await tailJsonl(file, 0, (value) => seen.push(value));
  assert.deepEqual(seen, [{ a: 1 }]);
  assert.equal(result.offset, Buffer.byteLength('{"a":1}\n'));
  await fsp.appendFile(file, ':2}\n');
  result = await tailJsonl(file, result.offset, (value) => seen.push(value));
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);

  const hostile = path.join(dir, 'hostile.jsonl');
  await fsp.writeFile(hostile, `${'x'.repeat(8 * 1024 * 1024 + 1)}\n{"ok":true}\n`);
  const safe = [];
  const skipped = await tailJsonl(hostile, 0, (value) => safe.push(value));
  assert.deepEqual(safe, [{ ok: true }]);
  assert.equal(skipped.offset, (await fsp.stat(hostile)).size);
});

test('hilos: Codex lee solo la cola acotada y emite claves estables', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-thread-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const previous = process.env.LCARS_CODEX_SESSIONS;
  t.after(() => { if (previous == null) delete process.env.LCARS_CODEX_SESSIONS; else process.env.LCARS_CODEX_SESSIONS = previous; });
  process.env.LCARS_CODEX_SESSIONS = root;
  const sessionId = 'session-tail-1234';
  const file = path.join(root, `rollout-${sessionId}.jsonl`);
  const old = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'demasiado antiguo' }] } });
  const recent = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'respuesta reciente' }] } });
  await fsp.writeFile(file, `${old}\n${'x'.repeat(8 * 1024 * 1024 + 100)}\n${recent}\n`);
  const thread = await codexThreadSource.read(sessionId);
  assert.deepEqual(thread.turns.map((turn) => turn.text), ['respuesta reciente']);
  assert.match(thread.turns[0].sourceKey, /rollout-session-tail-1234\.jsonl:\d+/);
});
