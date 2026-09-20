import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityScheduler } from '../../server/context/scheduler.mjs';
import { FakeClock } from './fakes.mjs';

function spyIngest({ throws = false } = {}) {
  const calls = [];
  return {
    calls,
    run: async (input) => {
      calls.push(input);
      if (throws) throw new Error('git no responde');
      return { applied: 1 };
    },
  };
}

const agent = (cwd, extra = {}) => ({ cwd, agent: 'claude', paneId: 'w1:p1', sessionId: 's1', status: 'idle', ...extra });

test('cadencia: observa cada directorio una sola vez por pasada', async () => {
  const ingest = spyIngest(), clock = new FakeClock();
  const s = new ActivityScheduler({ ingest, clock, everyMs: 1000 });
  assert.equal(await s.sync([agent('/a'), agent('/a', { paneId: 'w1:p2' }), agent('/b')]), 2);
  assert.deepEqual(ingest.calls.map((c) => c.cwd).sort(), ['/a', '/b']);
});

test('cadencia: gana el agente que está trabajando sobre el que espera', async () => {
  const ingest = spyIngest(), clock = new FakeClock();
  const s = new ActivityScheduler({ ingest, clock, everyMs: 1000 });
  await s.sync([agent('/a', { paneId: 'w1:p1' }), agent('/a', { paneId: 'w1:p7', status: 'working', agent: 'codex' })]);
  assert.equal(ingest.calls[0].paneId, 'w1:p7');
  assert.equal(ingest.calls[0].engineKind, 'codex');
});

test('cadencia: respeta el intervalo y vuelve cuando toca', async () => {
  const ingest = spyIngest(), clock = new FakeClock();
  const s = new ActivityScheduler({ ingest, clock, everyMs: 1000 });
  await s.sync([agent('/a')]);
  await s.sync([agent('/a')]);
  assert.equal(ingest.calls.length, 1, 'todavía no toca');
  clock.advance(1000);
  await s.sync([agent('/a')]);
  assert.equal(ingest.calls.length, 2);
});

test('cadencia: un agente sin directorio no se observa', async () => {
  const ingest = spyIngest(), clock = new FakeClock();
  const s = new ActivityScheduler({ ingest, clock });
  assert.equal(await s.sync([{ agent: 'pi', paneId: 'w1:p1' }, agent(null)]), 0);
  assert.equal(ingest.calls.length, 0);
});

test('cadencia: si la ingesta falla, se avisa pero no se propaga', async () => {
  const ingest = spyIngest({ throws: true }), clock = new FakeClock();
  const warned = [];
  const s = new ActivityScheduler({ ingest, clock, everyMs: 1000, log: { warn: (m) => warned.push(m) } });
  await assert.doesNotReject(s.sync([agent('/a')]));
  assert.match(warned[0], /git no responde/);
  assert.equal(s.inFlight.size, 0, 'el directorio queda libre para el siguiente intento');
});

test('cadencia: el mismo fallo persistente avisa una vez y se rearma tras recuperarse', async () => {
  let failing = true;
  const ingest = { run: async () => {
    if (failing) { const error = new Error('snapshot ambiguo'); error.code = 'CONTEXT_KEY_COLLISION'; throw error; }
    return { applied: 0 };
  } };
  const clock = new FakeClock(), warned = [];
  const s = new ActivityScheduler({ ingest, clock, everyMs: 1000, log: { warn: (m) => warned.push(m) } });
  await s.sync([agent('/a')]);
  clock.advance(1000); await s.sync([agent('/a')]);
  assert.equal(warned.length, 1, 'el log no debe crecer en cada poll');
  failing = false;
  clock.advance(1000); await s.sync([agent('/a')]);
  failing = true;
  clock.advance(1000); await s.sync([agent('/a')]);
  assert.equal(warned.length, 2, 'una recuperación real rearma el aviso');
});

test('cadencia: olvida los directorios que ya no tiene ningún agente', async () => {
  const ingest = spyIngest(), clock = new FakeClock();
  const s = new ActivityScheduler({ ingest, clock, everyMs: 10_000 });
  await s.sync([agent('/a'), agent('/b')]);
  s.prune([agent('/a')]);
  assert.deepEqual([...s.lastRun.keys()], ['/a']);
  assert.equal(s.lastError.has('/b'), false);
});

test('cadencia: limita el trabajo paralelo aunque haya cientos de contextos', async () => {
  let active = 0, peak = 0;
  const ingest = {
    async run({ cwd }) {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 4));
      active -= 1;
      return { contextId: `ctx:${cwd}` };
    },
  };
  const scheduler = new ActivityScheduler({ ingest, clock: new FakeClock(), everyMs: 1_000, concurrency: 3 });
  const agents = Array.from({ length: 30 }, (_, index) => agent(`/repo/${index}`, { paneId: `w:p${index}` }));
  assert.equal(await scheduler.sync(agents), 30);
  assert.ok(peak <= 3, `pico observado: ${peak}`);
});
