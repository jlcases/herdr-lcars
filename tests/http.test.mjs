// Pruebas de la superficie HTTP: este servidor expone el contenido de los terminales,
// así que lo importante es que no sea alcanzable desde una página cualquiera del navegador.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer, assertLoopbackHost, sameOrigin } from '../server/index.mjs';
import { apiRequest } from './helpers.mjs';

let app, base, testRoot;
const quiet = { info() {}, warn() {}, error() {} };
const noClaudeUsage = () => ({ start() {}, close() {} });

before(async () => {
  testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-http-test-'));
  app = await startServer({
    port: 0, host: '127.0.0.1', socketPath: '/tmp/lcars-no-existe.sock', log: quiet,
    statusDir: path.join(testRoot, 'status'),
    claudeUsageFactory: noClaudeUsage,
  });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  app?.close();
  if (testRoot) await fsp.rm(testRoot, { recursive: true, force: true });
});

test('una petición cross-origin se rechaza y no filtra terminales', async () => {
  for (const p of ['/api/state', '/api/read?pane_id=w1:p1', '/api/session?id=x', '/events']) {
    const r = await fetch(base + p, { headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403, p);
    assert.equal(r.headers.get('access-control-allow-origin'), null, `${p} no debe llevar CORS abierto`);
  }
});

test('el mismo origen sí pasa', async () => {
  const r = await fetch(base + '/api/state', { headers: { Origin: base } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.herdr.ok, false, 'sin socket de Herdr el enlace se reporta caído');
});

test('ninguna respuesta lleva cabecera CORS abierta', async () => {
  const r = await fetch(base + '/api/state');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(r.headers.get('content-security-policy'), /style-src-attr 'unsafe-inline'/);
  assert.doesNotMatch(r.headers.get('content-security-policy'), /style-src 'self' 'unsafe-inline'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
});

test('solo loopback puede ser autoridad o interfaz de escucha', async () => {
  assert.doesNotThrow(() => assertLoopbackHost('::1'));
  assert.throws(() => assertLoopbackHost('0.0.0.0'), /solo puede escuchar en loopback/);
  assert.equal(sameOrigin({ headers: { host: 'evil.example:4700' } }), false);
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:4700', origin: 'http://localhost:4700' } }), true);
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:4700', origin: 'https://localhost:4700' } }), false);
  await assert.rejects(startServer({ port: 0, host: '0.0.0.0', log: quiet }), (error) => error.status === 400);
});

test('una cabecera Host externa se rechaza aunque no haya Origin', async () => {
  const target = new URL(base);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: target.hostname, port: target.port, path: '/api/state', headers: { host: 'attacker.example' } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
});

test('/api/focus rechaza el cuerpo «simple» que evita el preflight', async () => {
  const r = await fetch(base + '/api/focus', { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: '{"pane_id":"w1:p1"}' });
  assert.equal(r.status, 415);
});

test('/api/focus cross-origin se rechaza aunque mande JSON', async () => {
  const r = await fetch(base + '/api/focus', { method: 'POST', headers: { 'content-type': 'application/json', Origin: 'https://evil.example' }, body: '{"pane_id":"w1:p1"}' });
  assert.equal(r.status, 403);
});

test('los endpoints de control rechazan JSON roto y cuerpos mayores de 64 KiB', async () => {
  const broken = await fetch(base + '/api/focus', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(broken.status, 400);
  const oversized = await fetch(base + '/api/focus', { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.alloc(70 * 1024, 0x20) });
  assert.equal(oversized.status, 413);
});

test('/api/remember no permite sondear un directorio ajeno a agentes activos', async () => {
  const r = await fetch(base + '/api/remember', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: '/etc', goal: 'leer' }) });
  assert.equal(r.status, 404);
});

test('el parámetro lines se acota y nunca se convierte en «sin límite»', async () => {
  // Sin Herdr el socket falla, pero el error llega después de validar: basta con que no sea un 4xx de validación.
  for (const q of ['lines=abc', 'lines=-5', 'lines=1e9']) {
    const r = await fetch(`${base}/api/read?pane_id=w1:p1&${q}`);
    const body = await r.json();
    assert.ok(!/expected u32|integer -5/.test(body.error || ''), `${q} no debe llegar crudo a Herdr: ${body.error}`);
  }
});

test('un cuerpo comprimido desmesurado no tumba el proceso', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(200 * 1024 * 1024, 0));
  const r = await fetch(base + '/v1/logs', { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: bomb });
  assert.ok(r.status >= 400, 'debe rechazarse por el tope de descompresión');
  const still = await fetch(base + '/api/state');
  assert.equal(still.status, 200, 'el servidor sigue atendiendo');
});

test('OTLP sigue entrando sin cabecera Origin', async () => {
  const rec = apiRequest({ 'session.id': 'sesion-de-prueba', model: 'claude-opus-5', output_tokens: 42, 'user.email': 'nadie@example.com' });
  const r = await fetch(base + '/v1/logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).accepted, 1);
  const s = await (await fetch(`${base}/api/session?id=sesion-de-prueba`)).json();
  assert.equal(s.totals.output, 42);
  const raw = JSON.stringify(s);
  assert.ok(!raw.includes('nadie@example.com'), 'los atributos OTLP crudos no deben salir al cliente');
  assert.ok(!raw.includes('user.account_uuid') && !raw.includes('rawLog'));
});

test('OTLP rechaza IDs que podrían contaminar objetos del estado', async () => {
  const rec = apiRequest({ 'session.id': '__proto__', output_tokens: 99 });
  const r = await fetch(base + '/v1/logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).accepted, 0);
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(Object.hasOwn(state.sessions, '__proto__'), false);
});
