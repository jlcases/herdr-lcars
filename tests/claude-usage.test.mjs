import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_USAGE_URL,
  ClaudeUsageMonitor,
  claudeCredentialService,
  fetchClaudeUsage,
  normalizeClaudeUsage,
  readClaudeAccessToken,
} from '../server/adapters/claude-usage.mjs';

const payload = {
  five_hour: { utilization: 4, resets_at: '2026-09-19T22:00:00.961541+00:00' },
  seven_day: { utilization: 57, resets_at: '2026-09-24T14:00:00.961563+00:00' },
};

test('cuota Claude: normaliza las dos ventanas oficiales sin invertir restante y consumido', () => {
  assert.deepEqual(normalizeClaudeUsage(payload), [
    { id: 'five_hour', minutes: 300, usedPercent: 4, resetsAt: 1_789_855_200 },
    { id: 'seven_day', minutes: 10_080, usedPercent: 57, resetsAt: 1_790_258_400 },
  ]);
  assert.throws(() => normalizeClaudeUsage({ seven_day: { utilization: 101 } }), /response_invalid/);
});

test('cuota Claude: consulta solo Anthropic y el token no aparece en el resultado', async () => {
  const secret = 'oauth-secret-that-must-never-escape';
  const calls = [];
  const result = await fetchClaudeUsage({ id: 'claude-default' }, {
    readAccessToken: async () => secret,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CLAUDE_USAGE_URL);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${secret}`);
  assert.equal(calls[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test('credenciales Claude: Keychain separa perfiles y nunca invoca un shell', async () => {
  const defaultProfile = { id: 'claude-default', home: '/Users/test/.claude', launchEnv: {} };
  const custom = { id: 'claude-work', home: '/Users/test/.claude-work', launchEnv: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-work' } };
  const suffix = crypto.createHash('sha256').update(custom.home.normalize('NFC')).digest('hex').slice(0, 8);
  assert.equal(claudeCredentialService(defaultProfile), 'Claude Code-credentials');
  assert.equal(claudeCredentialService(custom), `Claude Code-credentials-${suffix}`);

  const invocations = [];
  const execFileImpl = (file, args, options, done) => {
    invocations.push({ file, args, options });
    done(null, JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-token-123456' } }));
  };
  assert.equal(await readClaudeAccessToken(custom, { platform: 'darwin', username: 'tester', execFileImpl }), 'keychain-token-123456');
  assert.equal(invocations[0].file, '/usr/bin/security');
  assert.deepEqual(invocations[0].args.slice(0, 6), ['find-generic-password', '-a', 'tester', '-w', '-s', `Claude Code-credentials-${suffix}`]);
  assert.equal('shell' in invocations[0].options, false);
});

test('credenciales Claude: Linux exige el fichero oficial privado', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-claude-usage-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.credentials.json');
  await fsp.writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: 'private-file-token-123456' } }), { mode: 0o600 });
  const profile = { id: 'claude-linux', home: root };
  assert.equal(await readClaudeAccessToken(profile, { platform: 'linux' }), 'private-file-token-123456');
  await fsp.chmod(file, 0o644);
  await assert.rejects(readClaudeAccessToken(profile, { platform: 'linux' }), { code: 'insecure_permissions' });
});

test('monitor Claude: deduplica cuentas, publica al instante y redacta fallos', async () => {
  const profile = { id: 'claude-work', provider: 'claude' };
  const reports = [], warnings = [];
  let calls = 0;
  const monitor = new ClaudeUsageMonitor({
    targets: () => [
      { profile, accountKey: 'account-a' },
      { profile: { ...profile, id: 'claude-alias' }, accountKey: 'account-a' },
    ],
    fetchUsage: async () => { calls++; return normalizeClaudeUsage(payload); },
    onUsage: (...args) => reports.push(args),
    log: { warn: (message) => warnings.push(message) },
    now: () => 123_456,
  });
  assert.equal(await monitor.poll(), true);
  assert.equal(calls, 1);
  assert.equal(reports.length, 1);
  assert.equal(reports[0][0], 'account-a');
  assert.equal(reports[0][2].at, 123_456);

  const secret = 'secret-inside-hostile-error';
  const failing = new ClaudeUsageMonitor({
    targets: () => [{ profile, accountKey: 'account-a' }],
    fetchUsage: async () => { throw new Error(secret); },
    onUsage: () => assert.fail('un fallo no publica cuota'),
    log: { warn: (message) => warnings.push(message) },
  });
  await failing.poll();
  await failing.poll();
  assert.equal(warnings.filter((message) => message.includes('usage_unavailable')).length, 1, 'el mismo fallo no inunda el log');
  assert.doesNotMatch(warnings.join('\n'), new RegExp(secret));
});

test('cuota Claude: rechaza respuestas sobredimensionadas antes de leer el cuerpo', async () => {
  await assert.rejects(fetchClaudeUsage({ id: 'claude-default' }, {
    readAccessToken: async () => 'valid-token-for-test-123456',
    fetchImpl: async () => ({
      ok: true,
      headers: { get: (name) => name === 'content-length' ? String(300 * 1024) : null },
      text: async () => JSON.stringify(payload),
    }),
  }), { code: 'response_too_large' });
});
