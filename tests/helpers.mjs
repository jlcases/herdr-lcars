// Constructores de cargas OTLP para las pruebas.
export const otlpLog = (name, attrs, ts = Date.now()) => ({
  resourceLogs: [{ resource: {}, scopeLogs: [{ logRecords: [{
    timeUnixNano: String(BigInt(ts) * 1000000n),
    attributes: Object.entries({ 'event.name': name, ...attrs }).map(([key, v]) => ({
      key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: String(v) },
    })),
  }] }] }],
});
export const apiRequest = (attrs) => otlpLog('api_request', attrs);
