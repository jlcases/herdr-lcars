// Adaptador de cuota de Claude. Las credenciales solo existen en memoria el tiempo necesario para
// consultar el endpoint fijo de Anthropic; nunca se devuelven al caso de uso, se registran ni llegan
// al navegador.
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { readJSONFile } from '../safe-json-file.mjs';
import { mapLimit } from '../concurrency.mjs';

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const MAX_CREDENTIAL_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const TOKEN_MAX = 64 * 1024;
const WINDOWS = Object.freeze([
  Object.freeze({ id: 'five_hour', minutes: 300 }),
  Object.freeze({ id: 'seven_day', minutes: 10_080 }),
]);

const fixedError = (code) => Object.assign(new Error(code), { code });

function accessTokenOf(value) {
  const token = value?.claudeAiOauth?.accessToken;
  if (typeof token !== 'string' || token.length < 16 || token.length > TOKEN_MAX || /\s/.test(token)) {
    throw fixedError('credential_invalid');
  }
  return token;
}

/** Claude Code separa los llaveros por CLAUDE_CONFIG_DIR con ocho hexadecimales de SHA-256. */
export function claudeCredentialService(profile) {
  const configDir = profile?.launchEnv?.CLAUDE_CONFIG_DIR;
  if (!configDir) return KEYCHAIN_SERVICE;
  const suffix = crypto.createHash('sha256').update(String(configDir).normalize('NFC')).digest('hex').slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${suffix}`;
}

function execFileText(execFileImpl, file, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, options, (error, stdout) => {
      if (error) reject(fixedError('credential_unavailable'));
      else resolve(String(stdout || ''));
    });
  });
}

/** Puerto de credenciales por plataforma: Keychain en macOS; fichero oficial privado fuera de él. */
export async function readClaudeAccessToken(profile, {
  platform = process.platform,
  username = os.userInfo().username,
  execFileImpl = nodeExecFile,
  readFile = readJSONFile,
} = {}) {
  if (!profile?.home) throw fixedError('profile_invalid');
  let credentials;
  if (platform === 'darwin') {
    const raw = await execFileText(execFileImpl, '/usr/bin/security', [
      'find-generic-password', '-a', username, '-w', '-s', claudeCredentialService(profile),
    ], { encoding: 'utf8', timeout: 5_000, maxBuffer: MAX_CREDENTIAL_BYTES, windowsHide: true });
    if (Buffer.byteLength(raw) > MAX_CREDENTIAL_BYTES) throw fixedError('credential_too_large');
    try { credentials = JSON.parse(raw); }
    catch { throw fixedError('credential_invalid'); }
  } else {
    try {
      credentials = await readFile(path.join(profile.home, '.credentials.json'), {
        maxBytes: MAX_CREDENTIAL_BYTES,
        requirePrivate: platform !== 'win32',
        platform,
      });
    } catch (error) {
      if (['FILE_TOO_LARGE', 'INSECURE_PERMISSIONS'].includes(error?.code)) throw fixedError(error.code.toLowerCase());
      throw fixedError('credential_unavailable');
    }
  }
  return accessTokenOf(credentials);
}

const validPercent = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
};

export function normalizeClaudeUsage(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fixedError('response_invalid');
  const windows = [];
  for (const spec of WINDOWS) {
    const raw = payload[spec.id], usedPercent = validPercent(raw?.utilization);
    if (usedPercent == null) continue;
    const parsedReset = Date.parse(raw?.resets_at);
    windows.push({
      ...spec,
      usedPercent,
      resetsAt: Number.isFinite(parsedReset) ? Math.floor(parsedReset / 1_000) : null,
    });
  }
  if (!windows.length) throw fixedError('response_invalid');
  return windows;
}

async function responseText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw fixedError('response_too_large');
  if (!response?.body?.getReader) {
    const raw = await response.text();
    if (Buffer.byteLength(raw) > maxBytes) throw fixedError('response_too_large');
    return raw;
  }
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw fixedError('response_too_large');
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (total > maxBytes) await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Consulta aislada e inyectable: la URL no procede de configuración ni del navegador. */
export async function fetchClaudeUsage(profile, {
  fetchImpl = globalThis.fetch,
  readAccessToken = readClaudeAccessToken,
  timeoutMs = 7_000,
} = {}) {
  const token = await readAccessToken(profile);
  let response;
  try {
    response = await fetchImpl(CLAUDE_USAGE_URL, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        accept: 'application/json',
        'user-agent': 'herdr-lcars/0.1',
      },
    });
  } catch { throw fixedError('network_unavailable'); }
  if (!response?.ok) throw fixedError(`http_${Number(response?.status) || 0}`);
  let payload;
  try { payload = JSON.parse(await responseText(response)); }
  catch (error) {
    if (error?.code) throw error;
    throw fixedError('response_invalid');
  }
  return normalizeClaudeUsage(payload);
}

/**
 * Sondea sin solapar rondas. El registro de cuentas sigue siendo la autoridad de mezcla y alertas;
 * este adaptador solo transforma Anthropic a observaciones del puerto `report`.
 */
export class ClaudeUsageMonitor {
  constructor({
    targets,
    onUsage,
    fetchUsage = fetchClaudeUsage,
    log = console,
    now = () => Date.now(),
    intervalMs = 60_000,
    concurrency = 2,
  } = {}) {
    if (typeof targets !== 'function' || typeof onUsage !== 'function') {
      throw new TypeError('ClaudeUsageMonitor necesita targets y onUsage');
    }
    this.targets = targets; this.onUsage = onUsage; this.fetchUsage = fetchUsage;
    this.log = log; this.now = now; this.intervalMs = intervalMs; this.concurrency = concurrency;
    this.running = false; this.closed = false; this.timer = null; this.failures = new Map();
  }

  start() {
    if (this.timer || this.closed) return;
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, this.intervalMs);
    this.timer.unref?.();
  }

  async poll() {
    if (this.running || this.closed) return false;
    this.running = true;
    try {
      const unique = new Map();
      for (const target of this.targets() || []) {
        if (target?.accountKey && target?.profile?.provider === 'claude' && !unique.has(target.accountKey)) {
          unique.set(target.accountKey, target);
        }
      }
      await mapLimit([...unique.values()], this.concurrency, async (target) => {
        try {
          const windows = await this.fetchUsage(target.profile);
          this.failures.delete(target.profile.id);
          this.onUsage(target.accountKey, windows, { profileId: target.profile.id, at: this.now() });
        } catch (error) {
          // Solo se registra un código cerrado y únicamente cuando cambia: ni token, ni respuesta,
          // ni stderr del almacén de credenciales pueden acabar en bridge.log.
          const code = /^[a-z0-9_]+$/.test(error?.code || '') ? error.code : 'usage_unavailable';
          if (this.failures.get(target.profile.id) !== code) {
            this.failures.set(target.profile.id, code);
            this.log?.warn?.(`cuota Claude (${target.profile.id}): ${code}`);
          }
        }
      });
      return true;
    } finally { this.running = false; }
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
