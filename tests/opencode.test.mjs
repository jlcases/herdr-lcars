// Adaptador de OpenCode con una base SQLite real y pequeña (sin depender del binario `sqlite3`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const sqlite = await import('node:sqlite').then((m) => m, () => null);

test('OpenCode: empareja el pane por directorio (D:/x vs D:\\x) y lee coste real con node:sqlite', { skip: !sqlite && 'node:sqlite no disponible en este Node' }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-opencode-'));
  const dbFile = path.join(dir, 'opencode.db');
  process.env.OPENCODE_DB = dbFile;
  const now = Date.now();
  // OpenCode guarda `D:/dev/proyecto` aunque Herdr informe `D:\dev\proyecto`.
  const stored = process.platform === 'win32' ? 'D:/dev/proyecto' : '/srv/proyecto';
  const reported = process.platform === 'win32' ? 'D:\\dev\\proyecto' : '/srv/proyecto';

  const db = new sqlite.DatabaseSync(dbFile);
  db.exec(`
    create table session (id text primary key, directory text, parent_id text, time_updated integer);
    create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
    create table part (id text primary key, message_id text, data text);
  `);
  db.prepare('insert into session values (?, ?, null, ?)').run('ses_test1', stored, now);
  db.prepare('insert into message values (?, ?, ?, ?, ?)').run('msg_user', 'ses_test1', now - 5000, now - 5000, JSON.stringify({ role: 'user' }));
  db.prepare('insert into message values (?, ?, ?, ?, ?)').run('msg_asst', 'ses_test1', now - 4000, now - 1000, JSON.stringify({
    role: 'assistant', modelID: 'gpt-x', cost: 0.5, finish: 'stop',
    tokens: { input: 100, output: 40, reasoning: 0, cache: { read: 10, write: 0 } },
    time: { created: now - 4000, completed: now - 1000 },
  }));
  db.prepare('insert into part values (?, ?, ?)').run('prt_1', 'msg_asst', JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed' } }));
  db.close();

  const requests = [], tools = [];
  const store = { get: () => ({ addTurn: () => true, addRequest: (r) => requests.push(r), addTool: (x) => tools.push(x) }) };
  const { OpenCodeAdapter } = await import('../server/adapters/opencode.mjs');
  const adapter = new OpenCodeAdapter(store, () => {});
  t.after(async () => { adapter.close(); delete process.env.OPENCODE_DB; await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const want = await adapter.sync([{ paneId: 'w1:p1', sessionId: null, cwd: reported }]);
  assert.equal(want.get('w1:p1'), 'ses_test1', 'el directorio se empareja aunque la barra sea distinta');
  for (let i = 0; i < 40 && !requests.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].costUsd, 0.5, 'coste medido por OpenCode, no estimado');
  assert.equal(requests[0].output, 40);
  assert.deepEqual(tools.map((x) => x.name), ['bash']);
});
