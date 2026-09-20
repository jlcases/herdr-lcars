// Catálogo de perfiles de cuenta. El fichero solo contiene alias y directorios: nunca tokens.
//
// Esta es la frontera entre producto y credenciales. El caso de uso de relevo pide un perfil por
// identificador; este adaptador traduce el identificador a variables de entorno ya validadas. Así el
// navegador no puede enviar rutas ni nombres de variables arbitrarios al runtime de Herdr.
import os from 'node:os';
import path from 'node:path';
import { readJSONFile } from './safe-json-file.mjs';

const RELOAD_MS = 60_000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_PROFILES = 32;
const PROFILE_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const PROVIDERS = new Set(['claude', 'codex']);
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const clean = (value, max) => typeof value === 'string'
  ? value.replace(CONTROL_CHARS, '').trim().slice(0, max) : '';

const statusError = (message) => Object.assign(new Error(message), { status: 400 });

function absoluteHome(value, userHome) {
  const raw = clean(value, 4_096);
  if (!raw || raw.includes('\0')) throw statusError('cada perfil necesita un directorio home');
  const expanded = raw === '~' ? userHome : raw.startsWith('~/') ? path.join(userHome, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) throw statusError('el home de un perfil debe ser una ruta absoluta o empezar por ~/');
  return path.resolve(expanded);
}

function defaultProfiles(userHome, env) {
  const explicitClaude = clean(env.CLAUDE_CONFIG_DIR, 4_096);
  const claudeHome = explicitClaude ? path.resolve(explicitClaude) : path.join(userHome, '.claude');
  const explicitCodex = clean(env.CODEX_HOME, 4_096);
  const codexHome = explicitCodex ? path.resolve(explicitCodex) : path.join(userHome, '.codex');
  return [
    {
      id: 'claude-default', provider: 'claude', label: 'Claude actual', home: claudeHome,
      accountFile: explicitClaude ? path.join(claudeHome, '.claude.json') : path.join(userHome, '.claude.json'),
      configured: false, isDefault: true,
      launchEnv: { ...(explicitClaude ? { CLAUDE_CONFIG_DIR: claudeHome } : {}), LCARS_ACCOUNT_PROFILE: 'claude-default' },
    },
    {
      id: 'codex-default', provider: 'codex', label: 'Codex actual', home: codexHome,
      accountFile: path.join(codexHome, 'auth.json'), configured: false, isDefault: true,
      launchEnv: { ...(explicitCodex ? { CODEX_HOME: codexHome, CODEX_SQLITE_HOME: codexHome } : {}), LCARS_ACCOUNT_PROFILE: 'codex-default' },
    },
  ];
}

function configuredProfile(raw, userHome) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw statusError('cada perfil debe ser un objeto');
  const id = clean(raw.id, 32), provider = clean(raw.provider, 20).toLowerCase();
  if (!PROFILE_ID.test(id)) throw statusError(`id de perfil no válido: ${id || '(vacío)'}`);
  if (!PROVIDERS.has(provider)) throw statusError(`proveedor de perfil no admitido: ${provider || '(vacío)'}`);
  const home = absoluteHome(raw.home, userHome);
  const label = clean(raw.label, 120) || id;
  const launchEnv = provider === 'claude'
    ? {
        CLAUDE_CONFIG_DIR: home,
        // Una credencial heredada ganaría al directorio seleccionado. Vaciarla evita arrancar con
        // otra cuenta por accidente; el login del perfil permanece en el almacén oficial de Claude.
        CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
        LCARS_ACCOUNT_PROFILE: id,
      }
    : { CODEX_HOME: home, CODEX_SQLITE_HOME: home, LCARS_ACCOUNT_PROFILE: id };
  return {
    id, provider, label, home,
    accountFile: path.join(home, provider === 'claude' ? '.claude.json' : 'auth.json'),
    configured: true, isDefault: false, launchEnv,
  };
}

/** Valida el documento completo antes de sustituir el catálogo activo. */
export function parseAccountProfiles(raw, { userHome = os.homedir(), env = process.env } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1 || !Array.isArray(raw.profiles)) {
    throw statusError('accounts.json necesita {"version":1,"profiles":[]}');
  }
  if (raw.profiles.length > MAX_PROFILES) throw statusError(`accounts.json admite hasta ${MAX_PROFILES} perfiles`);
  const profiles = defaultProfiles(userHome, env);
  const ids = new Set(profiles.map((profile) => profile.id));
  const homes = new Set(profiles.map((profile) => `${profile.provider}\0${profile.home}`));
  for (const entry of raw.profiles) {
    const profile = configuredProfile(entry, userHome);
    if (ids.has(profile.id)) throw statusError(`id de perfil duplicado: ${profile.id}`);
    const homeKey = `${profile.provider}\0${profile.home}`;
    if (homes.has(homeKey)) throw statusError(`directorio repetido para ${profile.provider}: ${profile.home}`);
    ids.add(profile.id); homes.add(homeKey); profiles.push(profile);
  }
  return profiles;
}

export class AccountProfileCatalog {
  constructor({
    file = process.env.LCARS_ACCOUNT_PROFILES || path.join(os.homedir(), '.config', 'lcars-bridge', 'accounts.json'),
    userHome = os.homedir(), env = process.env, log = null,
  } = {}) {
    this.file = file; this.userHome = userHome; this.env = env; this.log = log;
    this.profiles = defaultProfiles(userHome, env);
    this.loadedAt = 0; this.error = null; this.revision = 0;
  }

  async refresh(force = false) {
    if (!force && Date.now() - this.loadedAt < RELOAD_MS) return false;
    this.loadedAt = Date.now();
    const previousError = this.error;
    let next;
    try {
      next = parseAccountProfiles(await readJSONFile(this.file, { maxBytes: MAX_FILE_BYTES }), {
        userHome: this.userHome, env: this.env,
      });
      this.error = null;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.error = clean(error?.message || String(error), 500);
        this.log?.warn?.(`perfiles de cuenta: ${this.error}`);
      } else this.error = null;
      next = defaultProfiles(this.userHome, this.env);
    }
    const before = JSON.stringify(this.profiles);
    if (before === JSON.stringify(next) && previousError === this.error) return false;
    this.profiles = next; this.revision++;
    return true;
  }

  list() { return this.profiles.map((profile) => structuredClone(profile)); }

  publicList(extra = new Map()) {
    return this.profiles.map((profile) => {
      const state = extra.get(profile.id) || {};
      return {
        id: profile.id, provider: profile.provider, label: state.label || profile.label,
        configured: profile.configured, isDefault: profile.isDefault,
        accountKey: state.accountKey || null, headroom: state.headroom ?? null,
        signal: state.signal || 'none',
      };
    });
  }

  resolve(id, provider) {
    if (id != null && (typeof id !== 'string' || !id.trim())) throw statusError('perfil de cuenta no válido');
    const wanted = clean(id, 32);
    if (!PROVIDERS.has(provider)) {
      if (wanted) throw statusError(`el motor ${provider} no admite perfiles de cuenta`);
      return null;
    }
    const profile = wanted
      ? this.profiles.find((candidate) => candidate.id === wanted)
      : this.profiles.find((candidate) => candidate.provider === provider && candidate.isDefault);
    if (!profile) throw statusError(wanted ? `perfil de cuenta desconocido: ${wanted}` : `no hay perfil para ${provider}`);
    if (profile.provider !== provider) throw statusError(`el perfil ${profile.id} no pertenece a ${provider}`);
    return structuredClone(profile);
  }

  defaultFor(provider) { return this.resolve(null, provider); }

  roots(provider, child) {
    return [...new Set(this.profiles.filter((profile) => profile.provider === provider)
      .map((profile) => path.join(profile.home, child)))];
  }
}
