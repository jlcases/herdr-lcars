// Lo que comparten las dos vistas: formato, el panel de detalle, el registro y la capa de datos.
// Cada vista se queda solo con lo suyo: la cubierta de celdas en una, la geometría de la nave en la otra.
import { getLocale, getLocaleTag, localizeServerText, t, tp } from './i18n.js';

export const $ = (id) => document.getElementById(id);
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtInt = (n) => n == null ? '–' : Math.round(n).toLocaleString(getLocaleTag());
export const fmtK = (n) => n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K' : String(Math.round(n));
export const fmtUsd = (n) => n == null ? '–' : (n >= 100 ? '$' + Math.round(n) : '$' + n.toFixed(2));
export const fmtMs = (ms) => ms == null ? '–' : ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';
export const fmtAge = (ts) => { if (!ts) return ''; const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? Math.round(s) + 's' : s < 3600 ? Math.round(s / 60) + 'm' : (s / 3600).toFixed(1) + 'h'; };
export const shortModel = (m) => !m ? '' : m.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace('fable-5-1', 'fable 5.1').replace('opus-5', 'opus 5').replace('sonnet-5', 'sonnet 5').replace('haiku-4-5', 'haiku 4.5');
/** Mediana sin alterar el array recibido. */
export const median = (arr) => arr.length ? [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)] : null;

export const STATUS_ORDER = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
export const STATUS_LABEL = Object.freeze({
  get blocked() { return t('status.blocked'); },
  get working() { return t('status.working'); },
  get done() { return t('status.done'); },
  get idle() { return t('status.idle'); },
  get unknown() { return t('status.unknown'); },
});
export const statusOf = (value) => Object.hasOwn(STATUS_LABEL, value) ? value : 'unknown';
export const DEMO = Number(new URLSearchParams(globalThis.location?.search || '').get('demo') || 0);

/** Nivel de un medidor por porcentaje de uso. */
export const meterLevel = (p, warn = 70, danger = 90) => (p >= danger ? 'danger' : p >= warn ? 'warn' : '');

// ---------- Sparklines ----------
export function sparkPoints(values, { w = 120, h = 28, pad = 2 } = {}) {
  const vals = values.filter((v) => v != null);
  if (vals.length < 2) return '';
  const max = Math.max(...vals, 1);
  return vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - pad - (v / max) * (h - 2 * pad)}`).join(' ');
}
export function sparkline(svg, values, { hot = false, w = 120, h = 28 } = {}) {
  if (!svg) return;
  const pts = sparkPoints(values, { w, h });
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.innerHTML = pts ? `<polyline class="${hot ? 'hot' : ''}" points="${pts}"/>` : '';
}

// ---------- Agregado de la flota ----------
const FLEET_WINDOW_MS = 120_000; // dos cubos de un minuto; el actual está incompleto

/** Recorre las sesiones una sola vez y devuelve todo lo que pintan las cabeceras. */
export function fleetStats(agents, sessions) {
  const counts = { all: agents.length, blocked: 0, working: 0, done: 0, idle: 0, unknown: 0 };
  const buckets = new Map(), tps = [], ttft = [];
  const byWorkspace = new Map();
  let tpm = 0, cost = 0, exact = 0, subsWorking = 0, sessionCount = 0;
  const now = Date.now();

  for (const a of agents) {
    counts[a.status] = (counts[a.status] || 0) + 1;
    const s = sessions[a.sessionId];
    if (!s) continue;
    sessionCount++;
    if (!s.approx) exact++;
    cost += s.costUsd ?? 0;
    if (s.recent?.tokPerSecP50) tps.push(s.recent.tokPerSecP50);
    if (s.recent?.ttftP50) ttft.push(s.recent.ttftP50);
    subsWorking += (s.subagents || []).filter((x) => x.status === 'working').length;
    let wsTpm = 0;
    for (const p of s.series || []) {
      buckets.set(p.ts, (buckets.get(p.ts) || 0) + p.output);
      if (now - p.ts < FLEET_WINDOW_MS) { tpm += p.output; wsTpm += p.output; }
    }
    const w = byWorkspace.get(a.workspaceId) || { tpm: 0, cost: 0 };
    w.tpm += wsTpm / 2; w.cost += s.costUsd ?? 0;
    byWorkspace.set(a.workspaceId, w);
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b).slice(-60);
  return {
    counts, cost, exact, subsWorking, sessionCount,
    tpm: tpm / 2, tpsP50: median(tps), ttftP50: median(ttft), tpsSamples: tps.length,
    series: keys.map((k) => buckets.get(k)), byWorkspace,
  };
}

// ---------- Cuota restante (una ficha comparable por cuenta) ----------
const windowLabel = (id, minutes) => ({ five_hour: t('quota.short'), seven_day: t('quota.weekly') })[id]
  || `${Math.round(minutes / 60)} h`;
const ENGINE_LABEL = {
  claude: 'Claude Code', codex: 'Codex (OpenAI)', kimi: 'Kimi', grok: 'Grok',
  opencode: 'OpenCode', pi: 'Pi', qwen: 'Qwen', cursor: 'Cursor',
};
const DEFAULT_WINDOWS = Object.freeze({
  claude: Object.freeze([{ id: 'five_hour', minutes: 300 }, { id: 'seven_day', minutes: 10_080 }]),
  codex: Object.freeze([{ id: 'five_hour', minutes: 300 }, { id: 'seven_day', minutes: 10_080 }]),
});
const remainingOf = (window) => {
  const value = window?.remainingPercent ?? (window?.usedPercent == null ? null : 100 - window.usedPercent);
  return Number.isFinite(Number(value)) ? Math.min(100, Math.max(0, Number(value))) : null;
};

/** Las ventanas esperadas siempre ocupan su sitio; ausencia significa «sin señal», nunca 100 %. */
export function accountGaugesHTML(accounts, { error = null, agentCounts = {} } = {}) {
  const warning = error ? `<div class="acct-error" role="alert">${esc(t('quota.profilesError', { error }))}</div>` : '';
  if (!accounts?.length) return warning + `<div class="m-sub">${esc(t('quota.noAccounts'))}</div>`;
  // La barra mide el combustible que QUEDA, igual que el número: mezclar «gastado» en una y
  // «restante» en el otro era lo que hacía ilegible el bloque.
  const level = (left) => (left <= 10 ? 'danger' : left <= 25 ? 'warn' : '');
  // El proveedor devuelve el plan como identificador («default_claude_max_5x»); aquí solo estorba.
  const tier = (x) => (x || '').replace(/^default[_-]/, '').replace(/^claude[_-]/, '').replace(/[_-]+/g, ' ').trim();
  const when = (sec) => new Date(sec * 1000)
    .toLocaleString(getLocaleTag(), { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    .replace(',', '');
  return warning + accounts.map((a) => {
    const byId = new Map((a.windows || []).map((window) => [window.id, window]));
    // El cliente conserva el contrato visual incluso durante una actualización progresiva del
    // puente: Claude y Codex siempre tienen sitio para 5 h y 7 d aunque un servidor antiguo aún
    // no publique `expectedWindows`.
    const expected = a.expectedWindows?.length
      ? a.expectedWindows
      : DEFAULT_WINDOWS[a.provider] || (a.windows || []).map((window) => ({ id: window.id, minutes: window.minutes }));
    const ordered = [...expected, ...(a.windows || []).filter((window) => !expected.some((item) => item.id === window.id))];
    const currentWindows = expected.map((spec) => byId.get(spec.id)).filter((window) => (
      window && !window.expired && remainingOf(window) != null
    ));
    const currentExpected = currentWindows.length;
    const source = currentWindows.some((window) => window.source === 'claude-api') ? 'CLAUDE'
      : currentWindows.some((window) => window.source === 'codex') ? 'CODEX'
        : currentWindows.some((window) => window.source === 'statusline') ? 'STATUSLINE' : t('quota.signalSource');
    const rows = ordered.length ? ordered.map((spec) => {
      const w = byId.get(spec.id), name = windowLabel(spec.id, spec.minutes);
      if (!w || w.expired || remainingOf(w) == null) {
        return `<div class="g-row unavailable" title="${esc(t('quota.limitNoReading', { name }))}">
          <span class="g-win">${esc(name)}</span>
          <span class="g-value"><b class="g-left">—</b><span class="g-word">${esc(t('common.noData'))}</span></span>
          <div class="m-track" role="img" aria-label="${esc(t('quota.noReading', { name }))}"><div class="m-fill"></div></div>
          <span class="g-when">${esc(t('quota.noReadingForLimit'))}</span><i class="pace"><span class="g-key">${esc(t('quota.pace'))}</span>—</i>
        </div>`;
      }
      const left = Math.round(remainingOf(w));
      // El ritmo compara el gasto con el reloj de la ventana: positivo es quemar por delante.
      const pace = w.pace == null ? `<i class="pace"><span class="g-key">${esc(t('quota.pace'))}</span>—</i>` : w.pace === 0
        ? `<i class="pace ok" title="${esc(t('quota.paceOnTime'))}"><span class="g-key">${esc(t('quota.pace'))}</span>${esc(t('quota.paceNormal'))}</i>`
        : `<i class="pace ${w.pace > 0 ? 'hot' : 'cool'}" title="${esc(t('quota.paceTip', { points: Math.abs(w.pace), direction: t(w.pace > 0 ? 'quota.ahead' : 'quota.behind') }))}"><span class="g-key">${esc(t('quota.pace'))}</span>${esc(t(w.pace > 0 ? 'quota.paceFast' : 'quota.paceHeadroom'))}${Math.abs(w.pace)}</i>`;
      const tip = t('quota.limitRemaining', { name, left })
        + (w.resetsAt ? t('quota.resetsSentence', { date: when(w.resetsAt) }) : '')
        + (w.cold ? t('quota.coldSentence') : '');
      return `<div class="g-row" title="${esc(tip)}">
        <span class="g-win">${esc(name)}</span>
        <span class="g-value"><b class="g-left ${level(left)}">${left}%</b><span class="g-word">${esc(t('quota.remaining'))}</span></span>
        <div class="m-track" role="img" aria-label="${esc(t('quota.remainingAria', { left, name }))}"><div class="m-fill ${level(left)}" style="width:${left}%"></div></div>
        <span class="g-when"><span class="g-key">${esc(t('quota.resets'))}</span> ${w.resetsAt ? when(w.resetsAt) : esc(t('common.noDate'))}${w.cold ? ` · ${esc(t('quota.cold'))}` : ''}</span>${pace}
      </div>`;
    }).join('') : `<div class="m-sub">${esc(t('quota.noWindows'))}</div>`;
    const freshness = { live: t('quota.live'), recent: t('quota.recent'), cold: t('quota.old'), none: t('quota.none') }[a.signal] || t('quota.none');
    const complete = expected.length > 0 && currentExpected === expected.length;
    const partial = currentExpected > 0 && !complete;
    const onlyWindow = currentExpected === 1 ? currentWindows[0]?.id : null;
    const partialLabel = onlyWindow === 'five_hour' ? t('quota.onlyShort')
      : onlyWindow === 'seven_day' ? t('quota.onlyWeekly')
        : t('quota.partial', { current: currentExpected, expected: expected.length });
    const signal = currentExpected === 0 ? t('quota.none')
      : partial ? partialLabel
        : freshness;
    const signalClass = currentExpected === 0 ? 'none' : `${a.signal || 'none'}${partial ? ' partial' : ''}`;
    const provider = String(a.provider || t('quota.account')).toUpperCase();
    const engine = ENGINE_LABEL[a.provider] || provider;
    const plan = tier(a.tier);
    const agents = Number(agentCounts[a.provider] || 0);
    const signalTip = t('quota.signalTip', { current: currentExpected, expected: expected.length, source });
    return `<section class="acct ${a.headroom != null && a.headroom <= 10 ? 'low' : ''}" aria-label="${esc(t('quota.remainingOf', { account: a.label }))}">
      <div class="a-head">
        <div class="a-identity">
          <strong class="a-engine"><span class="a-key">${esc(t('quota.engine'))}</span> ${esc(engine)}${agents ? ` <span class="a-agents">· ${esc(tp('unit.agent', agents))}</span>` : ''}</strong>
          <span class="a-name"><span class="a-key">${esc(t('quota.account'))}</span> ${esc(a.label)}${plan ? ` <span class="a-plan">· ${esc(t('quota.plan'))} ${esc(plan)}</span>` : ''}</span>
        </div>
        <span class="a-signal ${esc(signalClass)}" title="${esc(signalTip)}">${esc(signal)}</span>
      </div>
      <div class="g-windows">${rows}</div>
    </section>`;
  }).join('');
}

/**
 * Resume el inventario sin equiparar «motor» con «cuenta»: un motor puede estar activo y no
 * publicar cuota, y un proveedor puede tener varias cuentas. La vista decide dónde colocarlo.
 */
export function engineOverviewHTML(accounts, { error = null, agents = [], engineKinds = [] } = {}) {
  const counts = Object.create(null);
  for (const agent of agents) {
    const kind = String(agent?.agent || '').toLowerCase();
    if (kind) counts[kind] = (counts[kind] || 0) + 1;
  }
  const measured = new Set((accounts || []).map((account) => account.provider).filter(Boolean));
  const activeKinds = Object.keys(counts).sort((a, b) => a.localeCompare(b));
  const activeWithoutQuota = activeKinds.filter((kind) => !measured.has(kind));
  const knownKinds = [...new Set([...(engineKinds || []), ...activeKinds, ...measured])];
  const available = knownKinds.filter((kind) => !counts[kind] && !measured.has(kind));
  const unmetered = activeWithoutQuota.map((kind) => `<div class="engine-chip active">
    <strong>${esc(ENGINE_LABEL[kind] || kind)}</strong><span>${esc(tp('unit.agent', counts[kind]))}</span><small>${esc(t('engine.unpublishedQuota'))}</small>
  </div>`).join('');
  const availableText = available.map((kind) => ENGINE_LABEL[kind] || kind).join(' · ');
  return `<div class="engine-help">${esc(t('engine.help'))}</div>
    <div class="acct-list">${accountGaugesHTML(accounts, { error, agentCounts: counts })}</div>
    ${unmetered ? `<div class="engine-unmetered">${unmetered}</div>` : ''}
    ${availableText ? `<div class="engine-available"><span>${esc(t('engine.otherCompatible'))}</span><b>${esc(availableText)}</b></div>` : ''}`;
}

// ---------- Panel de detalle ----------
export function subagentsHTML(s) {
  const subs = s?.subagents || [], by = s?.byAgent || [];
  if (!subs.length && !by.length) return '';
  const rows = subs.slice(0, 20).map((x) => `<li class="sa st-${esc(x.status)}" title="${esc(x.lastText || '')}"><span class="sa-type">${esc(x.type || t('event.subagent'))}</span><span class="sa-desc">${esc(x.description || x.id)}</span><span class="sa-num">${fmtK(x.totals.output)} ${esc(t('common.output'))} · ${fmtUsd(x.totals.costUsd)} · ${x.tools} ${esc(t('common.tools'))} · ${fmtAge(x.lastActivity)}</span></li>`).join('');
  const agg = by.map((b) => `<span>${esc(b.name)}: ${b.requests} ${esc(t('common.requests'))} · ${b.tokPerSecP50 ? b.tokPerSecP50.toFixed(0) + ' tok/s' : '–'}${b.ttftP50 ? ' · ttft ' + fmtInt(b.ttftP50) + ' ms' : ''}</span>`).join('');
  const active = subs.filter((x) => x.status === 'working').length;
  return `<div class="d-sub-head">${esc(t('subagents.title'))} <b>${esc(t('subagents.active', { active, total: subs.length }))}</b></div>
    <ul class="sa-list">${rows || `<li class="empty">${esc(t('subagents.none'))}</li>`}</ul>
    ${agg ? `<div class="d-tools">${agg}</div>` : ''}`;
}

/**
 * Vista maestra de un workspace. Un workspace puede contener varios agentes y nunca debe
 * colapsarse visualmente en el primero: cada ficha mantiene su identidad, tarea y telemetría.
 */
export function workspaceAgentsHTML(workspace, agents, sessions = {}, selectedPane = null) {
  const ordered = [...(agents || [])].sort((a, b) => (
    String(a.tabLabel || a.paneId || '').localeCompare(String(b.tabLabel || b.paneId || ''), undefined, { numeric: true })
  ));
  const count = (status) => ordered.filter((agent) => statusOf(agent.status) === status).length;
  const label = workspace?.label || ordered[0]?.workspaceLabel || workspace?.id || '';
  const summary = t('workspace.detailSummary', {
    agents: tp('unit.agent', ordered.length),
    working: count('working'),
    blocked: count('blocked'),
  });
  const compactPath = (value) => {
    const normalized = String(value || '').replaceAll('\\', '/').replace(/\/+$/, '');
    const parts = normalized.split('/').filter(Boolean);
    if (!parts.length) return '';
    const tail = parts.slice(-3).join('/');
    return parts.length > 3 ? `…/${tail}` : tail;
  };
  const rows = ordered.map((a) => {
    const status = statusOf(a.status);
    const s = sessions[a.sessionId] || {};
    const r = s.recent || {};
    const tab = String(a.tabLabel || '').trim();
    const name = tab || a.paneId || label || t('detail.noTitle');
    const fullName = tab && tab.toLocaleLowerCase(getLocaleTag()) !== label.toLocaleLowerCase(getLocaleTag())
      ? `${label} / ${tab}` : name;
    const engine = ENGINE_LABEL[a.agent] || a.agent || t('detail.noData');
    const fullPath = String(a.cwd || '');
    const path = compactPath(fullPath) || t('workspace.noDirectory');
    const speed = r.tokPerSecLast ?? r.tokPerSecP50;
    const metrics = [
      speed != null ? `${Math.round(speed)} tok/s` : null,
      s.totals?.output != null ? `${fmtK(s.totals.output)} ${t('common.output')}` : null,
      s.costUsd != null ? fmtUsd(s.costUsd) : null,
    ].filter(Boolean).join(' · ') || t('detail.noData');
    const active = a.paneId === selectedPane;
    return `<li class="workspace-agent-node">
      <button type="button" class="workspace-agent st-${esc(status)}${active ? ' selected' : ''}" data-agent-pane="${esc(a.paneId)}" aria-pressed="${active}" aria-label="${esc(t('workspace.agentAria', { name: fullName, engine, pane: a.paneId, status: STATUS_LABEL[status], task: a.title || t('detail.noTitle'), folder: path }))}">
        <span class="workspace-agent-top"><strong>${esc(name)}</strong><span class="workspace-agent-state"><i aria-hidden="true"></i>${esc(STATUS_LABEL[status])} · ${esc(fmtAge(a.statusSince))}</span></span>
        <span class="workspace-agent-id"><b>${esc(engine)}</b><span aria-hidden="true"> · </span>${esc(a.paneId)}</span>
        <span class="workspace-agent-task">${esc(a.title || t('detail.noTitle'))}</span>
        <span class="workspace-agent-bottom"><span class="workspace-agent-path" title="${esc(fullPath)}"><b>${esc(t('workspace.folder'))}</b> · ${esc(path)}</span><span class="workspace-agent-metrics">${esc(metrics)}</span></span>
      </button>
    </li>`;
  }).join('');
  return `<section class="workspace-master" aria-label="${esc(t('workspace.agentsAria', { name: label }))}">
    <div class="workspace-master-head"><div><span>${esc(t('workspace.group'))}</span><h3>${esc(label)}</h3></div><b>${esc(tp('unit.agent', ordered.length))}</b></div>
    <p class="workspace-master-summary">${esc(summary)}</p>
    ${rows ? `<ol class="workspace-agent-list">${rows}</ol>` : `<p class="workspace-master-empty" role="status">${esc(t('workspace.noAgents'))}</p>`}
    ${selectedPane || !rows ? '' : `<p class="workspace-master-help">${esc(t('workspace.chooseAgent'))}</p>`}
  </section>`;
}

const costBasis = (basis) => ({
  statusline: t('detail.costClaude'), reported: t('detail.costReported'), estimate: t('detail.costEstimated'),
})[basis] || '';

/** Contenido completo del panel de detalle. La vista solo lo inserta y engancha los dos botones. */
export function detailHTML(a, s) {
  const r = s?.recent || {}, totals = s?.totals || {};
  const kv = (k, v, small = '') => `<div class="d-kv"><div class="k">${k}</div><div class="v">${v}${small ? `<small> ${small}</small>` : ''}</div></div>`;
  const badge = s ? `<span class="src-badge ${s.approx ? 'approx' : ''}">${esc(s.sourceLabel || t('detail.noData'))}</span>` : '';
  return `
    <h3 class="d-title">${esc(a.title || t('detail.noTitle'))}${badge}</h3>
    <div class="d-meta">${STATUS_LABEL[a.status]} · ${fmtAge(a.statusSince)} · ${esc(a.workspaceLabel)} / ${esc(a.tabLabel || '')} · ${esc(shortModel(s?.model) || a.agent)}${s?.effort ? ' · effort ' + esc(s.effort) : ''}<br>${esc(a.cwd || '')}</div>
    <div class="d-actions"><button id="btn-focus">${esc(t('detail.goTerminal'))}</button><button class="secondary" id="btn-refresh">${esc(t('detail.reloadOutput'))}</button></div>
    <div class="d-swap" id="d-swap"></div>
    <div class="d-grid">
      ${kv(esc(t('detail.speed')), r.tokPerSecLast ? r.tokPerSecLast.toFixed(0) : '–', esc(t('detail.last')))}
      ${kv(esc(t('detail.median')), r.tokPerSecP50 ? r.tokPerSecP50.toFixed(0) : '–', `tok/s · n=${r.sample || 0}`)}
      ${kv('TTFT p50', r.ttftP50 ? fmtInt(r.ttftP50) : '–', r.ttftP50 ? 'ms' : totals.requests ? esc(t('detail.notMeasurable')) : '')}
      ${kv('TTFT p95', r.ttftP95 ? fmtInt(r.ttftP95) : '–', r.ttftP95 ? 'ms' : '')}
      ${kv(esc(t('detail.latencyP50')), fmtMs(r.durationP50), esc(t('detail.perRequest')))}
      ${kv(esc(t('detail.requests')), fmtInt(totals.requests), totals.errors ? esc(t('detail.errors', { count: totals.errors })) : '')}
      ${kv(esc(t('detail.outputTokens')), fmtK(totals.output), esc(t('detail.session')))}
      ${kv(esc(t('detail.input')), fmtK((totals.input || 0) + (totals.cacheRead || 0) + (totals.cacheWrite || 0)), esc(t('detail.cache', { value: r.cacheHitRatio != null ? Math.round(r.cacheHitRatio * 100) + '%' : '–' })))}
      ${kv(esc(t('detail.cost')), fmtUsd(s?.costUsd), esc(costBasis(s?.costBasis)))}
      ${kv(esc(t('detail.context')), s?.context?.usedPercent != null ? Math.round(s.context.usedPercent) + '%' : '–', s?.context?.size ? esc(t('detail.of', { value: fmtK(s.context.size) })) : '')}
      ${kv(esc(t('detail.tools')), fmtInt(s?.tools?.count), s?.tools?.failed ? esc(t('detail.failed', { count: s.tools.failed })) : '')}
      ${kv(esc(t('detail.turns')), fmtInt(totals.turns), s?.cost?.linesAdded != null ? `+${s.cost.linesAdded} / -${s.cost.linesRemoved}` : '')}
    </div>
    <svg class="d-spark" id="d-spark" viewBox="0 0 120 28" preserveAspectRatio="none"></svg>
    <div class="d-tools">${(s?.tools?.top || []).map(([n, c]) => `<span>${esc(n)} × ${c}</span>`).join('')}</div>
    ${subagentsHTML(s)}
    <pre class="d-out" id="d-out">${esc(t('detail.readingOutput'))}</pre>`;
}

/** Firma de lo que se ve en el detalle, para no repintarlo cada segundo sin motivo. */
export const detailSignature = (a, s) =>
  JSON.stringify([getLocale(), a?.paneId, a?.agent, a?.accountProfileId, a?.status, a?.title,
    s?.totals, s?.recent, s?.context, s?.costUsd,
    (s?.subagents || []).map((x) => x.id + x.status + x.totals.output)]);

export const workspaceDetailSignature = (workspace, agents, sessions, selectedPane) => JSON.stringify([
  getLocale(), workspace?.id, workspace?.label, selectedPane,
  (agents || []).map((a) => [a.paneId, a.tabLabel, a.agent, a.accountProfileId, a.status, a.statusSince, a.title,
    sessions?.[a.sessionId]?.model, sessions?.[a.sessionId]?.totals, sessions?.[a.sessionId]?.recent,
    sessions?.[a.sessionId]?.context, sessions?.[a.sessionId]?.costUsd,
    (sessions?.[a.sessionId]?.subagents || []).map((x) => x.id + x.status + x.totals.output)]),
]);

/** Lista de bloqueados, por antigüedad. Devuelve cuántos hay. */
export function renderAlerts(ul, countEl, agents, docTitle) {
  const blocked = agents.filter((a) => a.status === 'blocked').sort((a, b) => a.statusSince - b.statusSince);
  countEl.textContent = blocked.length;
  ul.innerHTML = blocked.length ? '' : `<li class="empty">${esc(t('alert.none'))}</li>`;
  for (const a of blocked) {
    const li = document.createElement('li');
    li.dataset.pane = a.paneId;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-label', t('alert.itemAria', { workspace: a.workspaceLabel, title: a.title || t('detail.noTitle'), age: fmtAge(a.statusSince) }));
    li.innerHTML = `<span class="a-age">${fmtAge(a.statusSince)}</span><div class="a-ws">${esc(a.workspaceLabel)} · ${esc(a.paneId)}</div><div>${esc(a.title || t('detail.noTitle'))}</div>`;
    ul.appendChild(li);
  }
  document.title = blocked.length ? `(${blocked.length}) ${docTitle.alert}` : docTitle.idle;
  return blocked.length;
}

/**
 * Panel de detalle: lo pinta entero y, en los repintados de cada segundo, solo si algo cambió.
 * Conserva la salida del terminal ya cargada para no volver al mensaje de espera.
 */
export function makeDetailPanel({ emptyText, onFocus, onReload, engineKinds, accountProfiles, onSwapDone }) {
  let lastSig = '', lastProfileSig = '', lastMode = 'empty';
  const resolvedEmptyText = () => typeof emptyText === 'function' ? emptyText() : emptyText;
  const ctxCache = new Map();
  const swapOps = new Map();
  // La telemetría repinta el detalle mientras el operador decide. Su elección pertenece al pane y
  // no puede volver al primer motor de la lista por recibir un tick.
  const swapSelections = new Map();
  const isCurrentAgent = (a) => $('d-body')?.dataset.selectedPane === a.paneId;

  const newRequestId = () => globalThis.crypto?.randomUUID?.()
    || `handoff-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const profileSignature = () => JSON.stringify((accountProfiles?.() || [])
    .map((profile) => [profile.id, profile.label, profile.headroom, profile.signal]));

  async function responseJSON(response) {
    let body;
    try { body = await response.json(); } catch { body = { error: t('handoff.httpResponse', { status: response.status }) }; }
    if (!response.ok && !body.error) body.error = t('handoff.httpResponse', { status: response.status });
    return body;
  }

  function dismissOperation(a) {
    const operation = swapOps.get(a.paneId);
    clearInterval(operation?.timer);
    swapOps.delete(a.paneId);
    ctxCache.delete(a.paneId);
    paintSwap(a);
  }

  function renderOperation(a, operation) {
    const box = $('d-swap');
    if (!box || !isCurrentAgent(a)) return;
    if (!operation.done) {
      const seconds = Math.max(0, Math.floor((Date.now() - operation.startedAt) / 1000));
      box.innerHTML = `<div class="swap-box" role="status" aria-live="polite" aria-busy="true">
        <div class="swap-loading">${esc(t('handoff.opening', { kind: operation.kind }))} <span>${seconds} s</span></div>
        <div class="swap-note">${esc(t('handoff.sourceOpen'))}</div>
      </div>`;
      return;
    }
    const result = operation.result || { error: operation.error || t('handoff.noResponse') };
    if (result.ok) {
      const turns = tp('unit.turn', result.turns);
      const files = tp('unit.file', result.files);
      box.innerHTML = `<div class="swap-box" role="status" aria-live="polite">
        <div class="swap-ok"><b>${esc(result.from.kind)} → ${esc(result.to.kind)}</b> · ${esc(t('handoff.delivered', { target: result.context.branch || result.context.checkoutPath }))}</div>
        <div class="swap-note">${esc(t('handoff.included', { turns, files }))}${result.ackError ? esc(t('handoff.ackUnreadable', { error: localizeServerText(result.ackError) })) : ''}</div>
        ${result.memoryPersisted === false ? `<div class="swap-warn">${esc(t('handoff.traceFailed'))}</div>` : ''}
        <div class="swap-note">${esc(localizeServerText(result.note))}</div>
        ${result.ack ? `<pre class="d-out">${esc(result.ack)}</pre>` : ''}
        <button type="button" class="swap-retry" id="btn-swap-dismiss">${esc(t('handoff.dismiss'))}</button>
      </div>`;
      $('btn-swap-dismiss')?.addEventListener('click', () => dismissOperation(a));
      return;
    }
    const ambiguous = Boolean(result.to?.paneId);
    const unknownOutcome = !operation.result;
    const action = ambiguous
      ? `<button type="button" class="swap-retry" id="btn-swap-dismiss">${esc(t('handoff.reviewed'))}</button>`
      : `<button type="button" class="swap-retry" id="btn-swap-retry">${esc(t(unknownOutcome ? 'handoff.checkResult' : 'handoff.tryAgain'))}</button>`;
    box.innerHTML = `<div class="swap-box" role="alert">
      <div class="swap-warn">${esc(t('handoff.failed', { error: localizeServerText(result.error || operation.error) }))}</div>
      ${result.note ? `<div class="swap-note">${esc(localizeServerText(result.note))}</div>` : ''}
      ${result.to?.paneId ? `<div class="swap-note">${esc(t('handoff.newPane', { pane: result.to.paneId }))}</div>` : ''}
      ${action}
    </div>`;
    $('btn-swap-dismiss')?.addEventListener('click', () => dismissOperation(a));
    $('btn-swap-retry')?.addEventListener('click', () => beginHandoff(a, operation.kind, operation.profileId, unknownOutcome ? operation.id : undefined));
  }

  function beginHandoff(a, kind, profileId = null, id = newRequestId()) {
    const operation = { id, kind, profileId, startedAt: Date.now(), done: false, result: null, error: null, timer: null };
    swapOps.set(a.paneId, operation);
    renderOperation(a, operation);
    operation.timer = setInterval(() => renderOperation(a, operation), 1_000);
    operation.promise = fetch('/api/handoff', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pane_id: a.paneId, to_kind: kind, account_profile: profileId, request_id: id }),
    }).then(responseJSON).then((result) => { operation.result = result; })
      .catch((error) => { operation.error = error.message; })
      .finally(() => {
        operation.done = true;
        clearInterval(operation.timer);
        ctxCache.delete(a.paneId);
        renderOperation(a, operation);
        onSwapDone?.();
      });
  }

  function wireSwap(a) {
    const prepare = $('btn-swap');
    if (!prepare) return;
    const select = $('swap-kind');
    const selection = swapSelections.get(a.paneId) || { kind: null, profileId: null };
    if (selection.kind && [...(select?.options || [])].some((option) => option.value === selection.kind)) {
      select.value = selection.kind;
    }
    const paintProfiles = () => {
      const slot = $('swap-profile-slot');
      if (slot) slot.innerHTML = accountProfileSelectHTML(select?.value, accountProfiles?.() || [], a);
      const profile = $('swap-profile');
      if (selection.profileId && [...(profile?.options || [])].some((option) => option.value === selection.profileId)) {
        profile.value = selection.profileId;
      } else selection.profileId = profile?.value || null;
      selection.kind = select?.value || null;
      swapSelections.set(a.paneId, selection);
      profile?.addEventListener('change', () => {
        selection.profileId = profile.value || null;
        swapSelections.set(a.paneId, selection);
      });
    };
    select?.addEventListener('change', () => {
      selection.kind = select.value;
      selection.profileId = null;
      swapSelections.set(a.paneId, selection);
      paintProfiles();
    });
    paintProfiles();
    prepare.addEventListener('click', () => {
      const kind = select?.value;
      if (!kind) return;
      const profile = $('swap-profile');
      const profileId = profile?.value || null;
      const profileLabel = profile?.selectedOptions?.[0]?.textContent || null;
      prepare.disabled = true;
      select.disabled = true;
      if (profile) profile.disabled = true;
      const confirmation = document.createElement('div');
      confirmation.className = 'swap-confirm';
      confirmation.id = 'swap-confirm';
      const kindHTML = `<b>${esc(kind)}</b>`;
      const profileHTML = profileLabel ? t('handoff.withProfile', { profile: `<b>${esc(profileLabel)}</b>` }) : '';
      confirmation.innerHTML = `${t('handoff.confirmation', { kind: kindHTML, profile: profileHTML })}
        <div class="swap-confirm-actions"><button type="button" class="secondary" id="btn-swap-cancel">${esc(t('common.cancel'))}</button><button type="button" id="btn-swap-confirm">${esc(t('handoff.confirm'))}</button></div>`;
      prepare.closest('.swap-box').appendChild(confirmation);
      $('btn-swap-cancel').addEventListener('click', () => {
        confirmation.remove(); prepare.disabled = false; select.disabled = false; if (profile) profile.disabled = false; select.focus();
      });
      $('btn-swap-confirm').addEventListener('click', () => beginHandoff(a, kind, profileId));
      $('btn-swap-confirm').focus();
    });
  }

  /** El contexto se refresca cada diez segundos; una operación en marcha siempre manda. */
  async function paintSwap(a) {
    const box = $('d-swap');
    if (!box || !isCurrentAgent(a)) return;
    const operation = swapOps.get(a.paneId);
    if (operation) return renderOperation(a, operation);
    box.innerHTML = `<div class="swap-box"><div class="swap-loading" role="status">${esc(t('handoff.checking'))}</div></div>`;
    let entry = ctxCache.get(a.paneId);
    if (!entry || Date.now() - entry.at > 10_000) {
      try {
        const response = await fetch(`/api/context?pane_id=${encodeURIComponent(a.paneId)}`);
        const data = await responseJSON(response);
        if (data.error) throw new Error(data.error);
        entry = { data, at: Date.now() };
        ctxCache.set(a.paneId, entry);
      } catch (error) {
        if ($('d-swap') === box) {
          box.innerHTML = `<div class="swap-box" role="alert"><div class="swap-warn">${esc(t('handoff.memoryReadFailed', { error: localizeServerText(error.message) }))}</div><button type="button" class="swap-retry" id="btn-context-retry">${esc(t('common.retry'))}</button></div>`;
          $('btn-context-retry')?.addEventListener('click', () => { ctxCache.delete(a.paneId); paintSwap(a); });
        }
        return;
      }
    }
    const current = $('d-swap');
    if (!current || !isCurrentAgent(a)) return;
    current.innerHTML = swapControlHTML(a, engineKinds?.() || [], entry.data, accountProfiles?.() || []);
    wireSwap(a);
  }

  function wireAgentDetail(a, s) {
    const vals = (s?.series || []).map((p) => p.output);
    if (vals.length > 1) $('d-spark').innerHTML = `<polyline points="${sparkPoints(vals)}"/>`;
    $('btn-focus').addEventListener('click', () => onFocus(a.paneId));
    $('btn-refresh').addEventListener('click', () => onReload(a.paneId));
    paintSwap(a);
  }

  function render(a, s) {
    const body = $('d-body');
    body.dataset.selectedPane = a?.paneId || '';
    delete body.dataset.workspaceId;
    if (!a) { $('d-pane').textContent = '–'; body.innerHTML = `<p class="empty">${esc(resolvedEmptyText())}</p>`; return; }
    $('d-pane').textContent = a.paneId;
    body.innerHTML = detailHTML(a, s);
    wireAgentDetail(a, s);
  }

  function renderWorkspace(workspace, agents, sessions, selectedPane, onSelect) {
    const body = $('d-body');
    const selected = (agents || []).find((agent) => agent.paneId === selectedPane) || null;
    body.dataset.workspaceId = workspace?.id || '';
    body.dataset.selectedPane = selected?.paneId || '';
    $('d-pane').textContent = `${workspace?.label || workspace?.id || '–'} · ${(agents || []).length}`;
    body.innerHTML = workspaceAgentsHTML(workspace, agents, sessions, selected?.paneId)
      + (selected ? `<section class="workspace-selected-detail" aria-label="${esc(t('workspace.selectedAgent'))}">${detailHTML(selected, sessions[selected.sessionId])}</section>` : '');
    for (const button of body.querySelectorAll('[data-agent-pane]')) {
      button.addEventListener('click', () => onSelect(button.dataset.agentPane));
    }
    if (selected) wireAgentDetail(selected, sessions[selected.sessionId]);
  }
  return {
    render(a, s) { lastMode = a ? 'agent' : 'empty'; lastSig = detailSignature(a, s); lastProfileSig = profileSignature(); render(a, s); },
    renderIfChanged(a, s) {
      if (!a) return;
      const sig = detailSignature(a, s), profilesSig = profileSignature();
      if (lastMode === 'agent' && sig === lastSig && profilesSig === lastProfileSig) return;
      if (lastMode === 'agent' && sig === lastSig) { lastProfileSig = profilesSig; paintSwap(a); return; }
      lastMode = 'agent';
      lastSig = sig;
      lastProfileSig = profilesSig;
      const keep = $('d-out')?.textContent;
      render(a, s);
      if (keep && $('d-out')) $('d-out').textContent = keep;
    },
    renderWorkspace(workspace, agents, sessions, selectedPane, onSelect) {
      lastMode = 'workspace';
      lastSig = workspaceDetailSignature(workspace, agents, sessions, selectedPane);
      lastProfileSig = profileSignature();
      renderWorkspace(workspace, agents, sessions, selectedPane, onSelect);
    },
    renderWorkspaceIfChanged(workspace, agents, sessions, selectedPane, onSelect) {
      const sig = workspaceDetailSignature(workspace, agents, sessions, selectedPane);
      const profilesSig = profileSignature();
      if (lastMode === 'workspace' && sig === lastSig && profilesSig === lastProfileSig) return;
      const keepPane = $('d-body')?.dataset.selectedPane;
      const keepOutput = keepPane === selectedPane ? $('d-out')?.textContent : null;
      lastMode = 'workspace';
      lastSig = sig;
      lastProfileSig = profilesSig;
      renderWorkspace(workspace, agents, sessions, selectedPane, onSelect);
      if (keepOutput && $('d-out')) $('d-out').textContent = keepOutput;
    },
  };
}

/**
 * Control de cambio de motor. Un agente es un contexto de trabajo (directorio y rama); el CLI que lo
 * mueve es intercambiable. Se avisa de lo que no viaja en vez de fingir continuidad.
 */
export function accountProfileSelectHTML(kind, profiles, agent = {}) {
  let candidates = (profiles || []).filter((profile) => profile.provider === kind);
  if (!candidates.length) return '';
  if (kind === agent.agent && agent.accountProfileId) {
    const alternatives = candidates.filter((profile) => profile.id !== agent.accountProfileId);
    if (alternatives.length) candidates = alternatives;
  }
  candidates.sort((left, right) => (right.headroom ?? -1) - (left.headroom ?? -1));
  const options = candidates.map((profile) => {
    const fuel = profile.headroom == null ? t('handoff.noSignal') : t('handoff.remaining', { value: Math.round(profile.headroom) });
    return `<option value="${esc(profile.id)}">${esc(profile.label)} · ${fuel}</option>`;
  }).join('');
  return `<label class="swap-field" for="swap-profile">${esc(t('handoff.profile'))}<select id="swap-profile">${options}</select></label>`;
}

export function swapControlHTML(a, kinds, ctx, profiles = []) {
  const targets = (kinds || []).filter((kind) => {
    if (kind !== a.agent) return true;
    const own = profiles.filter((profile) => profile.provider === kind);
    return own.length > 1 || own.some((profile) => !profile.isDefault && profile.id !== a.accountProfileId);
  });
  const m = ctx?.memory || {};
  const cov = ctx?.coverage || {};
  const quality = cov.quality || 'empty';
  const qualityLabel = t(`handoff.quality.${quality}`) === `handoff.quality.${quality}` ? quality : t(`handoff.quality.${quality}`);
  const fileCount = m.totalFiles ?? m.files?.length ?? 0;
  const visibleFiles = m.files?.slice(-4) || [];
  // Lo que de verdad viajaría, no una promesa: se enseña antes de pulsar.
  const memoryHTML = [
    m.goal ? `<div class="mem-line"><span>${esc(t('handoff.goal'))}</span> ${esc(m.goal.text)}</div>` : '',
    m.nextStep ? `<div class="mem-line"><span>${esc(t('handoff.next'))}</span> ${esc(m.nextStep.text)}</div>` : '',
    visibleFiles.length ? `<div class="mem-line"><span>${esc(t('handoff.files'))}</span> ${visibleFiles.map((f) => esc(f.path.replace(/\/$/, '').split('/').pop())).join(', ')}${fileCount > visibleFiles.length ? esc(t('handoff.moreFiles', { count: fileCount - visibleFiles.length })) : ''}</div>` : '',
    m.requirements?.length ? `<div class="mem-line"><span>${esc(t('handoff.requires'))}</span> ${m.requirements.map((r) => esc(r.name)).join(', ')}</div>` : '',
    m.turns ? `<div class="mem-line"><span>${esc(t('handoff.thread'))}</span> ${esc(t('handoff.savedTurns', { count: m.turns }))}</div>` : '',
    m.decisions ? `<div class="mem-line"><span>${esc(t('handoff.decisions'))}</span> ${esc(t('handoff.recorded', { count: fmtInt(m.decisions) }))}</div>` : '',
    m.updatedAt ? `<div class="mem-line"><span>${esc(t('handoff.updated'))}</span> ${esc(t('handoff.ago', { age: fmtAge(m.updatedAt) }))}</div>` : '',
  ].filter(Boolean).join('');

  return `<div class="swap-box">
    <div class="swap-head">${esc(t('handoff.context'))}${ctx?.context?.branch ? ` · ${t('handoff.branch', { branch: `<b>${esc(ctx.context.branch)}</b>` })}` : ''}${ctx?.context?.dirty ? ` · <b>${esc(t('handoff.unfinished', { count: fmtInt(m.dirtyFiles) }))}</b>` : ''}<span class="swap-quality ${esc(quality)}">${esc(qualityLabel)}</span></div>
    ${memoryHTML ? `<div class="swap-mem">${memoryHTML}</div>` : ''}
    ${ctx && !ctx.canHandoff ? `<div class="swap-warn">${esc(t('handoff.notReady'))}</div>` : `
      <div class="swap-row">
        <label class="swap-field" for="swap-kind">${esc(t('handoff.targetEngine'))}<select id="swap-kind">${targets.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join('')}</select></label>
        <span id="swap-profile-slot">${accountProfileSelectHTML(targets[0], profiles, a)}</span>
        <button type="button" id="btn-swap" ${targets.length ? '' : 'disabled'}>${esc(t(targets.length ? 'handoff.prepare' : 'handoff.noOtherEngine'))}</button>
      </div>
      <div class="swap-note">${esc(t('handoff.explainer', { mechanical: cov.narrative ? '' : t('handoff.mechanicalOnly') }))}</div>`}
    ${m.historyIncomplete ? `<div class="swap-legacy">${esc(t('handoff.legacy'))}</div>` : ''}
    ${ctx?.lineage?.length > 1 ? `<div class="swap-hist" aria-label="${esc(t('handoff.lineage'))}">${ctx.lineage.slice(-5).map((l) => `<span>${esc(l.kind)}</span>`).join(' → ')}</div>` : ''}
  </div>`;
}

// ---------- API ----------
export const focusPane = (paneId) => DEMO ? Promise.resolve()
  : fetch('/api/focus', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pane_id: paneId }) }).catch((e) => console.warn('focus', e));

/** Carga la salida del terminal en `#d-out`, descartando respuestas que llegan tarde. */
export function makeOutputLoader() {
  let token = 0;
  return async function loadOutput(paneId) {
    const mine = ++token;
    if (!$('d-out')) return;
    if (DEMO) { $('d-out').textContent = t('output.demo'); return; }
    try {
      const r = await fetch(`/api/read?pane_id=${encodeURIComponent(paneId)}&lines=40`).then((x) => x.json());
      if (mine !== token) return;
      const pre = $('d-out'); if (!pre) return; // el panel pudo repintarse mientras llegaba
      pre.textContent = String(r?.text ?? '').trim() || (r?.error ? `${t('common.unavailable')}: ${localizeServerText(r.error)}` : t('output.noOutput'));
      pre.scrollTop = pre.scrollHeight;
    } catch (e) { if (mine === token && $('d-out')) $('d-out').textContent = t('output.readFailed', { error: localizeServerText(e.message) }); }
  };
}

// ---------- Registro ----------
export function tickerLine(ev) {
  const who = ev.title ? `${ev.workspace || ''} · ${ev.title}` : ev.paneId ? ev.paneId : ev.sessionId ? t('event.externalSession', { id: String(ev.sessionId).slice(0, 8) }) : '';
  switch (ev.kind) {
    case 'status': return [ev.to, `${who} — ${STATUS_LABEL[ev.from] || ev.from || '?'} → ${STATUS_LABEL[ev.to] || ev.to}`];
    case 'api_error': return ['api_error', `${who} — ${ev.statusCode || ''} ${localizeServerText(ev.error || t('event.apiError'))}`];
    case 'tool_failed': return ['tool_failed', t('event.toolFailed', { who, tool: ev.tool })];
    case 'refusal': return ['refusal', t('event.refusal', { who, model: ev.model })];
    case 'prompt': return ['prompt', t('event.prompt', { who })];
    case 'turn_done': return ['turn_done', t('event.turnDone', { who, duration: fmtMs(ev.durationMs) })];
    case 'subagent_start': return ['subagent', t('event.subagentStart', { who, agent: ev.agentType || t('event.subagent'), description: ev.description || ev.agentId })];
    case 'engine_swap': return ['engine_swap', t('event.engineSwap', {
      who, from: ev.from, to: ev.to, branch: ev.branch ? t('event.onBranch', { branch: ev.branch }) : '', ack: ev.ok ? '' : t('event.noAck'),
    })];
    case 'quota_low': return ['quota_low', t('event.quotaLow', { account: ev.account, provider: ev.provider, remaining: ev.remainingPercent })];
    case 'subagent_done': return ['subagent', t('event.subagentDone', { who, agent: ev.agentType || t('event.subagent'), output: fmtK(ev.output), description: ev.description || '' })];
    default: return ['info', `${who} — ${ev.message || ev.kind}`];
  }
}

export function soundCueForEvent(ev) {
  if (ev?.kind !== 'status') return null;
  if (ev.to === 'blocked') return 'blocked';
  if (ev.to === 'done') return 'done';
  return null;
}

export function makeTicker(ol, { max = 100, onSelect, onSound } = {}) {
  const events = [];
  const kindLabel = (cls) => Object.hasOwn(STATUS_LABEL, cls)
    ? STATUS_LABEL[cls].toLocaleUpperCase(getLocaleTag())
    : t(`event.kind.${cls}`) === `event.kind.${cls}` ? cls.replace('_', ' ') : t(`event.kind.${cls}`);
  const makeRow = (ev) => {
    const [cls, text] = tickerLine(ev);
    const li = document.createElement('li');
    li.className = 'k-' + cls;
    if (ev.paneId) { li.dataset.pane = ev.paneId; li.tabIndex = 0; li.setAttribute('role', 'button'); }
    li.innerHTML = `<span class="t">${new Date(ev.ts).toLocaleTimeString(getLocaleTag())}</span><span class="k">${esc(kindLabel(cls))}</span><span>${esc(text)}</span>`;
    return li;
  };
  return {
    clear: () => { events.length = 0; ol.innerHTML = ''; },
    add(ev, { announce = true } = {}) {
      events.unshift(ev);
      ol.prepend(makeRow(ev));
      while (events.length > max) events.pop();
      while (ol.children.length > max) ol.lastChild.remove();
      const cue = soundCueForEvent(ev);
      if (announce && cue) onSound?.(cue, ev);
    },
    rerender() {
      ol.innerHTML = '';
      for (const ev of events) ol.appendChild(makeRow(ev));
    },
    // Un solo listener delegado en vez de uno por fila.
    wire: () => {
      ol.addEventListener('click', (e) => { const pane = e.target.closest('li')?.dataset.pane; if (pane) onSelect?.(pane); });
      ol.addEventListener('keydown', (e) => {
        if (!['Enter', ' '].includes(e.key)) return;
        const pane = e.target.closest('li')?.dataset.pane;
        if (pane) { e.preventDefault(); onSelect?.(pane); }
      });
    },
  };
}

// ---------- Sonido ----------
export const SOUND_CUES = Object.freeze({
  done: Object.freeze({
    wave: 'sine', gain: 0.04,
    tones: Object.freeze([
      Object.freeze({ hz: 523.25, at: 0, duration: 0.14 }),
      Object.freeze({ hz: 783.99, at: 0.1, duration: 0.24 }),
    ]),
  }),
  blocked: Object.freeze({
    wave: 'square', gain: 0.075,
    tones: Object.freeze([
      Object.freeze({ hz: 880, at: 0, duration: 0.11 }),
      Object.freeze({ hz: 440, at: 0.14, duration: 0.11 }),
      Object.freeze({ hz: 880, at: 0.28, duration: 0.16 }),
      Object.freeze({ hz: 440, at: 0.47, duration: 0.24 }),
    ]),
  }),
});

export function makeBeeper(isOn, { createAudioContext = () => {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  return new AudioContext();
} } = {}) {
  let audio;
  return function beep(cue = 'done') {
    if (!isOn()) return false;
    try {
      audio ||= createAudioContext();
      if (audio.state === 'suspended') Promise.resolve(audio.resume()).catch(() => {});
      const pattern = SOUND_CUES[cue] || SOUND_CUES.done;
      const base = audio.currentTime + 0.015;
      for (const tone of pattern.tones) {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        const start = base + tone.at;
        const stop = start + tone.duration;
        oscillator.type = pattern.wave;
        oscillator.frequency.setValueAtTime(tone.hz, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(pattern.gain, start + Math.min(0.012, tone.duration / 3));
        gain.gain.setValueAtTime(pattern.gain, Math.max(start, stop - 0.025));
        gain.gain.exponentialRampToValueAtTime(0.0001, stop);
        oscillator.connect(gain);
        gain.connect(audio.destination);
        oscillator.start(start);
        oscillator.stop(stop);
      }
      return true;
    } catch { return false; }
  };
}

// ---------- Capa de datos (SSE) ----------
/**
 * Mantiene `state` al día desde /events y avisa solo cuando algo cambia de verdad:
 * los ticks vacíos (la inmensa mayoría con la flota parada) no provocan repintado.
 */
export function createClient({ onFullState, onChange, onEvent, onLink }) {
  const state = { agents: [], workspaces: [], sessions: Object.create(null), limits: null, accounts: [], accountsRevision: -1, accountProfiles: [], accountProfilesError: null, engineKinds: [], herdr: { ok: false }, host: null };
  let bootId = null, es = null, lastTick = 0, limitsSignature = '';

  function apply(d, full) {
    if (d.bootId) {
      if (bootId && d.bootId !== bootId) { location.reload(); return false; } // el servidor se actualizó
      bootId = d.bootId;
    }
    let changed = full;
    if (d.agents) {
      state.agents = d.agents.map((agent) => ({ ...agent, status: statusOf(agent.status) }));
      const alive = new Set(state.agents.map((a) => a.sessionId).filter(Boolean));
      for (const id of Object.keys(state.sessions)) if (!alive.has(id)) delete state.sessions[id];
      changed = true;
    }
    if (d.workspaces) state.workspaces = d.workspaces;
    if (d.sessions) {
      if (full) state.sessions = Object.assign(Object.create(null), d.sessions);
      else for (const [id, session] of Object.entries(d.sessions)) state.sessions[id] = session;
      changed = true;
    }
    if ('limits' in d) {
      const signature = JSON.stringify(d.limits);
      if (signature !== limitsSignature) { limitsSignature = signature; state.limits = d.limits; changed = true; }
    }
    if (d.herdr && d.herdr.ok !== state.herdr.ok) { state.herdr = d.herdr; changed = true; } else if (d.herdr) state.herdr = d.herdr;
      if (d.host) state.host = d.host;
    if (d.accounts && (full || d.accountsRevision == null || d.accountsRevision !== state.accountsRevision)) {
      state.accounts = d.accounts; changed = true;
    }
    if (d.accountsRevision != null) state.accountsRevision = d.accountsRevision;
    if (d.accountProfiles) state.accountProfiles = d.accountProfiles;
    if ('accountProfilesError' in d) state.accountProfilesError = d.accountProfilesError;
    if (d.engineKinds) state.engineKinds = d.engineKinds;
    return changed;
  }

  function connect() {
    if (es) { try { es.close(); } catch { /* ya cerrado */ } }
    es = new EventSource('/events');
    es.addEventListener('state', (e) => { lastTick = Date.now(); const d = JSON.parse(e.data); apply(d, true); onFullState?.(d); });
    es.addEventListener('tick', (e) => { lastTick = Date.now(); if (apply(JSON.parse(e.data), false)) onChange?.(); });
    es.addEventListener('accounts', (e) => { lastTick = Date.now(); if (apply(JSON.parse(e.data), false)) onChange?.(); });
    es.addEventListener('event', (e) => onEvent?.(JSON.parse(e.data)));
    es.onerror = () => {
      state.herdr = { ok: false, error: 'SSE' };
      onLink?.(t('link.reconnecting'));
      onChange?.();
      if (es.readyState === EventSource.CLOSED) setTimeout(connect, 3000);
    };
  }

  // Si el servidor se reinicia y el navegador no reconecta solo, lo forzamos.
  setInterval(() => { if (!DEMO && lastTick && Date.now() - lastTick > 8000) { onLink?.(t('link.reconnecting')); connect(); } }, 4000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onChange?.(); });

  return { state, connect, apply };
}

// ---------- Demo: flota sintética para ver la escala ----------
export function demoFleet(n) {
  const wsNames = ['ingeniería', 'ciencias', 'médica', 'táctico', 'seo', 'contenido', 'infra', 'datos', 'web', 'vídeo', 'mcp', 'lab'];
  const models = ['claude-fable-5-1', 'claude-opus-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
  const titles = ['Refactor del módulo de pagos', 'Auditoría SEO de fondos', 'Migrar tests a vitest', 'Redactar newsletter SVC', 'Limpiar ramas', 'Revisar PR #482', 'Indexar transcripciones', 'Optimizar consultas BigQuery', 'Generar guion del vídeo', 'Actualizar precios', 'Corregir CSS móvil', 'Investigar competidores', 'Entrenar clasificador', 'Deploy a staging', 'Escribir docs API'];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const agents = [], sessions = {};
  const workspaces = wsNames.map((l, i) => ({ id: 'w' + (i + 1), label: l, number: i + 1 }));

  for (let i = 0; i < n; i++) {
    const w = i % wsNames.length;
    const st = Math.random() < 0.05 ? 'blocked' : Math.random() < 0.55 ? 'working' : Math.random() < 0.5 ? 'idle' : Math.random() < 0.8 ? 'done' : 'unknown';
    const sid = 'demo-' + i;
    agents.push({ paneId: `w${w + 1}:p${Math.floor(i / wsNames.length) + 1}`, workspaceId: 'w' + (w + 1), workspaceLabel: wsNames[w], tabLabel: String(i % 9 + 1), agent: 'claude', accountProfileId: 'claude-work', sessionId: sid, status: st, title: `${pick(titles)} ${i + 1}`, cwd: '/home/demo/projects/' + wsNames[w], statusSince: Date.now() - rnd(5e3, 3e6) });
    const series = Array.from({ length: 30 }, (_, k) => ({ ts: Date.now() - (30 - k) * 60000, output: st === 'idle' ? 0 : Math.round(rnd(200, 4000)) }));
    const approx = Math.random() > 0.7;
    sessions[sid] = {
      sessionId: sid, source: approx ? 'transcript' : 'otlp', sourceLabel: approx ? 'transcript ~' : 'OTEL', approx,
      model: pick(models), effort: pick(['high', 'xhigh', 'medium']),
      totals: { input: rnd(1e3, 5e4), output: rnd(1e4, 5e5), cacheRead: rnd(1e6, 8e7), cacheWrite: rnd(1e5, 2e6), costUsd: rnd(0.5, 60), requests: Math.round(rnd(5, 400)), errors: Math.random() < .1 ? 1 : 0, turns: Math.round(rnd(1, 40)) },
      costUsd: rnd(0.5, 60), costBasis: approx ? 'estimate' : 'statusline',
      recent: { ttftP50: rnd(600, 3000), ttftP95: rnd(2000, 8000), tokPerSecP50: rnd(40, 90), tokPerSecLast: rnd(30, 110), durationP50: rnd(4000, 30000), cacheHitRatio: rnd(.85, .99), sample: 20 },
      tools: { count: Math.round(rnd(0, 300)), failed: Math.random() < .2 ? 2 : 0, top: [['Bash', 40], ['Read', 22], ['Edit', 9]] },
      context: { usedPercent: rnd(5, 95), size: 1e6 }, cost: null, series,
      subagents: st === 'working' && Math.random() < .5 ? Array.from({ length: Math.ceil(rnd(1, 4)) }, (_, k) => ({
        id: `${sid}-s${k}`, type: pick(['Explore', 'Plan', 'general-purpose', 'reviewer']),
        description: pick(['Buscar usos de la API', 'Revisar diff', 'Mapear módulos', 'Comprobar tests']),
        status: pick(['working', 'working', 'done']), lastActivity: Date.now() - rnd(0, 6e5), tools: Math.round(rnd(1, 40)),
        totals: { output: rnd(500, 30000), costUsd: rnd(.01, 2) },
      })) : [],
    };
  }
  const limits = { fiveHour: { used_percentage: 31, resets_at: Date.now() / 1000 + 7200 }, sevenDay: { used_percentage: 48, resets_at: Date.now() / 1000 + 300000 } };
  const expectedWindows = [{ id: 'five_hour', minutes: 300 }, { id: 'seven_day', minutes: 10_080 }];
  const now = Date.now(), nowSec = now / 1_000;
  const accounts = [
    {
      key: 'demo-claude-work', provider: 'claude', label: 'Claude trabajo', tier: 'max 5x', signal: 'live', headroom: 54,
      profileIds: ['claude-work'], expectedWindows,
      windows: [
        { id: 'five_hour', minutes: 300, remainingPercent: 82, resetsAt: nowSec + 9_000, at: now, source: 'statusline', pace: -8 },
        { id: 'seven_day', minutes: 10_080, remainingPercent: 54, resetsAt: nowSec + 360_000, at: now, source: 'statusline', pace: 4 },
      ],
    },
    {
      key: 'demo-codex-personal', provider: 'codex', label: 'Codex personal', tier: 'pro', signal: 'live', headroom: 23,
      profileIds: ['codex-personal'], expectedWindows,
      windows: [
        { id: 'five_hour', minutes: 300, remainingPercent: 23, resetsAt: nowSec + 5_400, at: now, source: 'codex', pace: 16 },
        { id: 'seven_day', minutes: 10_080, remainingPercent: 94, resetsAt: nowSec + 510_000, at: now, source: 'codex', pace: -11 },
      ],
    },
  ];
  const accountProfiles = [
    { id: 'claude-work', provider: 'claude', label: 'Claude trabajo', headroom: 54, signal: 'live' },
    { id: 'claude-personal', provider: 'claude', label: 'Claude personal', headroom: 88, signal: 'live' },
    { id: 'codex-personal', provider: 'codex', label: 'Codex personal', headroom: 23, signal: 'live' },
  ];

  /** Mueve la flota: devuelve los eventos de cambio de estado para el registro. */
  function mutate() {
    const events = [];
    const a = pick(agents), from = a.status;
    const to = from === 'blocked' ? 'working' : Math.random() < .08 ? 'blocked' : pick(['working', 'working', 'idle', 'done']);
    if (to !== from) {
      a.status = to; a.statusSince = Date.now();
      events.push({ kind: 'status', ts: Date.now(), paneId: a.paneId, title: a.title, workspace: a.workspaceLabel, from, to });
    }
    for (const s of Object.values(sessions)) if (Math.random() < .3) {
      s.recent.tokPerSecLast = rnd(30, 110);
      s.series.push({ ts: Date.now(), output: Math.round(rnd(0, 4000)) });
      s.series.splice(0, s.series.length - 60);
    }
    return events;
  }
  return { agents, workspaces, sessions, limits, accounts, accountProfiles, host: 'DEMO · GALAXY CLASS', mutate };
}
