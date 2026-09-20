// Cuentas: una cuota pertenece a una identidad, no a un proveedor ni a un proceso.
//
// El catálogo de perfiles aporta rutas y variables de lanzamiento sin secretos. Este registro lee
// únicamente identidad local y observaciones de cuota, agrupa dos perfiles que sean la misma cuenta
// y nunca atribuye una lectura anónima si hay más de una cuenta posible.
import fsp from 'node:fs/promises';
import { readJSONFile } from './safe-json-file.mjs';
import { stableToken } from './stable-token.mjs';

const RELOAD_MS = 60_000;
const LIVE_SIGNAL_MS = 75_000;
const EXPECTED_WINDOWS = Object.freeze({
  claude: Object.freeze([{ id: 'five_hour', minutes: 300 }, { id: 'seven_day', minutes: 10_080 }]),
  codex: Object.freeze([{ id: 'five_hour', minutes: 300 }, { id: 'seven_day', minutes: 10_080 }]),
});
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const text = (value, max) => typeof value === 'string'
  ? value.replace(CONTROL_CHARS, '').slice(0, max) : null;
const percent = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : null;
};
// Identidad opaca para la UI, no credencial ni derivación de contraseña. La cuenta se identifica
// por UUID o por el id local del perfil y nunca se autoriza nada con este token.
const keyOf = (...parts) => stableToken(parts.filter(Boolean).join('\0')).slice(-12);
const isoToEpoch = (value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.floor(time / 1_000) : null;
};

/** Payload de JWT no verificado: sirve para etiquetas locales, nunca para autorizar. */
function jwtClaims(token) {
  try {
    if (typeof token !== 'string' || token.length > 100_000) return {};
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch { return {}; }
}

/** Los gestores multicuenta suelen enlazar auth.json. Se resuelve el enlace y se mantiene el tope. */
async function readCredentialJSON(file) {
  try { return await readJSONFile(file); }
  catch (error) {
    if (!['ELOOP', 'EMLINK'].includes(error?.code)) throw error;
    return readJSONFile(await fsp.realpath(file));
  }
}

async function readClaude(profile) {
  let data;
  try { data = await readCredentialJSON(profile.accountFile); }
  catch { return profile.configured ? fallbackAccount(profile) : null; }
  const oauth = data.oauthAccount;
  const uuid = text(oauth?.accountUuid, 200);
  if (!uuid && !profile.configured) return null;
  const account = {
    key: keyOf('claude', uuid || profile.id), provider: 'claude', accountUuid: uuid,
    label: profile.configured ? profile.label : text(oauth?.emailAddress, 320) || text(oauth?.displayName, 200) || profile.label,
    org: text(oauth?.organizationName, 200),
    tier: text(oauth?.userRateLimitTier, 100) || text(oauth?.seatTier, 100),
    windows: [], profileIds: [profile.id], ready: Boolean(uuid),
  };
  const cached = data.cachedUsageUtilization;
  if (uuid && cached?.accountUuid === uuid && cached.utilization) {
    const at = Number(cached.fetchedAtMs) || 0;
    for (const { id, minutes } of EXPECTED_WINDOWS.claude) {
      const window = cached.utilization[id];
      const usedPercent = percent(window?.utilization);
      if (usedPercent == null) continue;
      account.windows.push({ id, minutes, usedPercent, resetsAt: isoToEpoch(window.resets_at), at, source: 'claude.json', cold: true });
    }
  }
  return account;
}

async function readCodex(profile) {
  let data;
  try { data = await readCredentialJSON(profile.accountFile); }
  catch { return profile.configured ? fallbackAccount(profile) : null; }
  const accountId = text(data.tokens?.account_id, 200);
  if (!accountId && !profile.configured) return null;
  const claims = jwtClaims(data.tokens?.id_token)['https://api.openai.com/auth'] || {};
  const plan = text(claims.chatgpt_plan_type, 80);
  return {
    key: keyOf('codex', accountId || profile.id), provider: 'codex', accountUuid: accountId,
    label: profile.configured ? profile.label : plan ? `ChatGPT ${plan}` : profile.label,
    org: text(claims.organizations?.find((org) => org.is_default)?.title, 200), tier: plan,
    windows: [], profileIds: [profile.id], ready: Boolean(accountId),
  };
}

function fallbackAccount(profile) {
  return {
    key: keyOf(profile.provider, profile.id), provider: profile.provider, accountUuid: null,
    label: profile.label, org: null, tier: null, windows: [], profileIds: [profile.id], ready: false,
  };
}

const READERS = { claude: readClaude, codex: readCodex };

/**
 * Combina observaciones por reloj de origen. Varias sesiones de una misma cuenta pueden publicar
 * instantáneas diferentes durante el arranque; el orden de `readdir` o de las promesas nunca debe
 * decidir la cuota visible.
 */
function mergeWindows(previous, incoming, nowMs) {
  if (!incoming.length) return previous;
  const accepted = incoming.filter((candidate) => {
    const current = previous.find((window) => window.id === candidate.id);
    if (!current) return true;
    // El consumo no puede retroceder dentro de la misma ventana. Esto protege la lectura oficial
    // contra snapshots retrasados de sesiones inactivas incluso si su fichero se tocó después.
    const sameReset = Number.isFinite(current.resetsAt) && Number.isFinite(candidate.resetsAt)
      && current.resetsAt === candidate.resetsAt;
    if (sameReset && candidate.usedPercent !== current.usedPercent) {
      return candidate.usedPercent > current.usedPercent;
    }
    return !Number.isFinite(current.at) || candidate.at >= current.at;
  });
  if (!accepted.length) {
    const live = previous.filter((window) => !window.resetsAt || window.resetsAt * 1_000 > nowMs);
    return live.length === previous.length ? previous : live;
  }
  const next = [...accepted];
  for (const old of previous) {
    if (next.some((window) => window.id === old.id)) continue;
    if (!old.resetsAt || old.resetsAt * 1_000 <= nowMs) continue;
    next.push(old);
  }
  return next.sort((left, right) => (left.minutes || Infinity) - (right.minutes || Infinity));
}

export class AccountRegistry {
  constructor({ profiles, onAlert, onChange, lowPercent = 10, now = () => Date.now() } = {}) {
    if (!profiles || typeof profiles.list !== 'function') throw new TypeError('AccountRegistry necesita un catálogo de perfiles');
    this.profiles = profiles;
    this.accounts = new Map();
    this.profileToAccount = new Map();
    this.byProvider = new Map();
    this.paneProfiles = new Map();
    this.sessionProfiles = new Map();
    this.alerted = new Set();
    this.onAlert = onAlert; this.onChange = onChange; this.now = now;
    this.lowPercent = percent(lowPercent) ?? 10;
    this.loadedAt = 0; this.revision = 0;
  }

  async refresh(force = false) {
    if (!force && this.now() - this.loadedAt < RELOAD_MS) return false;
    this.loadedAt = this.now();
    const profilesChanged = await this.profiles.refresh(force);
    const next = new Map(), profileToAccount = new Map();
    for (const profile of this.profiles.list()) {
      const account = await READERS[profile.provider]?.(profile);
      if (!account) continue;
      const existing = next.get(account.key);
      if (existing) {
        existing.profileIds = [...new Set([...existing.profileIds, ...account.profileIds])];
        existing.ready ||= account.ready;
        if (!existing.org) existing.org = account.org;
        if (!existing.tier) existing.tier = account.tier;
        if (!existing.windows.length) existing.windows = account.windows;
      } else {
        const previous = this.accounts.get(account.key);
        if (previous?.windows?.some((window) => !window.cold)) account.windows = previous.windows;
        next.set(account.key, account);
      }
      profileToAccount.set(profile.id, account.key);
    }
    const before = JSON.stringify(this.#snapshot(this.accounts, this.profileToAccount));
    this.accounts = next; this.profileToAccount = profileToAccount;
    this.#rebuildProviderFallbacks();
    const changed = profilesChanged || before !== JSON.stringify(this.#snapshot(this.accounts, this.profileToAccount));
    if (changed) this.#changed();
    return changed;
  }

  #snapshot(accounts, profileMap) {
    return {
      accounts: [...accounts.values()].map((account) => ({ ...account, windows: account.windows.map((window) => ({ ...window })) })),
      profiles: [...profileMap],
    };
  }

  #rebuildProviderFallbacks() {
    this.byProvider.clear();
    for (const provider of Object.keys(EXPECTED_WINDOWS)) {
      const keys = [...this.accounts.values()].filter((account) => account.provider === provider).map((account) => account.key);
      if (keys.length === 1) this.byProvider.set(provider, keys[0]);
    }
  }

  #changed() {
    this.revision++;
    this.onChange?.({ revision: this.revision, accounts: this.toJSON(), profiles: this.profilesJSON() });
  }

  /** Una lectura anónima solo se atribuye si el perfil o la única cuenta posible la hacen inequívoca. */
  keyFor(provider, { profileId = null, paneId = null, sessionId = null } = {}) {
    const resolvedProfile = profileId || this.sessionProfiles.get(sessionId) || this.paneProfiles.get(paneId);
    return (resolvedProfile && this.profileToAccount.get(resolvedProfile)) || this.byProvider.get(provider) || null;
  }

  keyByUuid(uuid) {
    for (const [key, account] of this.accounts) if (account.accountUuid === uuid) return key;
    return null;
  }

  bindPane(paneId, profileId) {
    if (!paneId || !this.profileToAccount.has(profileId)) return false;
    this.paneProfiles.set(paneId, profileId); return true;
  }

  bindSession(sessionId, profileId) {
    if (!sessionId || !this.profileToAccount.has(profileId)) return false;
    this.sessionProfiles.set(sessionId, profileId); return true;
  }

  profileFor(paneId, sessionId) {
    return this.sessionProfiles.get(sessionId) || this.paneProfiles.get(paneId) || null;
  }

  prunePanes(livePaneIds) {
    for (const paneId of this.paneProfiles.keys()) if (!livePaneIds.has(paneId)) this.paneProfiles.delete(paneId);
  }

  report(key, windows, source, { at: observedAt } = {}) {
    const account = this.accounts.get(key);
    if (!account || !Array.isArray(windows)) return false;
    const now = this.now(), candidateAt = Number(observedAt);
    // El timestamp ordena lecturas, pero no se permite que un reloj futuro bloquee para siempre
    // las observaciones posteriores.
    const at = Number.isFinite(candidateAt) && candidateAt > 0 ? Math.min(candidateAt, now) : now;
    const incoming = [];
    for (const raw of windows) {
      const usedPercent = percent(raw?.usedPercent), id = text(raw?.id, 80);
      const minutes = Number(raw?.minutes), resetsAt = Number(raw?.resetsAt);
      if (usedPercent == null || !id) continue;
      incoming.push({
        id, minutes: Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 100_000) : null,
        usedPercent, resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? Math.min(resetsAt, 1e12) : null,
        at, source: text(source, 80), cold: false,
      });
    }
    if (!incoming.length) return false;
    const merged = mergeWindows(account.windows, incoming, now);
    if (merged === account.windows) return false;
    account.windows = merged;
    this.checkLow(account);
    // También una lectura con el mismo porcentaje es nueva evidencia: renueva su sello de frescura.
    this.#changed();
    return true;
  }

  checkLow(account) {
    const worst = this.headroom(account);
    if (worst == null) return;
    if (worst > this.lowPercent) { this.alerted.delete(account.key); return; }
    if (this.alerted.has(account.key)) return;
    this.alerted.add(account.key);
    this.onAlert?.({ account, remainingPercent: worst });
  }

  headroom(account) {
    const live = account.windows.filter((window) => window.usedPercent != null && !this.expired(window));
    return live.length ? Math.min(...live.map((window) => 100 - window.usedPercent)) : null;
  }

  expired(window) { return Boolean(window.resetsAt && window.resetsAt * 1_000 < this.now()); }

  pace(window) {
    if (!window.resetsAt || !window.minutes || this.expired(window)) return null;
    const total = window.minutes * 60_000;
    const elapsed = total - (window.resetsAt * 1_000 - this.now());
    if (elapsed <= 0 || elapsed / total < 0.05) return null;
    const delta = window.usedPercent - (elapsed / total) * 100;
    return Math.abs(delta) <= 5 ? 0 : Math.round(delta);
  }

  signal(account) {
    const current = account.windows.filter((window) => !this.expired(window));
    if (current.some((window) => !window.cold && this.now() - window.at <= LIVE_SIGNAL_MS)) return 'live';
    if (current.some((window) => !window.cold)) return 'recent';
    if (current.some((window) => window.cold)) return 'cold';
    return 'none';
  }

  profilesJSON() {
    const state = new Map();
    for (const profile of this.profiles.list()) {
      const accountKey = this.profileToAccount.get(profile.id), account = this.accounts.get(accountKey);
      state.set(profile.id, {
        accountKey, label: account?.label || profile.label, headroom: account ? this.headroom(account) : null,
        signal: account ? this.signal(account) : 'none',
      });
    }
    return this.profiles.publicList(state);
  }

  toJSON() {
    return [...this.accounts.values()].map((account) => ({
      key: account.key, provider: account.provider, label: account.label, org: account.org, tier: account.tier,
      profileIds: account.profileIds, ready: account.ready, headroom: this.headroom(account), signal: this.signal(account),
      expectedWindows: EXPECTED_WINDOWS[account.provider] || [],
      windows: account.windows.map((window) => ({
        id: window.id, minutes: window.minutes, remainingPercent: 100 - window.usedPercent, resetsAt: window.resetsAt,
        at: window.at, source: window.source, cold: Boolean(window.cold), expired: this.expired(window), pace: this.pace(window),
      })),
    })).sort((left, right) => (left.headroom ?? 101) - (right.headroom ?? 101));
  }
}
