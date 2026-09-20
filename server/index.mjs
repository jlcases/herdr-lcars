// Servidor LCARS for Herdr: HTTP estático + SSE + receptor OTLP + control de Herdr.
import http from 'node:http';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as herdr from './herdr.mjs';
import { parseLogs } from './otlp.mjs';
import { TelemetryStore } from './telemetry.mjs';
import { TranscriptWatcher } from './transcripts.mjs';
import { StatusDropWatcher } from './statusdrop.mjs';
import { SubagentWatcher } from './subagents.mjs';
import { CodexAdapter } from './adapters/codex.mjs';
import { OpenCodeAdapter } from './adapters/opencode.mjs';
import { ClaudeUsageMonitor } from './adapters/claude-usage.mjs';
import { readLimits } from './limits.mjs';
import { AccountRegistry } from './accounts.mjs';
import { AccountProfileCatalog } from './account-profiles.mjs';
import { buildContextMemory } from './context/composition.mjs';
import { ActivityScheduler } from './context/scheduler.mjs';
import { systemClock } from './context/adapters/systemClock.mjs';
import { createClaudeThreadSource, createCodexThreadSource } from './context/adapters/threadSources.mjs';
import { execFile } from 'node:child_process';
import { isSafeSessionId } from './identifiers.mjs';
import { mapLimit } from './concurrency.mjs';

// Un CLI nuevo entra aquí y en su fichero de adaptador; el resto del servidor no cambia.
const ADAPTERS = [CodexAdapter, OpenCodeAdapter];

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PUBLIC_REAL = await fsp.realpath(PUBLIC);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const TICKER_MAX = 200;
const POLL_MS = 1000;
const MAX_BODY = 16 * 1024 * 1024;        // cuerpo comprimido admitido
const MAX_INFLATED = 64 * 1024 * 1024;    // tope tras descomprimir (evita bombas gzip)
const MAX_CONTROL_BODY = 64 * 1024;
const MAX_READ_LINES = 2000;
const MAX_READ_CHARS = 2 * 1024 * 1024;
const MAX_SSE_CLIENTS = 32;
const STATUSES = new Set(['blocked', 'working', 'done', 'idle', 'unknown']);
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const clipText = (value, max) => typeof value === 'string' ? value.replace(CONTROL_CHARS, '').slice(0, max) : '';
const clipPath = (value, max) => typeof value === 'string' && !value.includes('\0') ? value.slice(0, max) : '';
const statusOf = (value) => STATUSES.has(value) ? value : 'unknown';
const safeNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const cleanEvent = (event) => {
  const out = {};
  for (const [key, value] of Object.entries(event || {})) {
    if (typeof value === 'string') out[key] = clipText(value, ['message', 'error', 'description'].includes(key) ? 2_000 : 500);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean' || value == null) out[key] = value;
  }
  return out;
};

const gunzip = promisify(zlib.gunzip), inflate = promisify(zlib.inflate);
const sseFrame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; script-src-attr 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; worker-src 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

function secure(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

const json = (res, code, obj) => {
  if (res.headersSent) return res.end();
  secure(res);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};

// Este servidor expone el contenido de los terminales, así que no lleva CORS abierto. Se compara el
// Origin contra la cabecera Host de la propia petición: un navegador no deja que una página falsifique
// ninguna de las dos. Los clientes que no son navegador (el exportador OTLP, curl) no mandan Origin.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const normalizeHost = (host) => String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
export function assertLoopbackHost(host) {
  if (!LOOPBACK.has(normalizeHost(host))) {
    throw Object.assign(new Error('LCARS for Herdr solo puede escuchar en loopback (127.0.0.1, localhost o ::1)'), { status: 400 });
  }
}

function requestAuthority(value) {
  if (typeof value !== 'string' || !value || /[\s/@]/.test(value)) return null;
  try {
    const url = new URL(`http://${value}`);
    if (url.username || url.password || url.pathname !== '/') return null;
    return { hostname: normalizeHost(url.hostname), port: url.port };
  } catch { return null; }
}

export function sameOrigin(req) {
  const authority = requestAuthority(req.headers.host);
  if (!authority || !LOOPBACK.has(authority.hostname)) return false;
  const o = req.headers.origin;
  if (!o) return true;
  let url; try { url = new URL(o); } catch { return false; }
  const originHost = normalizeHost(url.hostname);
  return url.protocol === 'http:' && LOOPBACK.has(originHost) && (url.port || '') === authority.port;
}

function isJSON(req) {
  return /^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(req.headers['content-type'] || '');
}

export function readBody(req, { maxBody = MAX_BODY, maxInflated = MAX_INFLATED } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, finished = false;
    const fail = (error) => { if (finished) return; finished = true; reject(error); };
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBody) {
      req.resume(); fail(Object.assign(new Error('cuerpo demasiado grande'), { status: 413 })); return;
    }
    req.on('data', (c) => {
      if (finished) return;
      size += c.length;
      if (size > maxBody) {
        const error = Object.assign(new Error('cuerpo demasiado grande'), { status: 413 });
        req.resume(); fail(error); return;
      }
      chunks.push(c);
    });
    req.on('error', fail);
    req.on('end', async () => {
      if (finished) return;
      const buf = Buffer.concat(chunks);
      const enc = String(req.headers['content-encoding'] || 'identity').toLowerCase();
      try {
        let body;
        if (enc === 'gzip') body = await gunzip(buf, { maxOutputLength: maxInflated });
        else if (enc === 'deflate') body = await inflate(buf, { maxOutputLength: maxInflated });
        else if (enc === 'identity' || enc === '') body = buf;
        else throw Object.assign(new Error('content-encoding no admitido'), { status: 415 });
        if (body.length > maxInflated) throw Object.assign(new Error('cuerpo descomprimido demasiado grande'), { status: 413 });
        finished = true; resolve(body);
      } catch (error) { error.status ||= 400; fail(error); }
    });
  });
}

async function readJSON(req, limits = { maxBody: MAX_CONTROL_BODY, maxInflated: MAX_CONTROL_BODY }) {
  if (!isJSON(req)) throw Object.assign(new Error('se requiere content-type: application/json'), { status: 415 });
  const body = await readBody(req, limits);
  try { return JSON.parse(body.toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('JSON no válido'), { status: 400 }); }
}

async function serveStatic(res, pathname, headOnly = false) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return json(res, 400, { error: 'ruta no válida' }); }
  const rel = (decoded === '/' ? 'index.html' : decoded).replace(/^[/\\]+/, '');
  const file = path.resolve(PUBLIC_REAL, rel);
  if (file !== PUBLIC_REAL && !file.startsWith(`${PUBLIC_REAL}${path.sep}`)) return json(res, 403, { error: 'forbidden' });
  try {
    const real = await fsp.realpath(file);
    if (real !== PUBLIC_REAL && !real.startsWith(`${PUBLIC_REAL}${path.sep}`)) return json(res, 403, { error: 'forbidden' });
    const stat = await fsp.stat(real);
    if (!stat.isFile()) return json(res, 404, { error: 'not found' });
    const data = await fsp.readFile(real);
    secure(res);
    const cache = real.endsWith('-v22.woff2') ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'content-type': MIME[path.extname(real)] || 'application/octet-stream', 'cache-control': cache });
    res.end(headOnly ? undefined : data);
  } catch { json(res, 404, { error: 'not found' }); }
}

export async function startServer({
  port = 4700,
  host = '127.0.0.1',
  socketPath = herdr.DEFAULT_SOCKET,
  log = console,
  statusDir,
  claudeUsageFactory = (options) => new ClaudeUsageMonitor(options),
} = {}) {
  assertLoopbackHost(host);
  if (!Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) {
    throw Object.assign(new Error('puerto no válido'), { status: 400 });
  }
  const store = new TelemetryStore();
  const bootId = Date.now().toString(36); // cambia en cada arranque: el cliente se recarga para coger el JS nuevo
  const hostName = os.hostname().replace(/\.local$/, '').toUpperCase();
  const ticker = [];
  const clients = new Set();

  let agents = [];                 // agentes normalizados desde Herdr
  let byPane = new Map(), bySession = new Map(); // índices: los eventos no barren la lista entera
  let workspaces = [];
  let agentsVersion = 0;
  let limits = null;
  let limitsCache = null, limitsKey = '';
  let herdrError = 'sin sondeo inicial'; // null ⇒ enlace correcto
  let seq = 0;

  const pushEvent = (ev) => {
    const safe = cleanEvent(ev);
    const item = { ...safe, id: ++seq, ts: Number.isFinite(safe.ts) && safe.ts > 0 ? safe.ts : Date.now() };
    ticker.push(item);
    if (ticker.length > TICKER_MAX) ticker.splice(0, ticker.length - TICKER_MAX);
    broadcast('event', item);
  };

  /** Único punto de entrada de eventos de los vigilantes: adorna con el agente y marca la sesión sucia. */
  const relay = (ev) => {
    if (ev.kind === 'warn') return log.warn(ev.message);
    const a = bySession.get(ev.sessionId);
    if (a) store.get(ev.sessionId).dirty = true;
    pushEvent({ ...ev, paneId: a?.paneId, title: a?.title, workspace: a?.workspaceLabel });
  };
  const emitStatus = (a, from, to) =>
    pushEvent({ kind: 'status', paneId: a.paneId, sessionId: a.sessionId, title: a.title, workspace: a.workspaceLabel, from, to, agent: a.agent });

  // Perfiles: solo alias y rutas. Los tokens nunca cruzan esta frontera ni llegan al navegador.
  const profileCatalog = new AccountProfileCatalog({ log });
  // Cada credencial es un depósito independiente: la cuota no es global ni por proveedor.
  const accounts = new AccountRegistry({
    profiles: profileCatalog,
    lowPercent: Number(process.env.LCARS_LOW_QUOTA || 10),
    onChange: ({ revision, accounts: values, profiles }) => {
      broadcast('accounts', {
        ts: Date.now(), bootId, accountsRevision: revision, accounts: values,
        accountProfiles: profiles, accountProfilesError: profileCatalog.error,
      });
    },
    onAlert: ({ account, remainingPercent }) => {
      pushEvent({ kind: 'quota_low', account: account.label, provider: account.provider, remainingPercent });
      notify(`Cuota baja: ${account.label}`, `Queda ${remainingPercent}% en la ventana más apretada.`);
    },
  });
  await accounts.refresh(true);

  /** Notificación nativa de Herdr; si no está disponible, el evento del registro ya queda anotado. */
  const notify = (title, body) => {
    const bin = process.env.HERDR_BIN_PATH || 'herdr';
    execFile(bin, ['notification', 'show', title, '--body', body, '--sound', 'request'], { timeout: 5000 }, (e) => {
      if (e) log.warn(`notificación: ${e.message}`);
    });
  };

  // La cuota oficial no depende de que haya una sesión Claude activa. El adaptador toca el token
  // únicamente en memoria y entrega al registro solo porcentajes, ventanas y timestamp.
  const claudeUsage = claudeUsageFactory({
    log,
    targets: () => profileCatalog.list()
      .filter((profile) => profile.provider === 'claude')
      .map((profile) => ({ profile, accountKey: accounts.keyFor('claude', { profileId: profile.id }) }))
      .filter((target) => target.accountKey),
    onUsage: (key, windows, { at }) => accounts.report(key, windows, 'claude-api', { at }),
  });
  if (!claudeUsage || typeof claudeUsage.start !== 'function' || typeof claudeUsage.close !== 'function') {
    throw new TypeError('el adaptador de cuota Claude necesita start y close');
  }
  claudeUsage.start();

  /** Atribuye la cuota de una sesión a su cuenta. */
  const attribute = (sid, kind, { paneId = null, profileId = null } = {}) => {
    const s = store.get(sid);
    if (profileId) accounts.bindSession(sid, profileId);
    const exact = (s.accountUuid && accounts.keyByUuid(s.accountUuid))
      || accounts.keyFor(kind, { profileId, paneId, sessionId: sid });
    if (exact && (!s.accountKey || profileId || s.accountUuid)) s.accountKey = exact;
    return s.accountKey;
  };

  const transcripts = new TranscriptWatcher(store, relay, { roots: () => profileCatalog.roots('claude', 'projects') });
  const subagents = new SubagentWatcher(relay, { roots: () => profileCatalog.roots('claude', 'projects') });
  const adapters = ADAPTERS.map((Adapter) => Adapter === CodexAdapter
    ? new Adapter(store, relay, { roots: () => profileCatalog.roots('codex', 'sessions') })
    : new Adapter(store, relay));
  // Memoria de contexto: se escribe sola mientras los motores trabajan, y es lo que viaja en un relevo.
  const memory = buildContextMemory({
    socketPath, log, profiles: profileCatalog,
    threadSources: [
      createClaudeThreadSource({ roots: () => profileCatalog.roots('claude', 'projects') }),
      createCodexThreadSource({ roots: () => profileCatalog.roots('codex', 'sessions') }),
    ],
  });
  const activity = new ActivityScheduler({ ingest: memory.ingest, clock: systemClock, log });
  const resolvedSessions = new Map(); // paneId → sessionId que resolvió un adaptador
  const statusDrops = new StatusDropWatcher(store, (sid, json, { profileId, at } = {}) => {
    // El statusline es la lectura fresca de la cuota de Claude, pero no dice de qué cuenta es:
    // la atribución sale de la telemetría OTEL o, si solo hay una cuenta, de la activa.
    const rl = json?.rate_limits;
    if (!rl) return;
    const key = attribute(sid, 'claude', { profileId });
    if (!key) return;
    accounts.report(key, [
      rl.five_hour && { id: 'five_hour', minutes: 300, usedPercent: rl.five_hour.used_percentage, resetsAt: rl.five_hour.resets_at },
      rl.seven_day && { id: 'seven_day', minutes: 10080, usedPercent: rl.seven_day.used_percentage, resetsAt: rl.seven_day.resets_at },
    ].filter(Boolean), 'statusline', { at });
  }, statusDir ? { dir: statusDir } : undefined);
  await statusDrops.start();

  store.onChange(({ sessionId, kind, payload }) => {
    const a = bySession.get(sessionId);
    const base = { sessionId, paneId: a?.paneId, title: a?.title, workspace: a?.workspaceLabel, ts: payload.ts };
    if (kind === 'error') pushEvent({ ...base, kind: 'api_error', error: payload.error, statusCode: payload.statusCode, model: payload.model });
    else if (kind === 'tool' && payload.success === false) pushEvent({ ...base, kind: 'tool_failed', tool: payload.name });
    else if (kind === 'prompt') pushEvent({ ...base, kind: 'prompt' });
    else if (kind === 'request' && payload.stopReason === 'refusal') pushEvent({ ...base, kind: 'refusal', model: payload.model });
  });

  // --- Herdr: sondeo del snapshot + suscripción a cambios de estado -------------------------
  const sub = new herdr.StatusSubscription({ socketPath });
  sub.on('status', (d) => {
    const paneId = clipText(d?.pane_id, 120), status = statusOf(d?.agent_status);
    const a = byPane.get(paneId);
    if (!a || a.status === status) return;
    const from = a.status;
    a.status = status; a.statusSince = Date.now(); agentsVersion++;
    emitStatus(a, from, status);
  });
  sub.on('warn', (e) => log.warn(`herdr: ${e.message}`));
  sub.on('error', (e) => log.warn(`herdr: ${e.message}`));

  /** Traduce el snapshot de Herdr y avisa de si algo visible cambió, sin serializar una firma. */
  function normalize(snap) {
    const workspaceList = (Array.isArray(snap?.workspaces) ? snap.workspaces : []).slice(0, 1000).map((w) => ({
      id: clipText(w?.workspace_id, 120), label: clipText(w?.label, 300), number: safeNumber(w?.number),
    })).filter((w) => w.id);
    const tabList = (Array.isArray(snap?.tabs) ? snap.tabs : []).slice(0, 4000).map((tab) => ({
      id: clipText(tab?.tab_id, 120), label: clipText(tab?.label, 300),
    })).filter((tab) => tab.id);
    const rawAgents = (Array.isArray(snap?.agents) ? snap.agents : []).slice(0, 2000);
    const ws = new Map(workspaceList.map((w) => [w.id, w]));
    const tabs = new Map(tabList.map((tab) => [tab.id, tab]));
    const prevByPane = byPane;
    const list = [], nextByPane = new Map(), nextBySession = new Map();
    let changed = rawAgents.length !== agents.length;

    for (const raw of rawAgents) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const paneId = clipText(raw?.pane_id, 120), workspaceId = clipText(raw?.workspace_id, 120);
      if (!paneId || !workspaceId || nextByPane.has(paneId)) continue;
      const tabId = clipText(raw?.tab_id, 120), w = ws.get(workspaceId), t = tabs.get(tabId), prev = prevByPane.get(paneId);
      const candidate = (raw.agent_session?.kind === 'id' ? raw.agent_session.value : null) || resolvedSessions.get(paneId) || null;
      const sid = isSafeSessionId(candidate) ? candidate : null;
      const title = clipText(raw.terminal_title_stripped || raw.terminal_title || '', 1000);
      const label = w?.label || workspaceId;
      const status = statusOf(raw.agent_status);
      const statusChanged = prev && prev.status !== status;
      const accountProfileId = accounts.profileFor(paneId, sid);
      if (statusChanged || !prev || prev.title !== title || prev.sessionId !== sid
        || prev.workspaceLabel !== label || prev.accountProfileId !== accountProfileId) changed = true;

      const agent = {
        paneId, tabId, workspaceId, workspaceLabel: label, tabLabel: t?.label || '',
        agent: clipText(raw.agent, 40) || 'unknown', sessionId: sid, status, focused: raw.focused === true,
        cwd: clipPath(raw.cwd, 4096), title,
        statusSince: prev && !statusChanged ? prev.statusSince : Date.now(),
        accountProfileId,
      };
      if (statusChanged) emitStatus(agent, prev.status, status);
      list.push(agent);
      nextByPane.set(agent.paneId, agent);
      if (sid) nextBySession.set(sid, agent);
    }
    if (list.length !== agents.length) changed = true;
    byPane = nextByPane; bySession = nextBySession;
    accounts.prunePanes(new Set(nextByPane.keys()));
    workspaces = workspaceList;
    return { list, changed };
  }

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const snap = await herdr.snapshot({ socketPath });
      herdrError = null;
      const { list, changed } = normalize(snap);
      agents = list;
      if (changed) agentsVersion++;
      sub.setPanes(agents.map((a) => a.paneId));

      for (const pane of [...resolvedSessions.keys()]) if (!byPane.has(pane)) resolvedSessions.delete(pane);
      const claude = agents.filter((a) => a.agent === 'claude' && a.sessionId);
      // El transcript solo hace falta mientras no haya una fuente mejor (consulta sin crear la sesión).
      transcripts.sync(claude.filter((a) => store.accepts(a.sessionId, 'transcript')).map((a) => a.sessionId));
      subagents.sync(claude.map((a) => a.sessionId));
      // Cuota fresca publicada por un adaptador (Codex la trae en sus rollouts, gratis).
      for (const a of agents) {
        if (!a.sessionId || !store.has(a.sessionId)) continue;
        const sess = store.get(a.sessionId);
        if (!sess.rateLimits || sess.quotaForwardedAt === sess.rateLimitsAt) continue;
        sess.quotaForwardedAt = sess.rateLimitsAt;
        const key = attribute(a.sessionId, a.agent, { paneId: a.paneId, profileId: a.accountProfileId });
        if (!key) continue;
        const rl = sess.rateLimits;
        accounts.report(key, [rl.primary, rl.secondary].filter(Boolean).map((w) => ({
          id: w.window_minutes >= 10080 ? 'seven_day' : 'five_hour',
          minutes: w.window_minutes, usedPercent: w.used_percentage, resetsAt: w.resets_at,
        })), a.agent, { at: sess.rateLimitsAt });
      }
      // La capa mecánica no pide permiso a ningún motor: mira el árbol de trabajo.
      activity.sync(agents).catch((e) => log.warn(`memoria de contexto: ${e.message}`));
      activity.prune(agents);
      await mapLimit(adapters, 2, async (ad) => {
        const mine = agents.filter((a) => a.agent === ad.constructor.kind);
        try {
          const map = await ad.sync(mine.map((a) => ({ paneId: a.paneId, sessionId: a.sessionId, cwd: a.cwd })));
          for (const [pane, sid] of map) if (isSafeSessionId(sid)) resolvedSessions.set(pane, sid);
        } catch (error) { log.warn(`${ad.constructor.kind}: ${error.message}`); }
      });
    } catch (e) {
      if (!herdrError) log.warn(`herdr: ${e.message}`);
      herdrError = clipText(e?.message, 2_000) || 'error de Herdr';
      agents = []; byPane = new Map(); bySession = new Map();
      agentsVersion++;
    } finally { polling = false; }
  }
  let engineKinds = ['claude', 'codex', 'opencode'];
  await new Promise((done) => {
    execFile(process.env.HERDR_BIN_PATH || 'herdr', ['integration', 'status'], { timeout: 8000 }, (e, out) => {
      if (!e && out) {
        const installed = out.split('\n').filter((l) => /:\s*current|:\s*v?\d/.test(l)).map((l) => l.split(':')[0].trim());
        if (installed.length) engineKinds = installed.filter((k) => /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(k)).slice(0, 40);
      }
      done();
    });
  });
  memory.engines.replace(engineKinds);

  await poll();
  const pollTimer = setInterval(poll, POLL_MS);
  const gcTimer = setInterval(() => store.evict(new Set(bySession.keys()), 30 * 60_000), 60_000);
  let refreshingLimits = false;
  const refreshLimits = async () => {
    if (refreshingLimits) return;
    refreshingLimits = true;
    try { limits = await readLimits(); limitsCache = null; await accounts.refresh(); }
    catch (error) { log.warn(`limites: ${error.message}`); }
    finally { refreshingLimits = false; }
  };
  const limitsTimer = setInterval(refreshLimits, 10_000);
  limits = await readLimits();

  // --- Estado y difusión ------------------------------------------------------------------
  const sessionJSON = (sid) => ({ ...store.get(sid).toJSON(), subagents: subagents.list(sid) });

  function mergedLimits() {
    const drop = statusDrops.latestLimits;
    const key = `${drop?.at || 0}:${limits?.fetchedAt || 0}`;
    if (limitsCache !== null && key === limitsKey) return limitsCache;
    limitsKey = key;
    if (drop) limitsCache = { source: 'statusline', at: drop.at, fiveHour: drop.five_hour, sevenDay: drop.seven_day };
    else if (limits?.windows?.length) {
      const f = limits.windows.find((w) => w.minutes === 300), s = limits.windows.find((w) => w.minutes === 10080);
      limitsCache = { source: 'tmux-agent-indicator', at: limits.fetchedAt,
        fiveHour: f && { used_percentage: f.usedPercent, resets_at: f.resetsAt / 1000 },
        sevenDay: s && { used_percentage: s.usedPercent, resets_at: s.resetsAt / 1000 } };
    } else limitsCache = null;
    return limitsCache;
  }

  function fullState() {
    const sessions = Object.create(null);
    for (const a of agents) if (a.sessionId && store.has(a.sessionId)) sessions[a.sessionId] = sessionJSON(a.sessionId);
    return {
      ts: Date.now(), bootId, host: hostName, herdr: { ok: !herdrError, error: herdrError }, workspaces, agents, sessions,
      limits: mergedLimits(), accounts: accounts.toJSON(), accountsRevision: accounts.revision,
      accountProfiles: accounts.profilesJSON(), accountProfilesError: profileCatalog.error,
      engineKinds, ticker: ticker.slice(-60),
    };
  }

  function broadcast(event, data) {
    if (!clients.size) return;
    const buf = Buffer.from(sseFrame(event, data)); // una sola codificación para todos los clientes
    for (const res of clients) writeClient(res, buf);
  }

  function writeClient(res, chunk) {
    if (res.lcarsBackpressured || res.destroyed) return false;
    if (res.write(chunk)) return true;
    res.lcarsBackpressured = true;
    res.lcarsDrainTimer = setTimeout(() => res.end(), 5_000);
    res.lcarsDrainTimer.unref?.();
    res.once('drain', () => {
      clearTimeout(res.lcarsDrainTimer);
      res.lcarsBackpressured = false;
      res.lcarsNeedsResync = true;
    });
    return false;
  }

  const tickTimer = setInterval(() => {
    if (!clients.size) return;
    const sessions = Object.create(null);
    for (const a of agents) {
      if (!a.sessionId || !store.has(a.sessionId)) continue;
      const s = store.get(a.sessionId);
      const subsDirty = subagents.takeDirty(a.sessionId);
      if (s.dirty || subsDirty) { sessions[a.sessionId] = sessionJSON(a.sessionId); s.dirty = false; }
    }
    const base = { ts: Date.now(), bootId, herdr: { ok: !herdrError, error: herdrError }, limits: mergedLimits() };
    if (Object.keys(sessions).length) base.sessions = sessions;

    // Cada cliente lleva su propio cursor: uno que acaba de conectar no puede dar por enviada la lista
    // de agentes a los demás. La versión con agentes solo se serializa si alguien la necesita.
    let withAgents = null, withoutAgents = null;
    for (const res of clients) {
      if (res.lcarsNeedsResync) {
        if (writeClient(res, Buffer.from(sseFrame('state', fullState())))) {
          res.lcarsNeedsResync = false;
          res.lcarsAgentsVersion = agentsVersion;
        }
        continue;
      }
      if (res.lcarsAgentsVersion !== agentsVersion) {
        withAgents ??= Buffer.from(sseFrame('tick', { ...base, agents, workspaces }));
        writeClient(res, withAgents);
        res.lcarsAgentsVersion = agentsVersion;
      } else {
        withoutAgents ??= Buffer.from(sseFrame('tick', base));
        writeClient(res, withoutAgents);
      }
    }
  }, POLL_MS);

  // --- HTTP -------------------------------------------------------------------------------
  const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 15_000, keepAliveTimeout: 5_000, maxHeaderSize: 16 * 1024 }, async (req, res) => {
    try {
      if (!sameOrigin(req)) return json(res, 403, { error: 'origen no permitido' });
      if (typeof req.url !== 'string' || !req.url.startsWith('/')) return json(res, 400, { error: 'ruta no válida' });
      const url = new URL(req.url, 'http://127.0.0.1');

      if (req.method === 'POST' && url.pathname.startsWith('/v1/')) {
        const buf = await readBody(req);
        if (!buf.length) return json(res, 200, {});
        if (!isJSON(req)) {
          return json(res, 415, { error: 'LCARS for Herdr acepta OTLP http/json; pon OTEL_EXPORTER_OTLP_PROTOCOL=http/json' });
        }
        if (url.pathname === '/v1/logs') {
          let payload;
          try { payload = JSON.parse(buf.toString('utf8')); }
          catch { throw Object.assign(new Error('JSON OTLP no válido'), { status: 400 }); }
          const n = store.ingestLogEvents(parseLogs(payload));
          return json(res, 200, { partialSuccess: {}, accepted: n });
        }
        // Métricas y trazas: se aceptan para que el exportador no reintente, pero todo lo que el panel
        // necesita viene en los eventos de /v1/logs.
        return json(res, 200, { partialSuccess: {} });
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        if (clients.size >= MAX_SSE_CLIENTS) return json(res, 503, { error: 'demasiados clientes conectados' });
        secure(res);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        writeClient(res, sseFrame('state', fullState()));
        res.lcarsAgentsVersion = agentsVersion;
        clients.add(res);
        const ka = setInterval(() => writeClient(res, ': ka\n\n'), 15000);
        req.on('close', () => { clearInterval(ka); clearTimeout(res.lcarsDrainTimer); clients.delete(res); });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, fullState());
      if (req.method === 'GET' && url.pathname === '/api/ticker') return json(res, 200, ticker);
      if (url.pathname === '/api/focus' && req.method === 'POST') {
        const body = await readJSON(req);
        if (!body.pane_id) return json(res, 400, { error: 'pane_id requerido' });
        if (!byPane.has(body.pane_id)) return json(res, 404, { error: 'panel desconocido' });
        await herdr.focusPane(body.pane_id, { socketPath });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/read') {
        const pane = url.searchParams.get('pane_id');
        if (!pane) return json(res, 400, { error: 'pane_id requerido' });
        if (!byPane.has(pane)) return json(res, 404, { error: 'panel desconocido' });
        const asked = Number.parseInt(url.searchParams.get('lines') ?? '40', 10);
        const lines = Number.isFinite(asked) ? Math.min(MAX_READ_LINES, Math.max(1, asked)) : 40;
        const r = await herdr.readPane(pane, lines, { socketPath });
        const text = String(r?.read?.text ?? r?.text ?? '').slice(-MAX_READ_CHARS);
        return json(res, 200, { text }); // forma normalizada: la vista no adivina
      }
      if (url.pathname === '/api/handoff' && req.method === 'POST') {
        const body = await readJSON(req);
        const agent = byPane.get(body.pane_id);
        if (!agent) return json(res, 404, { error: 'panel desconocido' });
        if (!body.to_kind) return json(res, 400, { error: 'to_kind requerido' });
        const r = await memory.handOff.run({
          agent, toKind: body.to_kind, profileId: body.account_profile || null, requestId: body.request_id,
        });
        if (r.ok && r.to?.profileId) accounts.bindPane(r.to.paneId, r.to.profileId);
        pushEvent({ kind: 'engine_swap', paneId: agent.paneId, title: agent.title, workspace: agent.workspaceLabel,
          from: r.from.kind, to: r.to.kind, branch: r.context.branch, ok: r.ok });
        return json(res, r.status || 200, r);
      }
      if (req.method === 'GET' && url.pathname === '/api/context') {
        const pane = url.searchParams.get('pane_id');
        const agent = pane && byPane.get(pane);
        if (!agent) return json(res, 404, { error: 'panel desconocido' });
        const d = await memory.describe.run({ cwd: agent.cwd });
        return json(res, 200, {
          context: {
            id: d.context.id, repoRoot: d.context.repoRoot, branch: d.context.branch,
            checkoutPath: d.context.checkoutPath, head: d.context.head, dirty: Boolean(d.context.dirty),
          },
          canHandoff: d.canHandoff, coverage: d.coverage, lineage: d.lineage,
          // La memoria entera no cabe en el panel; va lo que se lee de un vistazo.
          memory: {
            goal: d.record.goal, nextStep: d.record.nextStep,
            files: d.record.files.slice(-12), failures: d.record.failures.slice(-3),
            requirements: d.record.requirements, turns: d.record.turns.length, events: d.record.events,
            totalFiles: d.record.files.length, dirtyFiles: d.record.worktree.totalFiles,
            decisions: d.record.decisions.length, failureCount: d.record.failures.length,
            updatedAt: d.record.updatedAt, historyIncomplete: d.record.historyIncomplete,
          },
        });
      }
      // La capa narrativa: cualquier motor puede anotar objetivo, decisiones y siguiente paso.
      if (url.pathname === '/api/remember' && req.method === 'POST') {
        const body = await readJSON(req);
        const agent = body.pane_id ? byPane.get(body.pane_id) : null;
        const cwdAgent = typeof body.cwd === 'string' ? agents.find((candidate) => candidate.cwd === body.cwd) : null;
        const cwd = agent?.cwd || cwdAgent?.cwd;
        if (!cwd) return json(res, 404, { error: 'el contexto no pertenece a un agente activo' });
        // Se pasa lo que venga: quién decide qué es recordable es el caso de uso, no el transporte.
        const { pane_id: _p, cwd: _c, requires, by, ...fields } = body;
        const r = await memory.remember.run({ cwd, ...fields, requires: requires || [], by: by || agent?.agent || null });
        return json(res, 200, { ok: true, applied: r.applied, contextId: r.record.contextId });
      }
      if (req.method === 'GET' && url.pathname === '/api/session') {
        const sid = url.searchParams.get('id');
        if (!sid || !store.has(sid)) return json(res, 404, { error: 'sesión desconocida' });
        return json(res, 200, { ...sessionJSON(sid), requests: store.get(sid).requests.slice(-60) });
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'método no permitido' });
      await serveStatic(res, url.pathname, req.method === 'HEAD');
    } catch (e) {
      if (!e.status) log.error(e);
      json(res, e.status || 500, { error: e.message, ...(e.details || {}) });
    }
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const timer of [pollTimer, tickTimer, limitsTimer, gcTimer]) clearInterval(timer);
    sub.close(); transcripts.close(); statusDrops.close(); subagents.close(); claudeUsage.close();
    for (const adapter of adapters) adapter.close();
    for (const client of clients) client.end();
    if (server.listening) server.close();
  };

  try {
    await new Promise((resolve, reject) => {
      const failed = (error) => { server.off('listening', resolve); reject(error); };
      server.once('error', failed);
      server.once('listening', () => { server.off('error', failed); resolve(); });
      server.listen(port, host);
    });
  } catch (error) { close(); throw error; }
  const actualPort = server.address().port;
  log.info(`LCARS for Herdr · http://${host}:${actualPort}  (OTLP en http://${host}:${actualPort}/v1/logs)`);

  return {
    server, store, url: `http://${host}:${actualPort}`, close,
  };
}
