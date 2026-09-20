// El aviso de «subagente terminado» no llegaba nunca: se comparaba el estado antes y después de
// releer el fichero dentro del mismo barrido, y releerlo ya adelantaba su fecha de modificación.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lcars-subagentes-'));
process.env.LCARS_CLAUDE_PROJECTS = root;
const { SubagentWatcher } = await import('../server/subagents.mjs');

const SESSION = 'sesion-1';
const dir = path.join(root, 'proyecto', SESSION, 'subagents');
const jsonl = path.join(dir, 'agent-abc.jsonl');

test('un subagente que deja de escribir acaba anunciándose como terminado', async (t) => {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Buscar usos de la API' }));
  await fs.writeFile(jsonl, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash' }], usage: { input_tokens: 5, output_tokens: 50 } } }) + '\n');

  const eventos = [];
  const w = new SubagentWatcher((ev) => eventos.push(ev));
  t.after(() => w.close());

  w.sync([SESSION]);
  await new Promise((r) => setTimeout(r, 300));
  let subs = w.list(SESSION);
  assert.equal(subs.length, 1, 'se detecta el subagente');
  assert.equal(subs[0].type, 'Explore');
  assert.equal(subs[0].status, 'working', 'recién escrito, está trabajando');
  assert.equal(eventos.filter((e) => e.kind === 'subagent_start').length, 0, 'el primer barrido no anuncia lo que ya existía');

  // Envejecemos el fichero en disco: equivale a que el subagente lleve un minuto sin escribir.
  const viejo = new Date(Date.now() - 60_000);
  await fs.utimes(jsonl, viejo, viejo);
  await w.scan();

  subs = w.list(SESSION);
  assert.notEqual(subs[0].status, 'working', 'ya no está trabajando');
  const done = eventos.filter((e) => e.kind === 'subagent_done');
  assert.equal(done.length, 1, 'se anuncia una vez que ha terminado');
  assert.equal(done[0].agentType, 'Explore');
  assert.equal(done[0].output, 50, 'lleva los tokens de salida acumulados');

  await w.scan();
  assert.equal(eventos.filter((e) => e.kind === 'subagent_done').length, 1, 'no se repite en barridos siguientes');
});

test('un subagente nuevo sí se anuncia', async (t) => {
  const eventos = [];
  const w = new SubagentWatcher((ev) => eventos.push(ev));
  t.after(() => w.close());
  w.sync([SESSION]);
  await new Promise((r) => setTimeout(r, 300));
  await fs.writeFile(path.join(dir, 'agent-def.meta.json'), JSON.stringify({ agentType: 'Plan', description: 'Diseñar el plan' }));
  await fs.writeFile(path.join(dir, 'agent-def.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model: 'claude-opus-5', content: [], usage: { output_tokens: 7 } } }) + '\n');
  await w.scan();
  const start = eventos.filter((e) => e.kind === 'subagent_start');
  assert.equal(start.length, 1);
  assert.equal(start[0].agentType, 'Plan');
  assert.equal(start[0].description, 'Diseñar el plan');
});

test.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
