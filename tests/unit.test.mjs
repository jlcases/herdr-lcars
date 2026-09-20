import test from 'node:test';
import assert from 'node:assert/strict';
import { costOf, priceFor } from '../server/pricing.mjs';
import { MAX_LOG_EVENTS, parseLogs } from '../server/otlp.mjs';
import { TelemetryStore } from '../server/telemetry.mjs';
import { isSafeSessionId } from '../server/identifiers.mjs';
import { otlpLog, apiRequest } from './helpers.mjs';

test('precios: Anthropic y resto de proveedores, con alias comodín', () => {
  assert.equal(priceFor('claude-opus-5').output, 25);
  assert.equal(priceFor('claude-fable-5-1').cacheRead, 0.25, 'Fable 5.1 lee caché a 0,25 $/M');
  assert.equal(priceFor('gpt-5.6-sol').output, 30);
  assert.ok(priceFor('accounts/fireworks/routers/kimi-k2p7-code-fast'), 'el id con proveedor delante debe resolver');
  assert.equal(priceFor('modelo-inventado-xyz'), null);
});

test('coste: la escritura de caché sin desglose se cobra como 5 minutos', () => {
  const c = costOf('claude-opus-5', { input_tokens: 1e6, output_tokens: 0, cache_creation_input_tokens: 1e6 });
  assert.equal(c, 5 + 6.25);
});

test('OTLP: una marca de tiempo "0" no ancla el evento en 1970', () => {
  const now = Date.now();
  const [ev] = parseLogs({ resourceLogs: [{ resource: {}, scopeLogs: [{ logRecords: [{ timeUnixNano: '0', attributes: [{ key: 'event.name', value: { stringValue: 'api_request' } }] }] }] }] });
  assert.ok(ev.ts >= now, 'debe caer a la hora actual');
});

test('OTLP: limita lotes, profundidad y texto antes de crear telemetría', () => {
  const records = Array.from({ length: MAX_LOG_EVENTS + 25 }, () => ({
    attributes: [{ key: 'event.name', value: { stringValue: 'x'.repeat(5000) } }],
  }));
  const parsed = parseLogs({ resourceLogs: [null, { scopeLogs: [{ logRecords: records }] }] });
  assert.equal(parsed.length, MAX_LOG_EVENTS);
  assert.equal(parsed[0].name.length, 4096);
  let nested = { stringValue: 'fin' };
  for (let i = 0; i < 20; i++) nested = { arrayValue: { values: [nested] } };
  assert.doesNotThrow(() => parseLogs({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: nested }] }] }] }));
  const [pollution] = parseLogs({ resourceLogs: [{ scopeLogs: [{ logRecords: [{
    attributes: [{ key: '__proto__', value: { kvlistValue: { values: [{ key: 'session.id', value: { stringValue: 'attacker' } }] } } }],
  }] }] }] });
  assert.equal(Object.getPrototypeOf(pollution.attrs), null);
  assert.equal(pollution.attrs['session.id'], undefined);
});

test('identificadores y almacén: bloquean rutas, claves de prototipo y cardinalidad hostil', () => {
  assert.equal(isSafeSessionId('session_ok-1'), true);
  for (const value of ['../escape', '__proto__', 'constructor', 'a/b', '']) assert.equal(isSafeSessionId(value), false, value);
  const store = new TelemetryStore({ maxSessions: 2 });
  for (const sid of ['s1', 's2', 's3']) {
    store.ingestLogEvents(parseLogs(apiRequest({ 'session.id': sid, output_tokens: 1 })));
  }
  assert.equal(store.sessions.size, 2, 'OTLP no crea sesiones sin límite');
  assert.equal(store.has('s3'), false, 'la sesión que excede el cupo se descarta');
  assert.throws(() => store.get('__proto__'), /sessionId no valido/);
});

test('telemetría: las herramientas no se inflan al repetirse la misma entrega', () => {
  const store = new TelemetryStore();
  const s = store.get('s1');
  for (const pass of [0, 1]) {
    assert.equal(s.addTurn('turno-1'), pass === 0, 'el turno solo cuenta una vez');
    s.addTool({ key: 'toolu_a', name: 'Bash' });
    s.addTool({ key: 'toolu_b', name: 'Read' });
  }
  assert.equal(s.totals.turns, 1);
  assert.equal(s.tools.count, 2);
  assert.deepEqual([...s.tools.byName.entries()], [['Bash', 1], ['Read', 1]]);
});

test('telemetría: OTLP sustituye a la estimación del transcript sin sumar dos veces', () => {
  const store = new TelemetryStore();
  const s = store.get('s2');
  s.addRequest({ ts: Date.now(), requestId: 'req_1', model: 'claude-opus-5', input: 10, output: 100, durationMs: 5000, ttftMs: null, approx: true }, 'transcript');
  assert.equal(s.totals.requests, 1);
  store.ingestLogEvents(parseLogs(apiRequest({ 'session.id': 's2', request_id: 'req_1', model: 'claude-opus-5', input_tokens: 10, output_tokens: 100, duration_ms: 5000, ttft_ms: 800 })));
  assert.equal(s.totals.requests, 1, 'sigue siendo una petición');
  assert.equal(s.source, 'otlp');
  assert.equal(s.requests.at(-1).ttftMs, 800, 'gana el dato medido');
  assert.equal(s.totals.output, 100, 'los tokens no se duplican');
});

test('telemetría: un fallo se cuenta una vez y el reemplazo lo descuenta', () => {
  const store = new TelemetryStore();
  const s = store.get('s3');
  store.ingestLogEvents(parseLogs(apiRequest({ 'session.id': 's3', request_id: 'req_e', model: 'claude-opus-5', success: 'false', output_tokens: 1 })));
  assert.equal(s.totals.errors, 1);
  store.ingestLogEvents(parseLogs(otlpLog('api_error', { 'session.id': 's3' })));
  assert.equal(s.totals.errors, 1, 'api_error solo anuncia; no vuelve a contar');
});

test('telemetría: se olvidan las sesiones sin agente vivo', () => {
  const store = new TelemetryStore();
  const viva = store.get('viva'); const muerta = store.get('muerta');
  viva.lastActivity = Date.now(); muerta.firstSeen = Date.now() - 3600_000; muerta.lastActivity = Date.now() - 3600_000;
  store.evict(new Set(['viva']), 30 * 60_000);
  assert.ok(store.has('viva'));
  assert.ok(!store.has('muerta'));
});

test('telemetría: una cuota antigua nunca pisa la observación más reciente', () => {
  const store = new TelemetryStore();
  const session = store.get('quota-order');
  const newer = Date.now();
  session.setRateLimits({ source: 'codex', primary: { used_percentage: 8, window_minutes: 10_080 } }, newer);
  session.setRateLimits({ source: 'codex', primary: { used_percentage: 7, window_minutes: 10_080 } }, newer - 60_000);
  assert.equal(session.rateLimits.primary.used_percentage, 8);
  assert.equal(session.rateLimitsAt, newer);
});

test('telemetría: la velocidad ignora las peticiones auxiliares', () => {
  // La clasificación se hace al ingresar, no al leer: cada fuente dice qué es cada petición.
  const store = new TelemetryStore();
  store.ingestLogEvents(parseLogs(apiRequest({ 'session.id': 's4', request_id: 'a', model: 'claude-opus-5', output_tokens: 1000, duration_ms: 11000, ttft_ms: 1000, query_source: 'repl_main_thread' })));
  store.ingestLogEvents(parseLogs(apiRequest({ 'session.id': 's4', request_id: 'b', model: 'claude-opus-5', output_tokens: 10, duration_ms: 10000, ttft_ms: 5000, query_source: 'generate_session_title' })));
  const s = store.get('s4');
  assert.equal(s.requests.map((r) => r.kind).join(','), 'main,aux');
  assert.equal(s.recent().sample, 1, 'solo cuenta el hilo principal');
  assert.equal(Math.round(s.recent().tokPerSecP50), 100, 'tok/s descuenta el TTFT');
});

test('telemetría: un subagente OTLP se atribuye a su nombre', () => {
  const store = new TelemetryStore();
  store.ingestLogEvents(parseLogs(apiRequest({ 'session.id': 's5', request_id: 'x', model: 'claude-opus-5', output_tokens: 300, duration_ms: 4000, ttft_ms: 1000, query_source: 'agent:builtin:Explore' })));
  const s = store.get('s5');
  assert.equal(s.requests[0].kind, 'subagent');
  assert.deepEqual(s.byAgent().map((b) => [b.name, b.requests]), [['Explore', 1]]);
});

test('telemetría: la fuente de mayor rango decide etiqueta y exactitud', () => {
  const store = new TelemetryStore();
  const s = store.get('s6');
  s.addRequest({ ts: Date.now(), requestId: 'r', model: 'claude-opus-5', output: 10, kind: 'main' }, 'transcript');
  assert.equal(s.toJSON().approx, true);
  assert.equal(s.toJSON().sourceLabel, 'transcript ~');
  assert.ok(store.accepts('s6', 'transcript'), 'aún no hay nada mejor');
  store.ingestLogEvents(parseLogs(apiRequest({ 'session.id': 's6', request_id: 'r2', model: 'claude-opus-5', output_tokens: 10 })));
  assert.equal(s.toJSON().approx, false);
  assert.equal(store.accepts('s6', 'transcript'), false, 'el transcript ya no aporta');
});

test('telemetría: el coste resuelto distingue medido de estimado', () => {
  const store = new TelemetryStore();
  const s = store.get('s7');
  s.addRequest({ ts: Date.now(), requestId: 'a', model: 'claude-opus-5', output: 1e6, kind: 'main' }, 'transcript');
  assert.equal(s.toJSON().costBasis, 'estimate');
  assert.equal(s.toJSON().costUsd, 25, 'tarifa de salida de Opus 5');
  const s2 = store.get('s8');
  s2.addRequest({ ts: Date.now(), requestId: 'b', model: 'x', output: 5, costUsd: 1.5, kind: 'main' }, 'opencode');
  assert.equal(s2.toJSON().costBasis, 'reported');
  assert.equal(s2.toJSON().costUsd, 1.5);
});
