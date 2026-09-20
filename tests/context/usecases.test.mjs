import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextGateway } from '../../server/context/usecases/contextGateway.mjs';
import { IngestActivity } from '../../server/context/usecases/ingestActivity.mjs';
import { Remember } from '../../server/context/usecases/remember.mjs';
import { DescribeContext } from '../../server/context/usecases/describeContext.mjs';
import { HandOff } from '../../server/context/usecases/handOff.mjs';
import { ThreadSourceRegistry } from '../../server/context/registry.mjs';
import { contextIdOf } from '../../server/context/domain/ids.mjs';
import { requirePort } from '../../server/context/ports.mjs';
import {
  FakeClock, FakeIdGenerator, InMemoryContextRepository, FakeWorkspaceProbe, FakeAgentRuntime,
  FakeEngineCatalog, FakeAccountProfileCatalog, fakeThreadSource,
} from './fakes.mjs';

function build({ workspace, commits, threads = [], kinds } = {}) {
  const repository = new InMemoryContextRepository();
  const probe = new FakeWorkspaceProbe(workspace, commits);
  const clock = new FakeClock();
  const gateway = new ContextGateway({ repository, probe, clock });
  const runtime = new FakeAgentRuntime();
  const engines = new FakeEngineCatalog(kinds);
  const profiles = new FakeAccountProfileCatalog();
  const ids = new FakeIdGenerator();
  return {
    repository, probe, clock, gateway, runtime, engines, ids,
    ingest: new IngestActivity({ gateway }),
    remember: new Remember({ gateway }),
    describe: new DescribeContext({ gateway }),
    handOff: new HandOff({ gateway, runtime, engines, profiles, ids, threads: new ThreadSourceRegistry(threads) }),
  };
}

const AGENT = { agent: 'claude', paneId: 'w1:p1', cwd: '/repo', sessionId: 'session-1' };
const dirty = (probe, path = 'a.js') => probe.setSnapshot({ files: [{ path, status: '.M' }], fingerprint: `dirty-${path}` });
const stored = (system) => system.repository.byId.get(contextIdOf(system.probe.workspace));

test('puertos: una composición incompleta falla de inmediato', () => {
  assert.throws(() => requirePort({ load() {} }, 'ContextRepository'), /update/);
  assert.throws(() => requirePort(null, 'Clock'), /falta el adaptador/);
  assert.throws(() => requirePort({}, 'IdGenerator'), /next/);
  assert.throws(() => requirePort({}, 'Inventado'), /puerto desconocido/);
  assert.throws(() => new ContextGateway({ repository: new InMemoryContextRepository(), probe: {}, clock: new FakeClock() }), /WorkspaceProbe/);
  const profiles = new FakeAccountProfileCatalog();
  assert.throws(() => new HandOff({ gateway: {}, runtime: { splitPane() {} }, engines: new FakeEngineCatalog(), profiles, ids: new FakeIdGenerator(), threads: null }), /AgentRuntime/);
  assert.throws(() => new HandOff({ gateway: {}, runtime: new FakeAgentRuntime(), engines: {}, profiles, ids: new FakeIdGenerator(), threads: null }), /EngineCatalog/);
  assert.throws(() => new HandOff({ gateway: {}, runtime: new FakeAgentRuntime(), engines: new FakeEngineCatalog(), profiles: {}, ids: new FakeIdGenerator(), threads: null }), /AccountProfileCatalog/);
  assert.throws(() => new HandOff({ gateway: {}, runtime: new FakeAgentRuntime(), engines: new FakeEngineCatalog(), profiles, ids: {}, threads: null }), /IdGenerator/);
});

test('registro de lectores: acepta extensiones y la ausencia es normal', () => {
  const registry = new ThreadSourceRegistry();
  assert.throws(() => registry.register({ read: () => null }), /necesita «kind»/);
  assert.throws(() => registry.register({ kind: 'pi' }), /ThreadSource/);
  registry.register(fakeThreadSource('pi', null));
  assert.deepEqual(registry.kinds(), ['pi']);
  assert.equal(registry.get('grok'), null);
});

test('gateway: un contexto desconocido nace vacío y confirmar es atómico', async () => {
  const system = build();
  const resolved = await system.gateway.resolve('/repo');
  assert.equal(resolved.isNew, true);
  assert.equal(resolved.record.events, 0);
  assert.match(resolved.contextId, /^ctx:v2:/);
  await assert.rejects(system.gateway.commit(resolved, [{ type: 'roto', at: 1 }]), /desconocido/);
  assert.equal(system.repository.writes, 0);
});

test('ingesta: toma nombres exactos de git y una observación idéntica no escribe', async () => {
  const system = build();
  dirty(system.probe, 'README.md');
  const first = await system.ingest.run({ cwd: '/repo', engineKind: 'pi', sessionId: 'p1', paneId: 'w:p1' });
  assert.equal(first.applied, 2, 'snapshot y agente');
  assert.equal(first.record.files[0].path, 'README.md');
  assert.equal(first.record.agents.at(-1).kind, 'pi');
  const writes = system.repository.writes;
  const second = await system.ingest.run({ cwd: '/repo', engineKind: 'pi', sessionId: 'p1', paneId: 'w:p1' });
  assert.equal(second.applied, 0);
  assert.equal(system.repository.writes, writes, 'un poll sin cambios no toca disco');
});

test('ingesta: solo consulta commits cuando HEAD avanza y no duplica SHA', async () => {
  const system = build();
  await system.ingest.run({ cwd: '/repo', engineKind: 'claude', sessionId: 's1', paneId: 'w:p1' });
  system.probe.setSnapshot({ head: 'def5678', fingerprint: 'clean-def' });
  system.probe.setCommits([{ sha: 'def5678', subject: 'feat: memoria' }]);
  const changed = await system.ingest.run({ cwd: '/repo', engineKind: 'claude', sessionId: 's1', paneId: 'w:p1' });
  assert.equal(system.probe.calls.commitsBetween, 1);
  assert.equal(changed.record.commits.length, 1);
  await system.ingest.run({ cwd: '/repo', engineKind: 'claude', sessionId: 's1', paneId: 'w:p1' });
  assert.equal(system.probe.calls.commitsBetween, 1, 'HEAD estable evita git log');
});

test('ingesta: un error de git no deja una escritura parcial', async () => {
  const system = build();
  system.probe.breakOn('inspect');
  await assert.rejects(system.ingest.run({ cwd: '/repo', engineKind: 'claude' }), /git no responde/);
  assert.equal(system.repository.writes, 0);
});

test('narrativa: valida, redacta y conserva actualizaciones concurrentes', async () => {
  const system = build();
  await system.remember.run({ cwd: '/repo', goal: 'publicar', requires: [{ kind: 'mcp', name: 'puppeteer' }], by: 'claude' });
  await Promise.all(Array.from({ length: 20 }, (_, index) => system.remember.run({ cwd: '/repo', decision: `decisión ${index}` })));
  const record = stored(system);
  assert.equal(record.goal.text, 'publicar');
  assert.equal(record.requirements[0].name, 'puppeteer');
  assert.equal(record.decisions.length, 20, 'el repositorio serializa sin lost updates');
  const secret = await system.remember.run({ cwd: '/repo', nextStep: 'usar api_key=supersecretvalue123' });
  assert.match(secret.record.nextStep.text, /\[REDACTADO\]/);
  assert.doesNotMatch(secret.record.nextStep.text, /supersecret/);
});

test('narrativa: rechaza campos desconocidos, vacíos y lotes sin límite', async () => {
  const system = build();
  await assert.rejects(system.remember.run({ cwd: '/repo', inventado: 'x' }), /campos desconocidos/);
  await assert.rejects(system.remember.run({ cwd: '/repo' }), /nada que recordar/);
  await assert.rejects(system.remember.run({ cwd: '/repo', goal: '  ' }), /vacío|vacio/);
  await assert.rejects(system.remember.run({ cwd: '/repo', requires: Array.from({ length: 31 }, () => ({ kind: 'mcp', name: 'x' })) }), /hasta 30/);
  assert.equal(system.repository.writes, 0);
});

test('lectura: expone cobertura, calidad y agente inicial', async () => {
  const system = build();
  dirty(system.probe);
  await system.ingest.run({ cwd: '/repo', engineKind: 'codex', sessionId: 'c1', paneId: 'w:p1' });
  await system.remember.run({ cwd: '/repo', goal: 'seguir' });
  const description = await system.describe.run({ cwd: '/repo' });
  assert.equal(description.canHandoff, true);
  assert.equal(description.coverage.quality, 'complete');
  assert.deepEqual(description.lineage.map((item) => item.kind), ['codex']);
});

test('relevo: funciona aunque el origen no tenga lector y nunca cierra el origen', async () => {
  const system = build();
  dirty(system.probe, 'bin/plugin');
  await system.ingest.run({ cwd: '/repo', engineKind: 'pi', sessionId: 'p1', paneId: 'w:p1' });
  await system.remember.run({ cwd: '/repo', goal: 'publicar el plugin' });
  const result = await system.handOff.run({ agent: { ...AGENT, agent: 'pi' }, toKind: 'claude' });
  assert.equal(result.ok, true);
  assert.match(system.runtime.delivered, /publicar el plugin/);
  assert.match(system.runtime.delivered, /bin\/plugin/);
  assert.deepEqual(system.runtime.closed, []);
  assert.deepEqual(stored(system).handoffs.map((handoff) => handoff.status), ['completed']);
});

test('relevo: permite cambiar de cuenta sin cambiar de motor y pasa solo el entorno catalogado', async () => {
  const system = build();
  dirty(system.probe);
  await system.ingest.run({ cwd: '/repo', engineKind: 'claude', sessionId: 's1', paneId: 'w:p1' });
  await system.remember.run({ cwd: '/repo', goal: 'continuar con otra cuenta' });
  const result = await system.handOff.run({
    agent: { ...AGENT, accountProfileId: 'claude-default' },
    toKind: 'claude', profileId: 'claude-spare',
  });
  assert.equal(result.ok, true);
  assert.equal(result.to.profileId, 'claude-spare');
  const split = system.runtime.calls.find((call) => call.op === 'splitPane');
  assert.deepEqual(split.args.opts.env, { LCARS_ACCOUNT_PROFILE: 'claude-spare' });
  await assert.rejects(system.handOff.run({
    agent: { ...AGENT, accountProfileId: 'claude-default' },
    toKind: 'claude', profileId: 'claude-default',
  }), /ya está en ese motor y perfil/);
});

test('relevo: el lector enriquece una vez y redacta secretos', async () => {
  const thread = {
    turns: [{ role: 'humano', text: 'arregla el panel', sourceKey: 'l1' }, { role: 'agente', text: 'token Bearer abcdefghijklmnopqrstuvwxyz', sourceKey: 'l2' }],
    failures: [{ text: 'npm test falló', sourceKey: 'l3' }],
  };
  const system = build({ threads: [fakeThreadSource('claude', thread)] });
  dirty(system.probe);
  await system.ingest.run({ cwd: '/repo', engineKind: 'claude', sessionId: 'session-1', paneId: 'w:p1' });
  await system.handOff.run({ agent: AGENT, toKind: 'codex' });
  assert.match(system.runtime.delivered, /arregla el panel/);
  assert.match(system.runtime.delivered, /\[REDACTADO\]/);
  assert.doesNotMatch(system.runtime.delivered, /abcdefghijklmnopqrstuvwxyz/);
  await system.handOff.run({ agent: AGENT, toKind: 'pi' });
  assert.equal(stored(system).turns.length, 2);
});

test('relevo: falla cerrado sin memoria o con un motor no instalado', async () => {
  const empty = build({ kinds: ['claude', 'codex'] });
  await assert.rejects(empty.handOff.run({ agent: AGENT, toKind: 'codex' }), (error) => error.status === 409);
  await assert.rejects(empty.handOff.run({ agent: AGENT, toKind: 'pi' }), (error) => error.status === 400 && /no disponible/.test(error.message));
  assert.deepEqual(empty.runtime.calls, []);
});

test('relevo: si arranque o readiness fallan, limpia el panel nuevo y registra el fallo', async () => {
  for (const operation of ['startAgent', 'waitReady']) {
    const system = build();
    dirty(system.probe);
    await system.ingest.run({ cwd: '/repo', engineKind: 'claude', paneId: 'w:p1' });
    system.runtime.breakOn(operation, `${operation} roto`);
    await assert.rejects(system.handOff.run({ agent: AGENT, toKind: 'codex' }), (error) => (
      error.status === 502 && !error.message.includes(`${operation} roto`)
    ));
    assert.deepEqual(system.runtime.closed, ['w1:p9']);
    assert.equal(stored(system).handoffs.at(-1).status, 'failed');
    assert.match(stored(system).handoffs.at(-1).error, new RegExp(`${operation} roto`));
  }
});

test('relevo: una entrega ambigua conserva el panel y no altera la genealogía', async () => {
  const system = build();
  dirty(system.probe);
  await system.ingest.run({ cwd: '/repo', engineKind: 'claude', sessionId: 'session-1', paneId: 'w:p1' });
  system.runtime.breakOn('prompt', 'transporte cortado');
  const result = await system.handOff.run({ agent: AGENT, toKind: 'codex' });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /transporte cortado/);
  assert.deepEqual(system.runtime.closed, []);
  assert.equal(stored(system).handoffs.at(-1).status, 'failed');
  assert.match(stored(system).handoffs.at(-1).error, /transporte cortado/);
  assert.deepEqual((await system.describe.run({ cwd: '/repo' })).lineage.map((item) => item.kind), ['claude']);
});

test('relevo: fallo al leer el acuse no invalida una entrega confirmada', async () => {
  const system = build();
  dirty(system.probe);
  await system.ingest.run({ cwd: '/repo', engineKind: 'claude', sessionId: 'session-1', paneId: 'w:p1' });
  system.runtime.breakOn('readPane', 'terminal ocupado');
  const result = await system.handOff.run({ agent: AGENT, toKind: 'codex' });
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.ackError, /terminal ocupado/);
  assert.match(stored(system).handoffs.at(-1).error, /terminal ocupado/);
  assert.deepEqual((await system.describe.run({ cwd: '/repo' })).lineage.map((item) => item.kind), ['claude', 'codex']);
});

test('relevo: request_id hace idempotente un doble clic', async () => {
  const system = build();
  dirty(system.probe);
  await system.ingest.run({ cwd: '/repo', engineKind: 'claude', paneId: 'w:p1' });
  const input = { agent: AGENT, toKind: 'codex', requestId: 'request-idempotent-1' };
  const [one, two] = await Promise.all([system.handOff.run(input), system.handOff.run(input)]);
  assert.equal(one.handoffId, two.handoffId);
  assert.equal(system.runtime.calls.filter((call) => call.op === 'splitPane').length, 1);
});

test('relevo: si ni siquiera puede partir panel, no inventa destino y sí deja traza', async () => {
  const system = build();
  dirty(system.probe);
  await system.ingest.run({ cwd: '/repo', engineKind: 'claude', paneId: 'w:p1' });
  system.runtime.breakOn('splitPane', 'no such pane');
  await assert.rejects(system.handOff.run({ agent: AGENT, toKind: 'codex' }), (error) => (
    error.status === 502 && !error.message.includes('no such pane')
  ));
  assert.deepEqual(system.runtime.closed, []);
  assert.equal(stored(system).handoffs.at(-1).status, 'failed');
  assert.match(stored(system).handoffs.at(-1).error, /no such pane/);
});
