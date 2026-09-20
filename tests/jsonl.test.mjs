import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firstLine, tailJsonl } from '../server/jsonl.mjs';
import { symlinkOrSkip } from './helpers.mjs';

test('JSONL: la primera línea y el seguidor no siguen enlaces simbólicos', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-jsonl-link-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const real = path.join(dir, 'real.jsonl');
  const link = path.join(dir, 'link.jsonl');
  await fsp.writeFile(real, '{"ok":true}\n');
  if (!await symlinkOrSkip(t, real, link)) return;
  await assert.rejects(firstLine(link), (error) => ['ELOOP', 'EMLINK'].includes(error.code));
  await assert.rejects(tailJsonl(link, 0, () => {}), (error) => ['ELOOP', 'EMLINK'].includes(error.code));
});
