// Receptor OTLP HTTP/JSON mínimo: convierte logs y métricas de Claude Code en eventos planos.
// Claude Code exporta con OTEL_EXPORTER_OTLP_PROTOCOL=http/json a /v1/logs, /v1/metrics y /v1/traces.

export const MAX_LOG_EVENTS = 10_000;
const MAX_ATTRIBUTES = 128;
const MAX_ARRAY_VALUES = 128;
const MAX_VALUE_CHARS = 4096;
const MAX_DEPTH = 8;

const listOf = (value) => Array.isArray(value) ? value : [];
const text = (value, max = MAX_VALUE_CHARS) => typeof value === 'string' ? value.slice(0, max) : null;

function attrValue(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > MAX_DEPTH) return null;
  if ('stringValue' in v) return text(v.stringValue);
  if ('intValue' in v) { const n = Number(v.intValue); return Number.isFinite(n) ? n : null; }
  if ('doubleValue' in v) { const n = Number(v.doubleValue); return Number.isFinite(n) ? n : null; }
  if ('boolValue' in v) return Boolean(v.boolValue);
  if ('arrayValue' in v) return listOf(v.arrayValue?.values).slice(0, MAX_ARRAY_VALUES).map((item) => attrValue(item, depth + 1));
  if ('kvlistValue' in v) return attrsToObject(v.kvlistValue?.values, depth + 1);
  return null;
}
export function attrsToObject(list = [], depth = 0) {
  const out = Object.create(null);
  if (depth > MAX_DEPTH) return out;
  for (const item of listOf(list).slice(0, MAX_ATTRIBUTES)) {
    const key = text(item?.key, 256);
    if (key) out[key] = attrValue(item.value, depth);
  }
  return out;
}
const nanoToMs = (n) => {
  try { const v = n ? Number(BigInt(n) / 1000000n) : 0; return Number.isFinite(v) && v > 0 ? v : Date.now(); }
  catch { return Date.now(); }
};

/** Devuelve [{name, ts, attrs, resource}] a partir de un payload OTLP de logs. */
export function parseLogs(payload) {
  const out = [];
  outer: for (const rl of listOf(payload?.resourceLogs)) {
    const resource = attrsToObject(rl?.resource?.attributes);
    for (const sl of listOf(rl?.scopeLogs)) {
      for (const rec of listOf(sl?.logRecords)) {
        if (out.length >= MAX_LOG_EVENTS) break outer;
        const attrs = attrsToObject(rec?.attributes);
        const body = rec?.body ? attrValue(rec.body) : null;
        const name = text(attrs['event.name']) || text(rec?.eventName) || (typeof body === 'string' ? body : null);
        out.push({ name, ts: nanoToMs(rec?.timeUnixNano || rec?.observedTimeUnixNano), attrs, resource, body });
      }
    }
  }
  return out;
}
