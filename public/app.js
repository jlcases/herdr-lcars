// Vista compacta: una celda por agente, agrupadas por workspace. Para monitores 16:9 y portátil.
import {
  $, esc, fmtInt, fmtK, fmtUsd, fmtAge, shortModel, sparkline, fleetStats, meterLevel,
  makeDetailPanel, renderAlerts, makeOutputLoader, focusPane, makeTicker, makeBeeper, createClient, accountGaugesHTML,
  demoFleet, STATUS_LABEL, STATUS_ORDER, DEMO,
} from './shared.js';
import { bindLocaleSelector, getLocaleTag, t, tp } from './i18n.js';

const view = { filter: 'all', selected: null, sound: false };
const beep = makeBeeper(() => view.sound);
const loadOutput = makeOutputLoader();
const client = createClient({
  onFullState: (d) => { ticker.clear(); for (const ev of d.ticker || []) ticker.add(ev, { announce: false }); renderAll(); },
  onChange: renderAll,
  onEvent: (ev) => ticker.add(ev),
  onLink: (text) => { $('link-state').textContent = text; },
});
const state = client.state;
const ticker = makeTicker($('ticker'), {
  max: 80,
  onSelect: select,
  onSound: (cue, ev) => {
    beep(cue);
    if (cue === 'blocked') flashCell(ev.paneId);
  },
});

// ---------- Indicadores ----------
function renderStats() {
  const f = fleetStats(state.agents, state.sessions);
  for (const k of Object.keys(f.counts)) { const el = $('n-' + k); if (el) el.textContent = f.counts[k]; }
  $('s-active').textContent = f.counts.all;
  $('s-active-sub').textContent = t('stats.activeSummary', { working: f.counts.working, idle: f.counts.idle, done: f.counts.done });
  $('s-tpm').textContent = fmtK(f.tpm);
  $('s-tps').textContent = f.tpsP50 == null ? '–' : f.tpsP50.toFixed(0);
  $('s-tps-sub').textContent = t('stats.sampleSessions', { count: f.tpsSamples });
  $('s-ttft').textContent = f.ttftP50 == null ? '–' : fmtInt(f.ttftP50);
  $('s-ttft-sub').textContent = f.exact ? t('stats.exactSessions', { count: f.exact }) : t('stats.needsOtel');
  $('s-cost').textContent = fmtUsd(f.cost);
  $('s-cost-sub').textContent = t('stats.liveSessions', { count: f.sessionCount });
  sparkline($('spark-fleet'), f.series, { hot: true });

  $('meters').innerHTML = `<div class="m-title">${esc(t('quota.remainingForAgents'))}</div>`
    + `<div class="m-help">${esc(t('quota.help'))}</div>`
    + accountGaugesHTML(state.accounts, { error: state.accountProfilesError });

  const link = $('link-state');
  link.textContent = t(state.herdr.ok ? 'link.ok' : 'link.offline');
  link.parentElement.classList.toggle('bar-red', !state.herdr.ok);
  document.body.dataset.density = state.agents.length > 140 ? 'dense' : state.agents.length > 60 ? 'compact' : 'normal';
}

// ---------- Cubierta ----------
const CELL_HTML = `<div class="c-title"></div>
  <div class="c-row"><span class="c-model"></span><span class="c-tps"></span></div>
  <div class="c-row secondary"><span class="c-cost"></span><span class="c-out"></span></div>
  <svg class="c-spark" viewBox="0 0 120 28" preserveAspectRatio="none"></svg>
  <div class="c-subs"></div>
  <div class="c-ctx"></div><div class="c-badge"></div>`;
const cellEls = new Map(); // paneId -> elemento
const workspaceEls = new Map(); // workspaceId -> seccion

function flashCell(paneId) {
  const el = cellEls.get(paneId);
  if (!el) return;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

function updateCell(el, a) {
  const s = state.sessions[a.sessionId], r = s?.recent || {};
  el.classList.remove('st-working', 'st-idle', 'st-done', 'st-blocked', 'st-unknown');
  el.classList.add('cell', `st-${a.status}`);
  el.classList.toggle('selected', view.selected === a.paneId);
  el.setAttribute('aria-pressed', String(view.selected === a.paneId));
  el.setAttribute('aria-label', `${a.title || a.paneId}. ${STATUS_LABEL[a.status]}. ${a.workspaceLabel}.`);
  el.querySelector('.c-title').textContent = a.title || a.paneId;
  el.title = `${a.title}\n${a.cwd}\n${t('agent.since', { status: STATUS_LABEL[a.status], age: fmtAge(a.statusSince) })}`;
  el.querySelector('.c-model').textContent = shortModel(s?.model) || a.agent;
  el.querySelector('.c-tps').innerHTML = r.tokPerSecLast ? `<b>${r.tokPerSecLast.toFixed(0)}</b> tok/s` : (a.status === 'working' ? '…' : '');
  el.querySelector('.c-cost').innerHTML = s ? `<b>${fmtUsd(s.costUsd)}</b>` : '';
  el.querySelector('.c-out').innerHTML = s ? `<b>${fmtK(s.totals?.output)}</b> ${esc(t('common.output'))}` : '';
  const ctx = s?.context?.usedPercent, ctxEl = el.querySelector('.c-ctx');
  ctxEl.style.width = ctx != null ? Math.min(100, ctx) + '%' : '0';
  ctxEl.style.background = ctx >= 85 ? 'var(--red)' : ctx >= 65 ? 'var(--orange)' : 'var(--peri)';
  el.querySelector('.c-badge').textContent = a.status === 'blocked' ? t('agent.alert') : a.status === 'working' && r.ttftP50 ? `ttft ${fmtInt(r.ttftP50)}` : fmtAge(a.statusSince);
  if (s?.series?.length > 2) sparkline(el.querySelector('.c-spark'), s.series.slice(-20).map((p) => p.output));

  // Una ficha por subagente vivo o recién terminado.
  const subs = (s?.subagents || []).filter((x) => x.status !== 'done' || Date.now() - (x.lastActivity || 0) < 15 * 60_000).slice(0, 12);
  const subsEl = el.querySelector('.c-subs');
  const sig = subs.map((x) => x.id + x.status + x.totals.output).join('|');
  if (subsEl.dataset.sig !== sig) {
    subsEl.dataset.sig = sig;
    subsEl.innerHTML = subs.map((x) => `<span class="sub st-${esc(x.status)}" title="${esc(`${x.type || t('event.subagent')} · ${x.description || ''} · ${fmtK(x.totals.output)} ${t('common.output')}`)}">${esc((x.type || 'A').slice(0, 3))}</span>`).join('');
    el.classList.toggle('has-subs', subs.length > 0);
  }
}

function renderDeck() {
  const deck = $('deck');
  const visible = state.agents.filter((a) => view.filter === 'all' || a.status === view.filter);
  const groups = new Map();
  for (const a of visible) { if (!groups.has(a.workspaceId)) groups.set(a.workspaceId, []); groups.get(a.workspaceId).push(a); }
  // Los workspaces con bloqueados primero; el resto, alfabético.
  const wsOrder = [...groups.keys()].sort((x, y) => {
    const bx = groups.get(x).some((a) => a.status === 'blocked'), by = groups.get(y).some((a) => a.status === 'blocked');
    if (bx !== by) return bx ? -1 : 1;
    return (groups.get(x)[0].workspaceLabel || '').localeCompare(groups.get(y)[0].workspaceLabel || '');
  });

  const live = new Set(visible.map((a) => a.paneId));
  let wsIndex = 0;
  for (const wid of wsOrder) {
    const list = groups.get(wid).sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || a.paneId.localeCompare(b.paneId));
    let sec = workspaceEls.get(wid);
    if (!sec) {
      sec = document.createElement('section');
      sec.className = 'ws'; sec.dataset.ws = wid;
      sec.innerHTML = '<div class="ws-head"><span class="ws-name"></span><span class="ws-meta"></span><span class="ws-alert"></span></div><div class="cells"></div>';
      workspaceEls.set(wid, sec);
    }
    if (deck.children[wsIndex] !== sec) deck.insertBefore(sec, deck.children[wsIndex] || null);
    wsIndex++;
    const blocked = list.filter((a) => a.status === 'blocked').length, working = list.filter((a) => a.status === 'working').length;
    sec.querySelector('.ws-name').textContent = list[0].workspaceLabel || wid;
    sec.setAttribute('aria-label', t('workspace.aria', { name: list[0].workspaceLabel || wid }));
    sec.querySelector('.ws-meta').textContent = t('workspace.summary', { agents: tp('unit.agent', list.length), working });
    sec.querySelector('.ws-alert').textContent = blocked ? tp('status.blockedCount', blocked) : '';

    const cells = sec.querySelector('.cells');
    list.forEach((a, i) => {
      let el = cellEls.get(a.paneId);
      if (!el) { el = document.createElement('button'); el.type = 'button'; el.innerHTML = CELL_HTML; el.dataset.pane = a.paneId; cellEls.set(a.paneId, el); }
      if (cells.children[i] !== el) cells.insertBefore(el, cells.children[i] || null);
      updateCell(el, a);
    });
    while (cells.children.length > list.length) cells.lastChild.remove();
  }
  for (const [wid, sec] of workspaceEls) if (!groups.has(wid)) { sec.remove(); workspaceEls.delete(wid); }
  for (const [pid, el] of cellEls) if (!live.has(pid)) { el.remove(); cellEls.delete(pid); }
}

// ---------- Detalle ----------
const detail = makeDetailPanel({ emptyText: () => t('detail.empty.deck'), onFocus: focusPane, onReload: (p) => loadOutput(p),
  engineKinds: () => state.engineKinds || [], accountProfiles: () => state.accountProfiles || [], onSwapDone: renderAll });
const selected = () => state.agents.find((x) => x.paneId === view.selected);
const mobileDetail = () => matchMedia('(max-width: 640px)').matches;
function closeDetail() {
  view.selected = null;
  document.body.classList.remove('detail-open');
  detail.render(null);
  renderAll();
}
function select(paneId) {
  view.selected = paneId;
  document.body.classList.toggle('detail-open', mobileDetail());
  for (const [pid, el] of cellEls) { el.classList.toggle('selected', pid === paneId); el.setAttribute('aria-pressed', String(pid === paneId)); }
  const a = selected();
  detail.render(a, a && state.sessions[a.sessionId]);
  loadOutput(paneId);
  if (mobileDetail()) requestAnimationFrame(() => $('btn-detail-close').focus());
}
const alerts = () => renderAlerts($('alert-list'), $('alert-count'), state.agents, { alert: `${t('alert.red')} · ${t('brand.name')}`, idle: t('meta.compact.title') });

let renderQueued = false;
function renderAll() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderStats(); renderDeck(); alerts();
    if (view.selected) { const a = selected(); detail.renderIfChanged(a, a && state.sessions[a.sessionId]); }
  });
}

// ---------- Arranque ----------
// Un solo listener por contenedor en vez de dos por celda: no retienen el estado de cada tick.
$('deck').addEventListener('click', (e) => { const pane = e.target.closest('[data-pane]')?.dataset.pane; if (pane) select(pane); });
$('alert-list').addEventListener('click', (e) => { const pane = e.target.closest('[data-pane]')?.dataset.pane; if (pane) select(pane); });
$('alert-list').addEventListener('dblclick', (e) => { const pane = e.target.closest('[data-pane]')?.dataset.pane; if (pane) focusPane(pane); });
$('alert-list').addEventListener('keydown', (e) => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); const pane = e.target.closest('[data-pane]')?.dataset.pane; if (pane) select(pane); } });
$('btn-detail-close').addEventListener('click', closeDetail);
ticker.wire();

const renderSoundButton = () => { $('btn-sound').textContent = t(view.sound ? 'sound.on' : 'sound.off'); };
const renderClock = () => { $('clock').textContent = new Date().toLocaleTimeString(getLocaleTag()); };
bindLocaleSelector('language-select', () => {
  ticker.rerender();
  renderSoundButton();
  renderClock();
  const a = selected();
  if (!a) detail.render(null);
  renderAll();
});
renderSoundButton();
renderClock();

for (const seg of document.querySelectorAll('.side-seg[data-filter]')) {
  seg.addEventListener('click', () => {
    view.filter = seg.dataset.filter;
    document.querySelectorAll('.side-seg[data-filter]').forEach((s) => { s.classList.toggle('active', s === seg); s.setAttribute('aria-pressed', String(s === seg)); });
    renderDeck();
  });
}
document.querySelector('.side-seg[data-filter="all"]').classList.add('active');
document.querySelectorAll('.side-seg[data-filter]').forEach((seg) => seg.setAttribute('aria-pressed', String(seg.dataset.filter === 'all')));
$('btn-sound').addEventListener('click', () => {
  view.sound = !view.sound;
  renderSoundButton();
  $('btn-sound').classList.toggle('on', view.sound);
  $('btn-sound').setAttribute('aria-pressed', String(view.sound));
  if (view.sound) beep('done');
});
$('btn-wall').addEventListener('click', () => {
  const on = document.body.classList.toggle('wall');
  $('btn-wall').classList.toggle('on', on); $('btn-wall').setAttribute('aria-pressed', String(on));
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
matchMedia('(max-width: 640px)').addEventListener('change', (event) => {
  document.body.classList.toggle('detail-open', event.matches && Boolean(view.selected));
});
setInterval(renderClock, 1000);
setInterval(alerts, 5000); // refresca las edades

if (DEMO) {
  const fleet = demoFleet(DEMO);
  client.apply({ agents: fleet.agents, workspaces: fleet.workspaces, sessions: fleet.sessions,
    accounts: fleet.accounts, accountProfiles: fleet.accountProfiles, herdr: { ok: true }, host: fleet.host }, true);
  state.limits = fleet.limits;
  renderAll();
  setInterval(() => { for (const ev of fleet.mutate()) ticker.add(ev); renderAll(); }, 1200);
} else {
  client.connect();
}
