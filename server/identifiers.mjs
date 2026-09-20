// Los identificadores de sesion acaban formando nombres de fichero o consultas locales. Mantener una
// unica politica evita que un adaptador acepte rutas que otro rechazaria.

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function isSafeSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value) && !RESERVED_OBJECT_KEYS.has(value);
}

export function requireSafeSessionId(value) {
  if (!isSafeSessionId(value)) {
    throw Object.assign(new Error('sessionId no valido'), { status: 400, code: 'INVALID_SESSION_ID' });
  }
  return value;
}
