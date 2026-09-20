// Vocabulario de eventos del contexto de trabajo. Puro.
//
// El registro es el pliegue validado de estos eventos en memoria y se persiste como snapshot
// versionado. No se presenta como un event store: esa distinción evita prometer reconstrucción total.
//
// Dos capas, a propósito:
//   - MECÁNICA: la escribe el puente a partir de git y de los transcripts. No pide permiso a nadie
//     y por eso funciona con cualquier motor, incluso con los que no sé leer.
//   - NARRATIVA: la escribe el motor si sabe y quiere. Si no colabora, el registro sigue sirviendo.

/** Capas. La mecánica nunca puede ser sobrescrita por un motor: son hechos, no opiniones. */
export const LAYER = { MECHANICAL: 'mechanical', NARRATIVE: 'narrative' };

/**
 * Tipos de evento y su capa. Añadir un tipo es añadir una fila aquí y un reductor en `record.mjs`:
 * el resto del sistema no se entera.
 */
export const EVENT_TYPES = {
  worktree_observed: LAYER.MECHANICAL,
  commit: LAYER.MECHANICAL,
  failure: LAYER.MECHANICAL,
  turn: LAYER.MECHANICAL,
  engine_seen: LAYER.MECHANICAL,
  handoff_started: LAYER.MECHANICAL,
  handoff_finished: LAYER.MECHANICAL,
  requirement: LAYER.NARRATIVE,
  goal_set: LAYER.NARRATIVE,
  decision: LAYER.NARRATIVE,
  next_step: LAYER.NARRATIVE,
};

export const isKnownType = (type) => Object.hasOwn(EVENT_TYPES, type);
export const layerOf = (type) => EVENT_TYPES[type] ?? null;

const isPositiveInt = (n) => Number.isInteger(n) && n > 0;
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;
const textWithin = (value, max) => nonEmpty(value) && value.length <= max;
const pathWithin = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const optionalText = (value, max) => value == null || (typeof value === 'string' && value.length <= max);
const endpointWithin = (value) => value && typeof value === 'object'
  && textWithin(value.kind, 40) && optionalText(value.sessionId, 200)
  && optionalText(value.paneId, 120) && optionalText(value.name, 120);

/** Comprobaciones por tipo. Devuelven un motivo, o null si el evento es válido. */
const RULES = {
  worktree_observed: (e) => (Array.isArray(e.files) && e.files.length <= 400
    && e.files.every((f) => pathWithin(f?.path, 2_000) && textWithin(f?.status, 8) && (f?.previousPath == null || pathWithin(f.previousPath, 2_000))
      && (f?.added == null || (Number.isInteger(f.added) && f.added >= 0)) && (f?.removed == null || (Number.isInteger(f.removed) && f.removed >= 0)))
    && textWithin(e.fingerprint, 200) && optionalText(e.head, 80)
    && (e.totalFiles == null || (Number.isInteger(e.totalFiles) && e.totalFiles >= e.files.length))
    ? null : 'worktree_observed necesita un snapshot acotado, files y fingerprint'),
  commit: (e) => (textWithin(e.sha, 80) && optionalText(e.subject, 500) ? null : 'commit necesita sha válido'),
  failure: (e) => (textWithin(e.text, 1_000) && optionalText(e.sourceKey, 300) ? null : 'failure necesita text acotado'),
  turn: (e) => (textWithin(e.text, 8_000) && optionalText(e.sourceKey, 300) && ['humano', 'agente'].includes(e.role) ? null : 'turn necesita role humano|agente y text acotado'),
  engine_seen: (e) => (textWithin(e.kind, 40) && textWithin(e.paneId, 120) && optionalText(e.sessionId, 200) ? null : 'engine_seen necesita kind y paneId válidos'),
  handoff_started: (e) => (textWithin(e.id, 128) && endpointWithin(e.from) && endpointWithin(e.to) && optionalText(e.paneId, 120)
    ? null : 'handoff_started necesita id, from y to validos'),
  handoff_finished: (e) => (textWithin(e.id, 128) && ['completed', 'failed'].includes(e.status)
    && typeof e.delivered === 'boolean' && endpointWithin(e.to) && optionalText(e.error, 1_000)
    ? null : 'handoff_finished necesita id, destino, delivered y status completed|failed'),
  requirement: (e) => (textWithin(e.name, 160) && ['mcp', 'permission'].includes(e.kind) ? null : 'requirement necesita kind mcp|permission y name'),
  goal_set: (e) => (textWithin(e.text, 4_000) && optionalText(e.by, 64) ? null : 'goal_set necesita text'),
  decision: (e) => (textWithin(e.text, 2_000) && optionalText(e.by, 64) ? null : 'decision necesita text'),
  next_step: (e) => (textWithin(e.text, 4_000) && optionalText(e.by, 64) ? null : 'next_step necesita text'),
};

/**
 * Motivo por el que un evento no es válido, o null si lo es.
 * Se valida en el borde del dominio para que el pliegue no tenga que defenderse de nada.
 */
export function invalidReason(event) {
  if (!event || typeof event !== 'object') return 'el evento debe ser un objeto';
  if (!isKnownType(event.type)) return `tipo de evento desconocido: ${String(event.type)}`;
  if (!isPositiveInt(event.at)) return 'el evento necesita una marca de tiempo «at» en milisegundos';
  return RULES[event.type](event);
}

/** Valida y normaliza un evento; lanza con un motivo legible si no sirve. */
export function makeEvent(type, at, fields = {}) {
  const event = { type, at, ...fields };
  const reason = invalidReason(event);
  if (reason) throw Object.assign(new Error(reason), { status: 400 });
  return event;
}
