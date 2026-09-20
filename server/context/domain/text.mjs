// Normalizacion y limites de todo texto que cruza el limite de confianza de la memoria.
// Puro: las mismas entradas producen siempre la misma salida.

import { stableToken } from '../../stable-token.mjs';
export { stableToken } from '../../stable-token.mjs';

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const SECRET_PATTERNS = [
  /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gi,
  /\b(?:sk|rk|pk)-(?:live|test|proj)?[-_a-z0-9]{16,}\b/gi,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[a-z0-9_]{20,}\b/gi,
  /\b(?:xox[baprs]-[a-z0-9-]{12,})\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
  /\bBearer\s+[a-z0-9._~+/=-]{12,}\b/gi,
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[:=]\s*(["']?)[^\s,"']{8,}\2/gi,
];

export function redactSecrets(value) {
  let text = String(value ?? '').replace(CONTROL, '');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, label) => label ? `${label}=[REDACTADO]` : '[REDACTADO]');
  }
  return text;
}

export function boundedText(value, options = {}) {
  const name = options.name ?? options.field ?? 'texto';
  const max = options.max ?? 4_000;
  const empty = options.empty ?? options.allowEmpty ?? false;
  if (typeof value !== 'string') throw Object.assign(new TypeError(`${name} debe ser texto`), { status: 400 });
  const text = redactSecrets(value).trim();
  if (!empty && !text) throw Object.assign(new Error(`${name} no puede estar vacio`), { status: 400 });
  if (text.length > max) throw Object.assign(new Error(`${name} supera ${max} caracteres`), { status: 400 });
  return text;
}

/** Para datos observados: sanea y recorta en vez de convertir un transcript enorme en un fallo. */
export function cappedText(value, { max = 4_000, empty = true } = {}) {
  const text = redactSecrets(String(value ?? '')).trim().slice(0, max);
  if (!empty && !text) throw Object.assign(new Error('texto observado vacío'), { status: 400 });
  return text;
}

export const normalizedTextKey = (role, text) => `${role}:${stableToken(redactSecrets(text).replace(/\s+/g, ' ').trim())}`;
