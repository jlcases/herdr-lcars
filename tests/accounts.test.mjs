import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountProfileCatalog, parseAccountProfiles } from '../server/account-profiles.mjs';
import { AccountRegistry } from '../server/accounts.mjs';

const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcars-accounts-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const work = path.join(root, 'claude-work'), personal = path.join(root, 'claude-personal');
  const codex = path.join(root, 'codex-work');
  await Promise.all([work, personal, codex].map((dir) => fsp.mkdir(dir, { recursive: true })));
  const reset5 = Math.floor((1_700_000_000_000 + 4 * 3600_000) / 1_000);
  const reset7 = Math.floor((1_700_000_000_000 + 6 * 86400_000) / 1_000);
  const claude = (uuid, email, used) => ({
    oauthAccount: { accountUuid: uuid, emailAddress: email, userRateLimitTier: 'default_claude_max_5x' },
    cachedUsageUtilization: {
      accountUuid: uuid, fetchedAtMs: 1_700_000_000_000,
      utilization: {
        five_hour: { utilization: used, resets_at: new Date(reset5 * 1_000).toISOString() },
        seven_day: { utilization: used / 2, resets_at: new Date(reset7 * 1_000).toISOString() },
      },
    },
  });
  await Promise.all([
    fsp.writeFile(path.join(work, '.claude.json'), JSON.stringify(claude('claude-a', 'work@example.test', 30))),
    fsp.writeFile(path.join(personal, '.claude.json'), JSON.stringify(claude('claude-b', 'personal@example.test', 10))),
    fsp.writeFile(path.join(codex, 'auth.json'), JSON.stringify({
      tokens: {
        account_id: 'codex-a',
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } }),
      },
    })),
  ]);
  const file = path.join(root, 'accounts.json');
  await fsp.writeFile(file, JSON.stringify({
    version: 1,
    profiles: [
      { id: 'claude-work', provider: 'claude', label: 'Claude trabajo', home: work },
      { id: 'claude-personal', provider: 'claude', label: 'Claude personal', home: personal },
      { id: 'codex-work', provider: 'codex', label: 'Codex trabajo', home: codex },
    ],
  }));
  return { root, file, work, personal, codex, reset5, reset7 };
}

test('perfiles: solo aceptan proveedores, ids y rutas acotados', () => {
  const base = { version: 1, profiles: [] };
  assert.equal(parseAccountProfiles(base, { userHome: '/tmp/user', env: {} }).length, 2);
  assert.throws(() => parseAccountProfiles({ version: 1, profiles: [{ id: '../x', provider: 'claude', home: '/tmp/x' }] }), /id de perfil/);
  assert.throws(() => parseAccountProfiles({ version: 1, profiles: [{ id: 'x', provider: 'otro', home: '/tmp/x' }] }), /proveedor/);
  assert.throws(() => parseAccountProfiles({ version: 1, profiles: [{ id: 'x', provider: 'claude', home: 'relativo' }] }), /ruta absoluta/);
});

test('perfiles: el runtime recibe aislamiento, nunca tokens del fichero', async (t) => {
  const { file, root, work } = await fixture(t);
  const catalog = new AccountProfileCatalog({ file, userHome: root, env: {} });
  await catalog.refresh(true);
  const profile = catalog.resolve('claude-work', 'claude');
  assert.equal(profile.launchEnv.CLAUDE_CONFIG_DIR, work);
  assert.equal(profile.launchEnv.LCARS_ACCOUNT_PROFILE, 'claude-work');
  assert.equal(profile.launchEnv.CLAUDE_CODE_OAUTH_TOKEN, '');
  assert.deepEqual(Object.keys(profile.launchEnv).sort(), [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'LCARS_ACCOUNT_PROFILE',
  ]);
  assert.throws(() => catalog.resolve('claude-work', 'codex'), /no pertenece/);
  assert.throws(() => catalog.resolve({ path: '/tmp' }, 'claude'), /no válido/);
});

test('cuotas: varias cuentas no se mezclan y 5 h sobrevive solo a una omisión vigente', async (t) => {
  const data = await fixture(t);
  let now = 1_700_000_000_000;
  const changes = [];
  const catalog = new AccountProfileCatalog({ file: data.file, userHome: data.root, env: {} });
  const registry = new AccountRegistry({ profiles: catalog, now: () => now, onChange: (event) => changes.push(event) });
  await registry.refresh(true);

  const workKey = registry.keyFor('claude', { profileId: 'claude-work' });
  const personalKey = registry.keyFor('claude', { profileId: 'claude-personal' });
  assert.ok(workKey && personalKey && workKey !== personalKey);
  assert.match(workKey, /^[0-9a-z]{12}$/);
  assert.doesNotMatch(workKey, /claude-a/, 'el identificador público no expone el UUID de la cuenta');
  assert.equal(registry.keyFor('claude'), null, 'con dos cuentas una lectura anónima queda sin atribuir');
  assert.equal(registry.toJSON().filter((account) => account.provider === 'claude').length, 2);

  registry.report(workKey, [
    { id: 'five_hour', minutes: 300, usedPercent: 40, resetsAt: data.reset5 },
    { id: 'seven_day', minutes: 10_080, usedPercent: 20, resetsAt: data.reset7 },
  ], 'statusline');
  now += 1_000;
  registry.report(workKey, [
    { id: 'seven_day', minutes: 10_080, usedPercent: 21, resetsAt: data.reset7 },
  ], 'statusline');
  const work = registry.toJSON().find((account) => account.key === workKey);
  assert.equal(work.windows.find((window) => window.id === 'five_hour').remainingPercent, 60);
  assert.equal(Object.hasOwn(work.windows.find((window) => window.id === 'five_hour'), 'usedPercent'), false,
    'la API pública solo expresa el porcentaje restante');
  assert.equal(work.signal, 'live');
  assert.deepEqual(work.expectedWindows.map((window) => window.id), ['five_hour', 'seven_day']);
  assert.equal(registry.toJSON().find((account) => account.key === personalKey).windows.find((window) => window.id === 'five_hour').remainingPercent, 90);

  now += 2_000;
  registry.report(workKey, [
    { id: 'seven_day', minutes: 10_080, usedPercent: 46, resetsAt: data.reset7 },
  ], 'statusline', { at: now });
  registry.report(workKey, [
    { id: 'seven_day', minutes: 10_080, usedPercent: 32, resetsAt: data.reset7 },
  ], 'statusline', { at: now - 1_000 });
  assert.equal(registry.toJSON().find((account) => account.key === workKey).windows.find((window) => window.id === 'seven_day').remainingPercent, 54,
    'una lectura vieja de otra sesión no pisa el porcentaje restante más reciente');

  now = data.reset5 * 1_000 + 1;
  registry.report(workKey, [
    { id: 'seven_day', minutes: 10_080, usedPercent: 22, resetsAt: data.reset7 },
  ], 'statusline');
  assert.equal(registry.toJSON().find((account) => account.key === workKey).windows.some((window) => window.id === 'five_hour'), false);
  assert.ok(changes.length >= 4, 'carga y lecturas publican cambios inmediatamente');
});

test('cuotas: el consumo es monótono dentro de una ventana y puede bajar después del reinicio', async (t) => {
  const data = await fixture(t);
  let now = 1_700_000_100_000;
  const catalog = new AccountProfileCatalog({ file: data.file, userHome: data.root, env: {} });
  const registry = new AccountRegistry({ profiles: catalog, now: () => now });
  await registry.refresh(true);
  const key = registry.keyFor('claude', { profileId: 'claude-work' });

  registry.report(key, [{ id: 'seven_day', minutes: 10_080, usedPercent: 46, resetsAt: data.reset7 }], 'statusline', { at: now });
  registry.report(key, [{ id: 'seven_day', minutes: 10_080, usedPercent: 57, resetsAt: data.reset7 }], 'claude-api', { at: now - 30_000 });
  const remaining = () => registry.toJSON().find((account) => account.key === key)
    .windows.find((window) => window.id === 'seven_day').remainingPercent;
  assert.equal(remaining(), 43,
    'una lectura oficial con más consumo corrige un snapshot retrasado aunque termine antes');

  now += 60_000;
  registry.report(key, [{ id: 'seven_day', minutes: 10_080, usedPercent: 2, resetsAt: data.reset7 + 7 * 86_400 }], 'claude-api', { at: now });
  assert.equal(remaining(), 98,
    'una ventana nueva sí puede empezar con menos consumo');

  registry.report(key, [{ id: 'seven_day', minutes: 10_080, usedPercent: 61, resetsAt: data.reset7 }], 'statusline', { at: now - 1 });
  assert.equal(remaining(), 98,
    'una instantánea tardía de la ventana anterior no revive el consumo vencido');
});
