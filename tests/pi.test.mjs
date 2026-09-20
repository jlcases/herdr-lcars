import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentSessionRef } from '../server/agent-session-ref.mjs';
import { PiAdapter, inspectPiSessionFile } from '../server/adapters/pi.mjs';
import { TelemetryStore } from '../server/telemetry.mjs';
import { symlinkOrSkip } from './helpers.mjs';

const writeJsonl = (file, rows) => fsp.writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
const sessionRow = (id, cwd) => ({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd });

test('referencia de sesión: conserva rutas absolutas de Pi sin confundirlas con ids', () => {
  assert.deepEqual(agentSessionRef({ kind: 'id', value: 'session_ok-1' }), { kind: 'id', value: 'session_ok-1' });
  assert.deepEqual(agentSessionRef({ kind: 'path', value: '/home/ana/.pi/agent/sessions/a.jsonl' }, 'linux'), {
    kind: 'path', value: '/home/ana/.pi/agent/sessions/a.jsonl',
  });
  assert.deepEqual(agentSessionRef({ kind: 'path', value: 'C:\\Users\\ana\\.pi\\agent\\sessions\\a.jsonl' }, 'win32'), {
    kind: 'path', value: 'C:\\Users\\ana\\.pi\\agent\\sessions\\a.jsonl',
  });
});

test('referencia de sesión: rechaza ids, rutas relativas, NUL y objetos hostiles', () => {
  for (const value of [
    null, [], { kind: 'id', value: '../escape' }, { kind: 'path', value: 'relative.jsonl' },
    { kind: 'path', value: '/tmp/a\0b.jsonl' }, { kind: 'path', value: `/tmp/${'x'.repeat(5000)}` },
  ]) assert.equal(agentSessionRef(value, 'linux'), null);
});

test('Pi: ingiere su JSONL nativo, modelo local, contexto, tools, coste y tiempos', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-pi-happy-'));
  const sessions = path.join(dir, 'sessions');
  const project = path.join(dir, 'project');
  const bucket = path.join(sessions, 'project');
  const file = path.join(bucket, '2026-09-20_pi-session-1.jsonl');
  const modelsFile = path.join(dir, 'models.json');
  await fsp.mkdir(bucket, { recursive: true });
  await fsp.mkdir(project);
  await fsp.writeFile(modelsFile, JSON.stringify({ providers: { mlx: {
    baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'must-never-leak', models: [{
      id: 'mlx-community/Qwen', name: 'Qwen local', contextWindow: 1000, maxTokens: 200,
    }],
  } } }));
  const started = Date.now() - 5000;
  await writeJsonl(file, [
    sessionRow('pi-session-1', project),
    { type: 'model_change', id: 'model-1', timestamp: new Date(started).toISOString(), provider: 'mlx', modelId: 'mlx-community/Qwen' },
    { type: 'message', id: 'user-1', timestamp: new Date(started + 10).toISOString(), message: { role: 'user', timestamp: started + 10, content: 'secreto que no debe salir' } },
    { type: 'message', id: 'assistant-1', timestamp: new Date(started + 1010).toISOString(), message: {
      role: 'assistant', provider: 'mlx', model: 'mlx-community/Qwen', responseId: 'response-1',
      timestamp: started + 10, stopReason: 'toolUse',
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 5, totalTokens: 120,
        cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
    } },
    { type: 'message', id: 'tool-1', timestamp: new Date(started + 1110).toISOString(), message: {
      role: 'toolResult', toolCallId: 'call-1', toolName: 'read', isError: false, timestamp: started + 1110, content: 'otro secreto',
    } },
    { type: 'message', id: 'assistant-2', timestamp: new Date(started + 2110).toISOString(), message: {
      role: 'assistant', provider: 'mlx', model: 'mlx-community/Qwen', responseId: 'response-2',
      timestamp: started + 1110, stopReason: 'stop',
      usage: { input: 20, output: 30, cacheRead: 100, cacheWrite: 0, reasoning: 2, totalTokens: 150,
        cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 } },
    } },
  ]);

  const store = new TelemetryStore(), events = [];
  const adapter = new PiAdapter(store, (event) => events.push(event), { roots: [sessions], modelsFile, pollMs: 60_000 });
  t.after(async () => { adapter.close(); await fsp.rm(dir, { recursive: true, force: true }); });
  const resolved = await adapter.sync([{ paneId: 'w1:p1', sessionId: null, sessionPath: file, cwd: project }]);
  assert.equal(resolved.get('w1:p1'), 'pi-session-1');
  const telemetry = store.get('pi-session-1').toJSON();
  assert.equal(telemetry.source, 'pi');
  assert.equal(telemetry.sourceLabel, 'pi');
  assert.equal(telemetry.model, 'mlx-community/Qwen');
  assert.equal(telemetry.provider, 'mlx');
  assert.equal(telemetry.local, true);
  assert.deepEqual(telemetry.totals, {
    input: 120, output: 50, cacheRead: 100, cacheWrite: 0, costUsd: 0.03, requests: 2, errors: 0, turns: 1,
  });
  assert.equal(telemetry.costBasis, 'reported');
  assert.equal(telemetry.tools.count, 1);
  assert.deepEqual(telemetry.tools.top, [['read', 1]]);
  assert.equal(telemetry.context.size, 1000);
  assert.equal(telemetry.context.usedPercent, 15);
  assert.equal(telemetry.recent.durationP50, 1000);
  assert.equal(events.length, 0, 'la carga histórica no fabrica eventos en vivo');
  assert.doesNotMatch(JSON.stringify(telemetry), /must-never-leak|secreto/);
});

test('Pi: falla cerrado ante rutas externas, cwd distinto, enlaces y cabeceras rotas', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-pi-hostile-'));
  const root = path.join(dir, 'sessions');
  const outside = path.join(dir, 'outside.jsonl');
  const wrong = path.join(root, 'wrong.jsonl');
  const broken = path.join(root, 'broken.jsonl');
  const link = path.join(root, 'link.jsonl');
  await fsp.mkdir(root);
  await writeJsonl(outside, [sessionRow('outside-1', dir)]);
  await writeJsonl(wrong, [sessionRow('wrong-1', path.join(dir, 'other'))]);
  await fsp.writeFile(broken, '{not-json}\n');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  await assert.rejects(inspectPiSessionFile(outside, { roots: [root], cwd: dir }), { code: 'PI_PATH_OUTSIDE_ROOT' });
  await assert.rejects(inspectPiSessionFile(wrong, { roots: [root], cwd: dir }), { code: 'PI_CWD_MISMATCH' });
  await assert.rejects(inspectPiSessionFile(broken, { roots: [root], cwd: dir }), { code: 'PI_INVALID_HEADER' });
  if (await symlinkOrSkip(t, outside, link)) {
    await assert.rejects(inspectPiSessionFile(link, { roots: [root], cwd: dir }), (error) => ['ELOOP', 'EMLINK'].includes(error.code));
  }

  const store = new TelemetryStore(), warnings = [];
  const adapter = new PiAdapter(store, (event) => warnings.push(event), {
    roots: [root], modelsFile: path.join(dir, 'missing-models.json'), pollMs: 60_000,
  });
  t.after(() => adapter.close());
  const result = await adapter.sync([{ paneId: 'w1:p1', sessionId: null, sessionPath: outside, cwd: dir }]);
  assert.equal(result.get('w1:p1'), null, 'una referencia inválida revoca cualquier resolución anterior');
  assert.equal(store.sessions.size, 0);
  assert.ok(warnings.some((event) => event.kind === 'warn' && /PI_PATH_OUTSIDE_ROOT/.test(event.message)));
});

test('Pi: los fallos con uso cero se ven como errores, nunca como contexto 0 % inventado', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-pi-error-'));
  const root = path.join(dir, 'sessions');
  const project = path.join(dir, 'project');
  const file = path.join(root, 'pi-error-1.jsonl');
  await fsp.mkdir(root); await fsp.mkdir(project);
  await writeJsonl(file, [sessionRow('pi-error-1', project), {
    type: 'model_change', id: 'model', provider: 'mlx', modelId: 'local-model', timestamp: new Date().toISOString(),
  }]);
  const store = new TelemetryStore(), events = [];
  const adapter = new PiAdapter(store, (event) => events.push(event), {
    roots: [root], modelsFile: path.join(dir, 'missing-models.json'), pollMs: 60_000,
  });
  t.after(async () => { adapter.close(); await fsp.rm(dir, { recursive: true, force: true }); });
  await adapter.sync([{ paneId: 'w1:p1', sessionId: null, sessionPath: file, cwd: project }]);
  await fsp.appendFile(file, `${JSON.stringify({
    type: 'message', id: 'failed-1', timestamp: new Date().toISOString(), message: {
      role: 'assistant', provider: 'mlx', model: 'local-model', timestamp: Date.now() - 250,
      stopReason: 'error', errorMessage: 'Connection error.',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  })}\n`);
  await adapter.poll();
  const telemetry = store.get('pi-error-1').toJSON();
  assert.equal(telemetry.totals.requests, 1);
  assert.equal(telemetry.totals.errors, 1);
  assert.equal(telemetry.context, null);
  assert.ok(events.some((event) => event.kind === 'api_error' && event.error === 'Connection error.'));
});

test('Pi: resuelve por id dentro de la raíz cuando Herdr no puede entregar la ruta', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-pi-id-'));
  const root = path.join(dir, 'sessions');
  const project = path.join(dir, 'project');
  const bucket = path.join(root, 'encoded-project');
  const file = path.join(bucket, '2026-09-20_pi-by-id-1.jsonl');
  await fsp.mkdir(bucket, { recursive: true }); await fsp.mkdir(project);
  await writeJsonl(file, [sessionRow('pi-by-id-1', project)]);
  const adapter = new PiAdapter(new TelemetryStore(), () => {}, {
    roots: [root], modelsFile: path.join(dir, 'missing-models.json'), pollMs: 60_000,
  });
  t.after(async () => { adapter.close(); await fsp.rm(dir, { recursive: true, force: true }); });
  const result = await adapter.sync([{ paneId: 'w1:p1', sessionId: 'pi-by-id-1', sessionPath: null, cwd: project }]);
  assert.equal(result.get('w1:p1'), 'pi-by-id-1');
});
