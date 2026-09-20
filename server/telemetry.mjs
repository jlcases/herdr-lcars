// Almacén de telemetría por sesión, común a todos los CLIs.
//
// Varias fuentes pueden describir la misma sesión y no todas tienen la misma fidelidad, así que cada
// una declara aquí su rango: la de mayor rango gana, tanto para etiquetar la sesión como para sustituir
// una petición ya registrada. Es lo único que hay que tocar para añadir un CLI nuevo.
import { costOf } from './pricing.mjs';
import { isSafeSessionId, requireSafeSessionId } from './identifiers.mjs';

const SOURCES = {
  otlp: { rank: 3, approx: false, label: 'OTEL' },          // medido por Claude Code (TTFT y duración reales)
  codex: { rank: 3, approx: false, label: 'codex' },        // rollout de Codex (TTFT y duración reales)
  opencode: { rank: 3, approx: false, label: 'opencode' },  // base de OpenCode (coste real)
  pi: { rank: 3, approx: false, label: 'pi' },              // JSONL nativo de Pi (tokens y coste reportados)
  transcript: { rank: 1, approx: true, label: 'transcript ~' }, // reconstruido del transcript: sin TTFT
};
const rankOf = (source) => SOURCES[source]?.rank ?? 0;

const MAX_REQUESTS = 400;        // peticiones retenidas por sesión
export const MAX_SESSIONS = 2048;
const SERIES_BUCKET_MS = 60_000; // resolución de la serie temporal (1 min)
const SERIES_POINTS = 60;        // última hora
export const FLEET_WINDOW_MS = 2 * SERIES_BUCKET_MS; // ventana de «tokens por minuto» de la flota

const boundedText = (value, max) => typeof value === 'string' && value
  ? value.slice(0, max) : null;
const boundedNumber = (value, max = 1e12) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(0, number)) : 0;
};
const timestamp = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.min(number, Date.now() + 24 * 3600_000) : Date.now();
};
const cacheCreation = (value) => value && typeof value === 'object' ? {
  ephemeral_5m_input_tokens: boundedNumber(value.ephemeral_5m_input_tokens),
  ephemeral_1h_input_tokens: boundedNumber(value.ephemeral_1h_input_tokens),
} : null;

const normalizeWindow = (window) => window && typeof window === 'object' ? {
  used_percentage: boundedNumber(window.used_percentage ?? window.used_percent, 100),
  resets_at: boundedNumber(window.resets_at, 1e12) || null,
  window_minutes: boundedNumber(window.window_minutes, 100_000) || null,
} : null;

const normalizeRateLimits = (limits) => limits && typeof limits === 'object' ? {
  source: boundedText(limits.source, 40), plan: boundedText(limits.plan, 80),
  five_hour: normalizeWindow(limits.five_hour), seven_day: normalizeWindow(limits.seven_day),
  primary: normalizeWindow(limits.primary), secondary: normalizeWindow(limits.secondary),
} : null;

/** Recorta un Set que solo sirve para deduplicar, conservando lo más reciente. */
const capSet = (set, max) => (set.size > max ? new Set([...set].slice(-Math.floor(max / 2))) : set);

/** Velocidad de decodificación: descuenta el tiempo hasta el primer token. */
const speedOf = (r) => r.output / Math.max(0.05, (r.durationMs - (r.ttftMs || 0)) / 1000);

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export class SessionTelemetry {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.source = null;            // clave de SOURCES
    this.requests = [];            // {ts, source, kind, model, input, output, cacheRead, cacheWrite, durationMs, ttftMs, costUsd, …}
    this.seenRequestIds = new Set();
    this.seenToolKeys = new Set();
    this.seenTurnKeys = new Set();
    this.tools = { count: 0, failed: 0, byName: new Map() };
    this.totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, requests: 0, errors: 0, turns: 0 };
    this.series = new Map();       // bucketTs -> {ts, output, input, cost, requests, genMs}
    this.status = null;            // último JSON del statusline
    this.statusAt = 0;
    this.context = null;           // lo reporta el statusline o un adaptador
    this.rateLimits = null;
    this.rateLimitsAt = 0;
    this.lastActivity = 0;
    this.model = null;
    this.effort = null;
    this.provider = null;
    this.local = null;
    this.firstSeen = Date.now();
    this.dirty = true;
  }

  /** ¿Aporta algo esta fuente, o ya hay una mejor describiendo la sesión? */
  accepts(source) { return rankOf(source) >= rankOf(this.source); }

  _bucket(ts) {
    const b = Math.floor(ts / SERIES_BUCKET_MS) * SERIES_BUCKET_MS;
    let s = this.series.get(b);
    if (!s) {
      s = { ts: b, output: 0, input: 0, cost: 0, requests: 0, genMs: 0 };
      this.series.set(b, s);
      if (this.series.size > SERIES_POINTS) {
        const keys = [...this.series.keys()].sort((a, b2) => a - b2);
        for (const k of keys.slice(0, keys.length - SERIES_POINTS)) this.series.delete(k);
      }
    }
    return s;
  }

  /** Suma (sign=+1) o deshace (sign=-1) una petición sobre totales y serie temporal. */
  _apply(r, sign) {
    const t = this.totals;
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) t[k] += sign * (r[k] || 0);
    t.costUsd += sign * (r.costUsd || 0);
    t.requests += sign;
    if (r.success === false) t.errors = Math.max(0, t.errors + sign);
    const s = sign > 0 ? this._bucket(r.ts) : this.series.get(Math.floor(r.ts / SERIES_BUCKET_MS) * SERIES_BUCKET_MS);
    if (!s) return;
    s.output += sign * (r.output || 0);
    s.input += sign * ((r.input || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0));
    s.cost += sign * (r.costUsd || 0);
    s.requests += sign;
    if (r.durationMs && r.output) s.genMs += sign * Math.max(1, r.durationMs - (r.ttftMs || 0));
  }

  addRequest(r, source) {
    r = {
      ts: timestamp(r?.ts), requestId: boundedText(r?.requestId, 256), model: boundedText(r?.model, 200),
      input: boundedNumber(r?.input), output: boundedNumber(r?.output),
      cacheRead: boundedNumber(r?.cacheRead), cacheWrite: boundedNumber(r?.cacheWrite),
      reasoning: boundedNumber(r?.reasoning), cacheCreation: cacheCreation(r?.cacheCreation),
      durationMs: boundedNumber(r?.durationMs, 7 * 86400_000),
      ttftMs: r?.ttftMs == null ? null : boundedNumber(r.ttftMs, 7 * 86400_000),
      costUsd: r?.costUsd == null ? null : boundedNumber(r.costUsd, 1e9),
      stopReason: boundedText(r?.stopReason, 120), effort: boundedText(r?.effort, 80),
      kind: ['main', 'aux', 'subagent'].includes(r?.kind) ? r.kind : 'main',
      agentName: boundedText(r?.agentName, 160), turnId: boundedText(r?.turnId, 256),
      success: r?.success !== false,
    };
    r.source = source;
    if (r.requestId) {
      if (this.seenRequestIds.has(r.requestId)) {
        // Ya la teníamos: solo la sustituimos si esta fuente es más fiable (p. ej. OTLP sobre transcript).
        const idx = this.requests.findIndex((x) => x.requestId === r.requestId);
        if (idx === -1 || rankOf(source) <= rankOf(this.requests[idx].source)) return false;
        this._apply(this.requests[idx], -1);
        this.requests.splice(idx, 1);
      } else {
        this.seenRequestIds.add(r.requestId);
        this.seenRequestIds = capSet(this.seenRequestIds, 5000);
      }
    }
    if (this.accepts(source)) this.source = source;
    if (r.costUsd != null) this.costReported = true; // la fuente trae coste real (OTLP, OpenCode)
    if (r.costUsd == null) r.costUsd = costOf(r.model, {
      input_tokens: r.input, output_tokens: r.output, cache_read_input_tokens: r.cacheRead,
      cache_creation_input_tokens: r.cacheWrite, cache_creation: r.cacheCreation,
    });
    this.requests.push(r);
    if (this.requests.length > MAX_REQUESTS) this.requests.splice(0, this.requests.length - MAX_REQUESTS);
    this._apply(r, +1);
    if (r.model && r.model !== '<synthetic>') this.model = r.model;
    if (r.effort) this.effort = r.effort;
    if (r.agentName) this.hasAgentNames = true;
    this.lastActivity = Math.max(this.lastActivity, r.ts);
    this.dirty = true;
    return true;
  }

  addTool(t) {
    t = {
      ts: timestamp(t?.ts), key: boundedText(t?.key, 256), name: boundedText(t?.name, 160),
      durationMs: boundedNumber(t?.durationMs, 7 * 86400_000), success: t?.success !== false,
    };
    if (t.key) {
      if (this.seenToolKeys.has(t.key)) return false;
      this.seenToolKeys.add(t.key);
      this.seenToolKeys = capSet(this.seenToolKeys, 8000);
    }
    this.tools.count += 1;
    if (t.success === false) this.tools.failed += 1;
    if (t.name) this.tools.byName.set(t.name, (this.tools.byName.get(t.name) || 0) + 1);
    this.lastActivity = Math.max(this.lastActivity, t.ts || Date.now());
    this.dirty = true;
    return true;
  }

  addTurn(key) {
    key = boundedText(key, 256);
    if (key) {
      if (this.seenTurnKeys.has(key)) return false;
      this.seenTurnKeys.add(key);
      this.seenTurnKeys = capSet(this.seenTurnKeys, 4000);
    }
    this.totals.turns += 1;
    this.dirty = true;
    return true;
  }

  setContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return;
    const current = ctx.current && typeof ctx.current === 'object' ? {
      input_tokens: boundedNumber(ctx.current.input_tokens), output_tokens: boundedNumber(ctx.current.output_tokens),
      cache_read_input_tokens: boundedNumber(ctx.current.cache_read_input_tokens),
      cache_creation_input_tokens: boundedNumber(ctx.current.cache_creation_input_tokens),
    } : null;
    this.context = {
      usedPercent: boundedNumber(ctx.usedPercent ?? ctx.used_percentage, 100),
      size: boundedNumber(ctx.size ?? ctx.context_window_size), current,
    };
    this.dirty = true;
  }
  setRateLimits(rl, at = Date.now()) {
    const observedAt = timestamp(at);
    if (this.rateLimits && observedAt < this.rateLimitsAt) return false;
    this.rateLimits = normalizeRateLimits(rl); this.rateLimitsAt = observedAt; this.dirty = true;
    return true;
  }
  setIdentity({ model, effort, provider, local } = {}) {
    const safeModel = boundedText(model, 200), safeEffort = boundedText(effort, 80);
    const safeProvider = boundedText(provider, 120);
    if (safeModel) this.model = safeModel;
    if (safeEffort) this.effort = safeEffort;
    if (safeProvider) this.provider = safeProvider;
    if (typeof local === 'boolean') this.local = local;
    if (safeModel || safeEffort || safeProvider || typeof local === 'boolean') this.dirty = true;
  }

  /** JSON del statusline de Claude Code, traducido al vocabulario del panel. */
  setStatus(json, at = Date.now()) {
    if (!json || typeof json !== 'object') return;
    const cost = json.cost && typeof json.cost === 'object' ? {
      total_cost_usd: boundedNumber(json.cost.total_cost_usd, 1e9),
      total_duration_ms: boundedNumber(json.cost.total_duration_ms, 365 * 86400_000),
      total_api_duration_ms: boundedNumber(json.cost.total_api_duration_ms, 365 * 86400_000),
      total_lines_added: boundedNumber(json.cost.total_lines_added),
      total_lines_removed: boundedNumber(json.cost.total_lines_removed),
    } : null;
    const model = boundedText(json.model?.id, 200), effort = boundedText(json.effort?.level, 80);
    this.status = { model: model ? { id: model } : null, effort: effort ? { level: effort } : null, cost };
    this.statusAt = timestamp(at); this.dirty = true;
    this.setIdentity({ model, effort });
    const cw = json?.context_window;
    if (cw) this.setContext({ usedPercent: cw.used_percentage, size: cw.context_window_size, current: cw.current_usage });
    if (json?.rate_limits) this.setRateLimits(json.rate_limits, at);
  }

  /** Métricas de las últimas N peticiones con datos de tiempo. Las auxiliares no cuentan. */
  recent(n = 20) {
    const rs = [];
    for (let i = this.requests.length - 1; i >= 0 && rs.length < n; i--) {
      if (this.requests[i].kind !== 'aux') rs.unshift(this.requests[i]);
    }
    const withTime = rs.filter((r) => r.durationMs > 0 && r.output > 0);
    return {
      ttftP50: percentile(rs.map((r) => r.ttftMs).filter((v) => v > 0), 0.5),
      ttftP95: percentile(rs.map((r) => r.ttftMs).filter((v) => v > 0), 0.95),
      tokPerSecP50: percentile(withTime.map(speedOf), 0.5),
      tokPerSecLast: withTime.length ? speedOf(withTime.at(-1)) : null,
      durationP50: percentile(rs.map((r) => r.durationMs).filter((v) => v > 0), 0.5),
      cacheHitRatio: (() => {
        const cacheIn = rs.reduce((a, r) => a + (r.cacheRead || 0), 0);
        const allIn = rs.reduce((a, r) => a + (r.input || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0), 0);
        return allIn ? cacheIn / allIn : null;
      })(),
      sample: rs.length,
    };
  }

  /** Agregado por subagente, derivado de las peticiones que llevan nombre de agente. */
  byAgent() {
    if (!this.hasAgentNames) return [];
    const by = new Map();
    for (const r of this.requests) {
      if (!r.agentName) continue;
      let b = by.get(r.agentName);
      if (!b) { b = { name: r.agentName, requests: 0, output: 0, costUsd: 0, ttfts: [], speeds: [] }; by.set(r.agentName, b); }
      b.requests++; b.output += r.output || 0; b.costUsd += r.costUsd || 0;
      if (r.ttftMs > 0) b.ttfts.push(r.ttftMs);
      if (r.durationMs > 0 && r.output > 0) b.speeds.push(speedOf(r));
    }
    return [...by.values()].map((b) => ({
      name: b.name, requests: b.requests, output: b.output, costUsd: +b.costUsd.toFixed(4),
      ttftP50: percentile(b.ttfts, 0.5), tokPerSecP50: percentile(b.speeds, 0.5),
    }));
  }

  toJSON() {
    const st = this.status || {};
    return {
      sessionId: this.sessionId,
      source: this.source,
      sourceLabel: SOURCES[this.source]?.label || this.source || 'sin datos',
      approx: SOURCES[this.source]?.approx ?? true,
      model: this.model,
      effort: this.effort,
      provider: this.provider,
      local: this.local,
      totals: { ...this.totals, costUsd: +this.totals.costUsd.toFixed(4) },
      // Coste ya resuelto: el acumulado del statusline cubre la sesión entera y gana a lo que hemos visto.
      costUsd: +(st.cost?.total_cost_usd ?? this.totals.costUsd).toFixed(4),
      costBasis: st.cost ? 'statusline' : this.costReported ? 'reported' : 'estimate',
      recent: this.recent(),
      tools: { count: this.tools.count, failed: this.tools.failed,
        top: [...this.tools.byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5) },
      context: this.context,
      cost: st.cost ? { totalUsd: st.cost.total_cost_usd, durationMs: st.cost.total_duration_ms, apiDurationMs: st.cost.total_api_duration_ms,
        linesAdded: st.cost.total_lines_added, linesRemoved: st.cost.total_lines_removed } : null,
      rateLimits: this.rateLimits,
      accountKey: this.accountKey || null,
      byAgent: this.byAgent(),
      lastActivity: this.lastActivity || null,
      series: [...this.series.values()].sort((a, b) => a.ts - b.ts).map((s) => ({
        ts: s.ts, output: s.output, input: s.input, cost: +s.cost.toFixed(4), requests: s.requests,
        tokPerSec: s.genMs ? +(s.output / (s.genMs / 1000)).toFixed(1) : null,
      })),
    };
  }
}

/** Clasifica una petición de Claude Code por su `query_source`. */
function classifyQuerySource(qs) {
  const s = String(qs || '');
  if (s.startsWith('agent:')) return { kind: 'subagent', agentName: s.split(':').pop() };
  if (/title|summary|compact|auxiliary|suggestion|prefetch/i.test(s)) return { kind: 'aux', agentName: null };
  return { kind: 'main', agentName: null };
}

export class TelemetryStore {
  constructor({ maxSessions = MAX_SESSIONS } = {}) {
    this.sessions = new Map(); this.listeners = new Set();
    this.maxSessions = Math.max(1, Math.min(MAX_SESSIONS, Math.trunc(Number(maxSessions)) || MAX_SESSIONS));
  }
  get(sessionId) {
    requireSafeSessionId(sessionId);
    let s = this.sessions.get(sessionId);
    if (!s) {
      if (this.sessions.size >= this.maxSessions) {
        const oldest = [...this.sessions.entries()].sort((a, b) =>
          Math.max(a[1].lastActivity || 0, a[1].statusAt || 0, a[1].firstSeen || 0)
          - Math.max(b[1].lastActivity || 0, b[1].statusAt || 0, b[1].firstSeen || 0))[0];
        if (oldest) this.sessions.delete(oldest[0]);
      }
      s = new SessionTelemetry(sessionId); this.sessions.set(sessionId, s);
    }
    return s;
  }
  has(sessionId) { return isSafeSessionId(sessionId) && this.sessions.has(sessionId); }
  /** Consulta sin efectos secundarios: no crea la sesión si no existe. */
  accepts(sessionId, source) { if (!isSafeSessionId(sessionId)) return false; const s = this.sessions.get(sessionId); return !s || s.accepts(source); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  notify(sessionId, kind, payload) {
    for (const fn of this.listeners) {
      try { fn({ sessionId, kind, payload }); } catch { /* un consumidor no rompe la ingesta */ }
    }
  }

  /** Ingesta de eventos OTLP (logs de Claude Code). */
  ingestLogEvents(events) {
    let n = 0;
    for (const ev of Array.isArray(events) ? events.slice(0, 10_000) : []) {
      const a = ev?.attrs && typeof ev.attrs === 'object' ? ev.attrs : {};
      const resource = ev?.resource && typeof ev.resource === 'object' ? ev.resource : {};
      const sid = a['session.id'] || resource['session.id'];
      if (!isSafeSessionId(sid) || (!this.sessions.has(sid) && this.sessions.size >= this.maxSessions)) continue;
      const s = this.get(sid);
      const name = (boundedText(ev?.name, 200) || '').replace(/^claude_code\./, '');
      if (name === 'api_request') {
        const { kind, agentName } = classifyQuerySource(a.query_source);
        const ok = s.addRequest({
          ts: ev.ts, requestId: a.request_id || a.client_request_id || null, model: a.model,
          input: +a.input_tokens || 0, output: +a.output_tokens || 0,
          cacheRead: +a.cache_read_tokens || 0, cacheWrite: +a.cache_creation_tokens || 0,
          durationMs: +a.duration_ms || 0, ttftMs: +(a.time_to_first_token_ms ?? a.ttft_ms) || null,
          costUsd: a.cost_usd != null ? +a.cost_usd : null, stopReason: a.stop_reason || null,
          success: a.success == null ? true : String(a.success) === 'true', effort: a.effort || null,
          kind, agentName: a['agent.name'] || agentName,
        }, 'otlp');
        // Identidad de la cuenta que paga esta sesión: es el único sitio donde Claude Code la publica.
        if (a['user.account_uuid']) s.accountUuid = boundedText(a['user.account_uuid'], 200);
        if (ok) { n++; this.notify(sid, 'request', s.requests.at(-1)); }
      } else if (name === 'api_error') {
        // El fallo ya se contabiliza con su api_request (success=false); aquí solo se anuncia.
        s.dirty = true; n++;
        this.notify(sid, 'error', { ts: timestamp(ev.ts), model: boundedText(a.model, 200),
          error: boundedText(a.error, 2_000), statusCode: boundedText(String(a.status_code ?? ''), 40) });
      } else if (name === 'tool_result') {
        const tool = { ts: timestamp(ev.ts), name: boundedText(a.tool_name, 160), success: String(a.success) !== 'false',
          durationMs: boundedNumber(a.duration_ms, 7 * 86400_000), key: boundedText(a.tool_use_id, 256) };
        s.addTool(tool); n++;
        this.notify(sid, 'tool', tool);
      } else if (name === 'user_prompt') {
        s.addTurn(a['message.uuid'] || a['prompt.id'] || null); n++;
        this.notify(sid, 'prompt', { ts: timestamp(ev.ts), length: boundedNumber(a.prompt_length, 10_000_000) });
      }
    }
    return n;
  }

  /** Olvida las sesiones que ya no tienen agente vivo y llevan un rato sin actividad. */
  evict(aliveSessionIds, maxIdleMs = 30 * 60_000) {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (aliveSessionIds.has(id)) continue;
      if (now - Math.max(s.lastActivity || 0, s.statusAt || 0, s.firstSeen || 0) > maxIdleMs) this.sessions.delete(id);
    }
  }
}
