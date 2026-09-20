// Master Systems Display: la flota como sección de una nave clase Galaxy, para monitores ultra-anchos.
// La silueta toma como referencia las láminas publicadas en US D307,923; véase NOTICE.md.
import {
  $, esc, fmtInt, fmtK, fmtUsd, fmtAge, shortModel, sparkPoints, fleetStats, meterLevel,
  makeDetailPanel, renderAlerts, makeOutputLoader, focusPane, makeTicker, makeBeeper, createClient, engineOverviewHTML,
  demoFleet, STATUS_LABEL, DEMO,
} from './shared.js';
import {
  MIN_TEXT_PX, anchoredScaleTransform, calloutDetailFits, readableTextScale, svgMeetScale, zoomedViewBox,
} from './svg-readable-text.js';
import { bindLocaleSelector, getLocaleTag, t, tp, upperT } from './i18n.js';

const SVG = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
};

const SHIP_VIEWBOX = Object.freeze({ width: 3600, height: 1000 });
const SHIP_ZOOM_LEVELS = Object.freeze([1, 1.5, 2, 2.5, 3]);
const SHIP_TITLE_Y = 4;
const view = { selected: null, selectedWorkspace: null, sound: false, fleet: null, shipZoom: 1, shipCenterX: 1800, shipCenterY: 500 };
const beep = makeBeeper(() => view.sound);
const loadOutput = makeOutputLoader();
const client = createClient({
  onFullState: (d) => { ticker.clear(); for (const ev of d.ticker || []) ticker.add(ev, { announce: false }); renderAll(); },
  onChange: renderAll,
  onEvent: (ev) => ticker.add(ev),
  onLink: (text) => { $('h-link').textContent = text; },
});
const state = client.state;
const ticker = makeTicker($('ticker'), { max: 120, onSelect: select, onSound: (cue) => beep(cue) });
let layoutCache = null;

const shipScreenScale = () => {
  const rect = $('ship').getBoundingClientRect();
  const box = $('ship').viewBox.baseVal;
  return svgMeetScale(rect.width, rect.height, box.width || SHIP_VIEWBOX.width, box.height || SHIP_VIEWBOX.height);
};

function applyShipViewport({ refreshTypography = true } = {}) {
  const box = zoomedViewBox({
    zoom: view.shipZoom,
    centerX: view.shipCenterX,
    centerY: view.shipCenterY,
    ...SHIP_VIEWBOX,
  });
  view.shipCenterX = box.x + box.width / 2;
  view.shipCenterY = box.y + box.height / 2;
  $('ship').setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
  $('ship-wrap').classList.toggle('is-zoomed', view.shipZoom > 1);
  $('ship-zoom-out').disabled = view.shipZoom <= 1;
  $('ship-zoom-in').disabled = view.shipZoom >= SHIP_ZOOM_LEVELS.at(-1);
  $('ship-zoom-reset').textContent = `${Math.round(view.shipZoom * 100)}%`;
  $('ship-zoom-reset').setAttribute('aria-label', t('zoom.resetLevel', { level: Math.round(view.shipZoom * 100) }));
  if (refreshTypography) refreshShipTypography();
}

function changeShipZoom(direction) {
  const current = SHIP_ZOOM_LEVELS.indexOf(view.shipZoom);
  const next = Math.max(0, Math.min(SHIP_ZOOM_LEVELS.length - 1, current + direction));
  view.shipZoom = SHIP_ZOOM_LEVELS[next];
  applyShipViewport();
}

function resetShipZoom() {
  view.shipZoom = 1;
  view.shipCenterX = SHIP_VIEWBOX.width / 2;
  view.shipCenterY = SHIP_VIEWBOX.height / 2;
  applyShipViewport();
}

function centerShipOn(x, y) {
  if (view.shipZoom <= 1) return;
  view.shipCenterX = x;
  view.shipCenterY = y;
  applyShipViewport();
}

function readableSvgText(node, { fontSize, minimum = MIN_TEXT_PX.secondary, x, y, text, maxWidth }) {
  node.style.fontSize = `${fontSize}px`;
  node.dataset.readableFont = String(fontSize);
  node.dataset.readableMinimum = String(minimum);
  node.dataset.readableX = String(x);
  node.dataset.readableY = String(y);
  if (text != null) node.dataset.fullText = text;
  if (maxWidth != null) node.dataset.maxTextWidth = String(maxWidth);
  refreshReadableSvgText(node);
  return node;
}

function refreshReadableSvgText(node) {
  const fontSize = Number(node.dataset.readableFont);
  const minimum = Number(node.dataset.readableMinimum);
  const x = Number(node.dataset.readableX);
  const y = Number(node.dataset.readableY);
  const factor = readableTextScale(fontSize, minimum, shipScreenScale());
  const transform = anchoredScaleTransform(x, y, factor);
  if (transform) node.setAttribute('transform', transform);
  else node.removeAttribute('transform');

  if (node.dataset.fullText != null && node.dataset.maxTextWidth != null) {
    const full = node.dataset.fullText;
    const maxWidth = Number(node.dataset.maxTextWidth);
    const maxChars = Math.max(3, Math.floor(maxWidth / (fontSize * factor * 0.52)));
    node.textContent = full.length > maxChars ? `${full.slice(0, Math.max(1, maxChars - 1))}…` : full;
  }
}

function refreshReadableSvgTexts() {
  for (const node of $('ship').querySelectorAll('[data-readable-font]')) refreshReadableSvgText(node);
}

// ---------- geometría de la nave (referencia: láminas publicadas en US D307,923; ver NOTICE.md) ----------
// ship.json: perfil lateral (outline + zonas saucer/neck/hull/nacelle) y planta (outline + anillos), en píxeles del trazado.
let SHIP = null;                       // datos crudos
const VIEW = { x: 600, y: 190, w: 2440 }; // dónde cae el perfil dentro del viewBox 3600×1000
const INSET = { x: 50, y: 100, w: 500 };   // recuadro de la planta
const LEFT_LABEL_X = 560, RIGHT_LABEL_X = 3070;
const PITCHES = [[150, 88], [120, 72], [96, 58], [78, 48], [64, 40], [52, 33], [42, 27], [34, 22], [28, 18], [23, 15], [19, 12]];
let S = 1; // escala trazado → viewBox
const tx = (x) => VIEW.x + x * S, ty = (y) => VIEW.y + y * S;
const polyToPath = (poly, fx = tx, fy = ty) => poly.map((p, i) => `${i ? 'L' : 'M'}${fx(p[0]).toFixed(1)},${fy(p[1]).toFixed(1)}`).join('') + 'Z';

/** Intersecciones de la horizontal y con el polígono → intervalos [x1,x2] interiores (coordenadas viewBox). */
function scanline(polyV, y) {
  const xs = [];
  for (let i = 0; i < polyV.length; i++) {
    const [x1, y1] = polyV[i], [x2, y2] = polyV[(i + 1) % polyV.length];
    if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
  }
  xs.sort((a, b) => a - b);
  const out = []; for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  return out;
}
function bbox(polyV) { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const [x, y] of polyV) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return { x0, y0, x1, y1 }; }

/** Filas de huecos dentro de una zona (lista de polígonos) para un paso y una altura de fila dados. */
function rowsForZone(polysV, rowH, pitch, zoneName) {
  const rows = [];
  for (const polyV of polysV) {
    const b = bbox(polyV); const margin = Math.max(6, pitch * 0.25);
    const n = Math.floor((b.y1 - b.y0 - 8) / rowH);
    const startY = b.y0 + 4 + ((b.y1 - b.y0 - 8) - n * rowH) / 2 + rowH / 2;
    for (let i = 0; i < n; i++) {
      const y = startY + i * rowH;
      // el hueco debe caber entero: comprobamos la línea superior e inferior de la celda
      const top = scanline(polyV, y - rowH * 0.42), bot = scanline(polyV, y + rowH * 0.42);
      for (const [a, b2] of scanline(polyV, y)) {
        const clip = (iv) => iv.filter(([c, d]) => d > a && c < b2).map(([c, d]) => [Math.max(a, c), Math.min(b2, d)]);
        const topIntervals = clip(top), bottomIntervals = clip(bot);
        if (!topIntervals.length || !bottomIntervals.length) continue;
        const x1 = Math.max(a, ...topIntervals.map((v) => v[0]), ...bottomIntervals.map((v) => v[0])) + margin;
        const x2 = Math.min(b2, ...topIntervals.map((v) => v[1]), ...bottomIntervals.map((v) => v[1])) - margin;
        const slots = Math.floor((x2 - x1) / pitch);
        if (slots < 1) continue;
        rows.push({ y, x0: x1 + ((x2 - x1) - slots * pitch) / 2 + pitch / 2, slots, zone: zoneName });
      }
    }
  }
  return rows;
}

function zonesV() {
  const z = SHIP.side.zones; const conv = (polys) => polys.map((poly) => poly.map(([x, y]) => [tx(x), ty(y)]));
  return { saucer: conv(z.saucer), neck: conv(z.neck), hull: conv(z.hull), nacelle: conv(z.nacelle) };
}

/** Elige el tamaño de celda más grande que permite colocar a todos los agentes con separadores. */
function planLayout(groups) {
  const need = Math.ceil(groups.reduce((n, g) => n + g.agents.length + 2, 0) * 1.15);
  const Z = zonesV(); let last = null;
  for (const [pitch, rowH] of PITCHES) {
    const saucer = rowsForZone(Z.saucer, rowH, pitch, 'saucer'), neck = rowsForZone(Z.neck, rowH, pitch, 'neck'), hull = rowsForZone(Z.hull, rowH, pitch, 'hull');
    const cap = (r) => r.reduce((n, x) => n + x.slots, 0);
    last = { pitch, rowH, saucer, neck, hull, capS: cap(saucer), capN: cap(neck), capH: cap(hull) };
    if (last.capS + last.capN + last.capH >= need) return last;
  }
  return last;
}

/** Asigna cada agente a una posición (x, y). Devuelve celdas y tramos por workspace. */
function placeAgents(groups, plan) {
  const cells = [], segments = [];
  const total = groups.reduce((n, g) => n + g.agents.length, 0);
  const capAll = Math.max(1, plan.capS + plan.capN + plan.capH);
  const targetS = Math.round(total * plan.capS / capAll);
  let acc = 0; const inSaucer = new Set();
  for (const g of groups) { if (acc < targetS || plan.capH + plan.capN === 0) { inSaucer.add(g.id); acc += g.agents.length; } }
  const rows = [...plan.saucer, ...plan.neck, ...plan.hull];
  const restStart = plan.saucer.length;
  let r = 0, c = 0;
  for (const g of groups) {
    if (!inSaucer.has(g.id) && r < restStart) { r = restStart; c = 0; }
    if (!rows[r]) break;
    if (rows[r].slots - c < 2 && r < rows.length - 1) { r++; c = 0; }
    if (c > 0) c++;
    let first = null; let segStart = c, segRow = r;
    let overflow = 0;
    for (const a of g.agents) {
      while (rows[r] && c >= rows[r].slots) {
        if (c - 1 >= segStart) segments.push({ ws: g, row: segRow, from: segStart, to: c - 1 });
        r++; c = 0; segStart = 0; segRow = r;
      }
      if (!rows[r]) { overflow++; continue; }
      const row = rows[r];
      const cell = { agent: a, x: row.x0 + c * plan.pitch, y: row.y, zone: row.zone, ws: g };
      cells.push(cell); if (!first) first = cell; c++;
    }
    g.overflow = overflow;
    if (rows[r] && c - 1 >= segStart) segments.push({ ws: g, row: segRow, from: segStart, to: c - 1 });
    g.first = first;
  }
  plan.rows = rows;
  return { cells, segments };
}

// ---------- dibujo ----------
function drawHulls() {
  const side = SHIP.side; S = VIEW.w / side.w;
  const h = $('hulls'); h.innerHTML = '';
  const Z = zonesV();
  // Casco sólido + tinta del plano original como textura
  el('path', { class: 'hull', d: polyToPath(side.outline) }, h);
  el('image', { href: 'ship-side-ink.png', x: VIEW.x, y: VIEW.y, width: side.w * S, height: side.h * S, class: 'ink', preserveAspectRatio: 'none' }, h);
  for (const name of ['saucer', 'neck', 'hull', 'nacelle']) for (const poly of Z[name]) el('path', { class: 'zone-line', d: polyToPath(poly, (x) => x, (y) => y) }, h);
  // Góndola: brillo + sparkline dentro del cuerpo principal
  const nac = bbox(Z.nacelle[0]);
  NAC = { x: nac.x0 + 30, y: nac.y0 + 6, w: nac.x1 - nac.x0 - 60, h: nac.y1 - nac.y0 - 12 };
  el('rect', { id: 'nacelle-glow', class: 'nacelle-glow', x: NAC.x, y: NAC.y, width: NAC.w, height: NAC.h, rx: NAC.h / 2 }, h);
  el('polyline', { id: 'nacelle-spark', class: 'nacelle-spark', points: '' }, h);
  el('ellipse', { cx: nac.x0 + 18, cy: (nac.y0 + nac.y1) / 2, rx: 14, ry: (nac.y1 - nac.y0) / 2 - 8, fill: '#cc3333', opacity: .9 }, h);
  // Deflector en el morro del casco de ingeniería; puente en lo alto del platillo
  const hb = bbox(Z.hull[0]);
  const front = Z.hull[0].reduce((m, p) => (p[0] < m[0] ? p : m));
  el('ellipse', { id: 'deflector', class: 'deflector', cx: front[0] + 26, cy: (hb.y0 + hb.y1) / 2 + 10, rx: 22, ry: Math.min(60, (hb.y1 - hb.y0) / 3) }, h);
  const topPt = Z.saucer[0].reduce((m, p) => (p[1] < m[1] ? p : m));
  el('path', { id: 'bridge', class: 'bridge-dome', d: `M${topPt[0] - 70},${topPt[1] + 10} Q${topPt[0]},${topPt[1] - 26} ${topPt[0] + 70},${topPt[1] + 10} Z` }, h);

  // Recuadro superior izquierdo: la planta con sus anillos
  const top = SHIP.top; const s2 = INSET.w / top.w; const fx = (x) => INSET.x + x * s2, fy = (y) => INSET.y + y * s2;
  el('rect', { x: INSET.x - 14, y: INSET.y - 14, width: INSET.w + 28, height: top.h * s2 + 28, rx: 10, class: 'inset-frame' }, h);
  el('path', { class: 'inset-hull', d: polyToPath(top.outline, fx, fy) }, h);
  el('image', { href: 'ship-top-ink.png', x: INSET.x, y: INSET.y, width: top.w * s2, height: top.h * s2, class: 'ink ink-top', preserveAspectRatio: 'none' }, h);
  for (const ring of top.rings) for (const poly of ring) el('path', { class: 'inset-ring', d: polyToPath(poly, fx, fy) }, h);
  const it = el('text', { class: 'tag', x: INSET.x - 8, y: INSET.y - 24 }, h); it.textContent = t('ship.plan');
  readableSvgText(it, { fontSize: 18, x: INSET.x - 8, y: INSET.y - 24 });
  INSET.bottom = INSET.y + top.h * s2 + 20;

  // Títulos y leyenda
  const o = $('overlays'); o.innerHTML = '';
  const t1 = el('text', { class: 'ship-title', x: 40, y: SHIP_TITLE_Y }, o); t1.textContent = t('brand.name');
  readableSvgText(t1, { fontSize: 30, minimum: MIN_TEXT_PX.primary, x: 40, y: SHIP_TITLE_Y });
  const t3 = el('text', { class: 'ship-title', id: 'title-r', x: 3560, y: SHIP_TITLE_Y, 'text-anchor': 'end' }, o); t3.textContent = '';
  readableSvgText(t3, { fontSize: 30, minimum: MIN_TEXT_PX.primary, x: 3560, y: SHIP_TITLE_Y });
  const t4 = el('text', { class: 'ship-title-sub', id: 'title-r-sub', x: 3560, y: 74, 'text-anchor': 'end' }, o); t4.textContent = '';
  readableSvgText(t4, { fontSize: 18, x: 3560, y: 74 });
  const leg = el('g', { transform: 'translate(620, 968)' }, o);
  ['working', 'blocked', 'done', 'idle', 'unknown'].map((key) => [key, upperT(`status.${key}`)]).forEach(([k, lbl], i) => {
    el('rect', { class: `cell st-${k}`, x: i * 250, y: -14, width: 24, height: 16, style: 'animation:none;cursor:default' }, leg);
    const x = i * 250 + 34;
    const legendLabel = el('text', { class: 'tag-dim', x, y: 0 }, leg); legendLabel.textContent = lbl;
    readableSvgText(legendLabel, { fontSize: 14, x, y: 0 });
  });
  const credit = el('text', { class: 'tag-dim ship-credit', x: 3560, y: 968, 'text-anchor': 'end' }, o); credit.textContent = t('ship.silhouette');
  readableSvgText(credit, { fontSize: 14, x: 3560, y: 968 });
}
let NAC = { x: 0, y: 0, w: 1, h: 1 };

const cellNodes = new Map(); // paneId -> {rect, dots}
let lastLayoutSig = '';
function drawShip() {
  if (!SHIP) return;
  const agentsByWs = new Map();
  for (const a of state.agents) { if (!agentsByWs.has(a.workspaceId)) agentsByWs.set(a.workspaceId, []); agentsByWs.get(a.workspaceId).push(a); }
  const wsOrder = [...agentsByWs.keys()].sort((x, y) => (state.workspaces.find((w) => w.id === x)?.number || 0) - (state.workspaces.find((w) => w.id === y)?.number || 0) || x.localeCompare(y));
  const groups = wsOrder.map((id) => ({ id, label: agentsByWs.get(id)[0].workspaceLabel || id, agents: agentsByWs.get(id).sort((a, b) => a.paneId.localeCompare(b.paneId, undefined, { numeric: true })) }));
  const sig = groups.map((g) => g.id + ':' + g.agents.map((a) => a.paneId).join(',')).join('|');
  const relayout = sig !== lastLayoutSig; lastLayoutSig = sig;

  // Barrer los polígonos del casco cuesta decenas de miles de operaciones, y el trazado solo cambia
  // cuando aparece o desaparece un agente: con la flota quieta se reutiliza el anterior.
  if (relayout || !layoutCache) {
    const plan = planLayout(groups);
    layoutCache = { plan, ...placeAgents(groups, plan), groups };
  } else {
    for (const [i, g] of layoutCache.groups.entries()) { g.agents = groups[i]?.agents ?? g.agents; g.label = groups[i]?.label ?? g.label; }
  }
  const { plan, cells, segments } = layoutCache;
  const cw = plan.pitch - Math.max(3, plan.pitch * 0.14), ch = plan.rowH - Math.max(3, plan.rowH * 0.2);
  layoutCache.cw = cw; layoutCache.ch = ch;

  const gCells = $('cells'), gDecks = $('decks'), gCall = $('callouts');
  if (relayout) { gCells.innerHTML = ''; gDecks.innerHTML = ''; gCall.innerHTML = ''; cellNodes.clear(); }

  if (relayout || !gDecks.childElementCount) {
    // Líneas de cubierta (una por fila de huecos), como en el plano.
    gDecks.innerHTML = '';
    for (const row of plan.rows) el('line', { class: 'deck', x1: row.x0 - plan.pitch / 2, x2: row.x0 + (row.slots - 0.5) * plan.pitch, y1: row.y + ch / 2 + 3, y2: row.y + ch / 2 + 3 }, gDecks);
    for (const seg of segments) {
      const row = plan.rows[seg.row]; if (!row) continue;
      const x1 = row.x0 + seg.from * plan.pitch - cw / 2 - 4, x2 = row.x0 + seg.to * plan.pitch + cw / 2 + 4;
      el('rect', { class: 'ws-band', 'data-ws': seg.ws.id, x: x1, y: row.y - ch / 2 - 4, width: Math.max(0, x2 - x1), height: ch + 8, rx: 4 }, gDecks);
    }
  }

  for (const c of cells) {
    let node = cellNodes.get(c.agent.paneId);
    if (!node) {
      const g = el('g', {}, gCells);
      const rect = el('rect', { class: 'cell', width: cw, height: ch }, g);
      const title = el('title', {}, rect);
      const dots = el('g', {}, g);
      const label = el('text', { class: 'cell-label', 'pointer-events': 'none' }, g);
      const label2 = el('text', { class: 'cell-label2', 'pointer-events': 'none' }, g);
      g.setAttribute('data-pane', c.agent.paneId);
      g.setAttribute('role', 'button');
      g.setAttribute('tabindex', '0');
      node = { g, rect, title, dots, label, label2 }; cellNodes.set(c.agent.paneId, node);
    }
    node.g.setAttribute('transform', `translate(${c.x - cw / 2}, ${c.y - ch / 2})`);
    node.rect.setAttribute('width', cw); node.rect.setAttribute('height', ch);
    const a = c.agent, s = state.sessions[a.sessionId];
    node.rect.setAttribute('class', `cell st-${a.status}` + (view.selected === a.paneId ? ' selected' : ''));
    const r = s?.recent || {};
    node.title.textContent = `${a.workspaceLabel} · ${a.paneId}\n${a.title}\n${STATUS_LABEL[a.status]} · ${fmtAge(a.statusSince)}${r.tokPerSecLast ? `\n${r.tokPerSecLast.toFixed(0)} tok/s` : ''}${s ? `\n${fmtUsd(s.costUsd)} · ${fmtK(s.totals?.output)} ${t('common.output')}` : ''}`;
    node.g.setAttribute('aria-label', `${a.title || a.paneId}. ${STATUS_LABEL[a.status]}. ${a.workspaceLabel}.`);
    if (plan.pitch >= 64) {
      const fs = Math.max(9, Math.min(30, ch * 0.3));
      node.label.setAttribute('x', 5); node.label.setAttribute('y', fs + 3); node.label.style.fontSize = fs + 'px';
      readableSvgText(node.label, { fontSize: fs, x: 5, y: fs + 3, text: a.title || a.paneId, maxWidth: cw - 10 });
      node.label2.setAttribute('x', 5); node.label2.setAttribute('y', ch - 5); node.label2.style.fontSize = (fs * 0.8) + 'px';
      readableSvgText(node.label2, { fontSize: fs * 0.8, x: 5, y: ch - 5,
        text: [shortModel(s?.model), r.tokPerSecLast ? r.tokPerSecLast.toFixed(0) + ' tok/s' : STATUS_LABEL[a.status], s ? fmtUsd(s.costUsd) : ''].filter(Boolean).join(' · '), maxWidth: cw - 10 });
    } else {
      for (const label of [node.label, node.label2]) {
        label.textContent = '';
        for (const key of ['readableFont', 'readableMinimum', 'readableX', 'readableY', 'fullText', 'maxTextWidth']) delete label.dataset[key];
        label.removeAttribute('transform');
      }
    }
    const subs = (s?.subagents || []).filter((x) => x.status === 'working').slice(0, 6);
    const dsig = subs.map((x) => x.id).join(',');
    if (node.dots.dataset.sig !== dsig) {
      node.dots.dataset.sig = dsig; node.dots.innerHTML = '';
      const d = Math.max(3, Math.min(6, cw / 6));
      subs.forEach((x, i) => el('rect', { class: 'subdot st-working', x: 2 + i * (d + 2), y: ch - d - 2, width: d, height: d }, node.dots));
    }
  }
  const livePanes = new Set(cells.map((c) => c.agent.paneId));
  for (const [pid, node] of cellNodes) if (!livePanes.has(pid)) { node.g.remove(); cellNodes.delete(pid); }

  // Lo único que cambia por segundo en las bandas es si el workspace tiene algún bloqueado.
  for (const band of gDecks.querySelectorAll('.ws-band')) {
    const g = layoutCache.groups.find((x) => x.id === band.dataset.ws);
    band.setAttribute('stroke', g?.agents.some((a) => a.status === 'blocked') ? 'var(--red)' : 'var(--lilac-x)');
    band.classList.toggle('selected', view.selectedWorkspace === g?.id);
  }
  drawCallouts(layoutCache.groups, plan, cw, ch, relayout);

  $('deflector').setAttribute('class', 'deflector' + (state.herdr.ok ? '' : ' down'));
  const blocked = state.agents.filter((a) => a.status === 'blocked').length;
  document.body.classList.toggle('red-alert', blocked > 0);
  $('title-r').textContent = t('ship.summary', {
    agents: state.agents.length, working: state.agents.filter((a) => a.status === 'working').length, blocked,
  });
  $('title-r-sub').textContent = t('ship.workspaceSummary', {
    workspaces: groups.length,
    subagents: Object.values(state.sessions).reduce((n, s) => n + (s.subagents || []).filter((x) => x.status === 'working').length, 0),
  });
}

function drawCallouts(groups, plan, cw, ch, relayout) {
  const gCall = $('callouts');
  if (!relayout && gCall.childElementCount) return refreshCallouts(gCall);
  gCall.innerHTML = '';
  const left = groups.filter((g) => g.first && g.first.zone === 'saucer');
  const right = groups.filter((g) => g.first && g.first.zone !== 'saucer');
  const layoutSide = (list, side) => {
    if (!list.length) return;
    const top = side === 'left' ? (INSET.bottom || 420) + 30 : 120, bottom = 930;
    const available = bottom - top;
    const step = Math.min(160, available / Math.max(1, list.length));
    const start = top + (available - step * list.length) / 2 + step / 2;
    const fs = step >= 70 ? 27 : step >= 50 ? 22 : 17, fs2 = fs * 0.74;
    const scale = shipScreenScale();
    const showDetail = calloutDetailFits(step, scale);
    list.forEach((g, i) => {
      const ly = start + i * step;
      const c = g.first;
      const cx = side === 'left' ? c.x - cw / 2 : c.x + cw / 2;
      const labelX = side === 'left' ? LEFT_LABEL_X : RIGHT_LABEL_X;
      const busX = side === 'left' ? LEFT_LABEL_X + 30 + i * 10 : RIGHT_LABEL_X - 30 - i * 10;
      const summary = calloutSummary(g);
      const blocked = summary.blocked;
      el('polyline', { class: 'callout-line' + (blocked ? ' hot' : '') + (view.selectedWorkspace === g.id ? ' selected' : ''), 'data-ws': g.id, points: `${cx},${c.y} ${busX},${c.y} ${busX},${ly} ${labelX},${ly}` }, gCall);
      el('circle', { cx, cy: c.y, r: 4, fill: blocked ? 'var(--red)' : 'var(--lilac)' }, gCall);
      const anchor = side === 'left' ? 'end' : 'start';
      const textX = labelX + (side === 'left' ? -8 / scale : 8 / scale);
      const labelNode = el('text', {
        class: `callout-label ${summary.className}${view.selectedWorkspace === g.id ? ' selected' : ''}`,
        'data-workspace-select': g.id, 'data-ws': g.id,
        'data-compact': String(!showDetail), x: textX, y: ly - 4, 'text-anchor': anchor,
      }, gCall);
      labelNode.textContent = calloutHeadline(g, !showDetail);
      labelNode.setAttribute('role', 'button'); labelNode.setAttribute('tabindex', '0');
      labelNode.setAttribute('aria-label', t('ship.selectWorkspace', { name: g.label, agents: tp('unit.agent', g.agents.length), status: summary.label.toLocaleLowerCase(getLocaleTag()) }));
      readableSvgText(labelNode, { fontSize: fs, minimum: MIN_TEXT_PX.primary, x: textX, y: ly - 4 });
      if (showDetail) {
        const subY = ly + Math.max(fs2 + 2, 20 / scale);
        const sub = el('text', { class: 'callout-sub', 'data-ws': g.id, x: textX, y: subY, 'text-anchor': anchor }, gCall);
        sub.textContent = calloutText(g);
        readableSvgText(sub, { fontSize: fs2, x: textX, y: subY });
      }
    });
  };
  layoutSide(left, 'left'); layoutSide(right, 'right');
}

function calloutSummary(g) {
  const count = (status) => g.agents.filter((agent) => agent.status === status).length;
  const blocked = count('blocked');
  const working = count('working');
  const idle = count('idle');
  const done = count('done');
  if (blocked) return { blocked, working, className: 'st-blocked', label: tp('status.blockedCount', blocked).toLocaleUpperCase(getLocaleTag()) };
  if (working) return { blocked, working, className: 'st-working', label: tp('status.active', working).toLocaleUpperCase(getLocaleTag()) };
  if (idle) return { blocked, working, className: 'st-idle', label: upperT('status.idle') };
  if (done === g.agents.length) return { blocked, working, className: 'st-done', label: upperT('status.done') };
  return { blocked, working, className: 'st-unknown', label: upperT('status.unknown') };
}

function calloutHeadline(g, compact) {
  const base = `${g.label.toUpperCase()} · ${g.agents.length}`;
  return compact ? `${base} · ${calloutSummary(g).label}` : base;
}


/** Texto de una llamada de workspace: lo único que cambia segundo a segundo. */
function calloutText(g) {
  const { working, blocked } = calloutSummary(g);
  const w = view.fleet?.byWorkspace.get(g.id) || { tpm: 0, cost: 0 };
  return [tp('status.active', working).toLocaleUpperCase(getLocaleTag()), blocked ? tp('status.blockedCount', blocked).toLocaleUpperCase(getLocaleTag()) : null, g.overflow ? `+${g.overflow} ${t('ship.noRoom')}` : null,
    `${fmtK(w.tpm)} TOK/MIN`, fmtUsd(w.cost)].filter(Boolean).join(' · ');
}
function refreshCallouts(gCall) {
  for (const node of gCall.querySelectorAll('.callout-label')) {
    const g = layoutCache?.groups.find((x) => x.id === node.dataset.ws);
    if (!g) continue;
    const summary = calloutSummary(g);
    node.textContent = calloutHeadline(g, node.dataset.compact === 'true');
    node.classList.remove('st-working', 'st-idle', 'st-done', 'st-blocked', 'st-unknown');
    node.classList.add(summary.className);
    node.classList.toggle('selected', view.selectedWorkspace === g.id);
    node.setAttribute('aria-label', t('ship.selectWorkspace', { name: g.label, agents: tp('unit.agent', g.agents.length), status: summary.label.toLocaleLowerCase(getLocaleTag()) }));
  }
  for (const node of gCall.querySelectorAll('.callout-sub')) {
    const g = layoutCache?.groups.find((x) => x.id === node.dataset.ws);
    if (g) node.textContent = calloutText(g);
  }
  for (const line of gCall.querySelectorAll('.callout-line')) {
    const g = layoutCache?.groups.find((x) => x.id === line.dataset.ws);
    line.classList.toggle('hot', !!g?.agents.some((a) => a.status === 'blocked'));
    line.classList.toggle('selected', view.selectedWorkspace === g?.id);
  }
}

// ---------- Lecturas numéricas ----------
function renderReadouts() {
  const f = view.fleet;
  const box = (cls, k, v, small = '', extra = '') => `<div class="ro ${cls}"><div class="k">${k}</div><div class="v">${v}${small ? `<small> ${small}</small>` : ''}</div>${extra}</div>`;
  $('readouts').innerHTML = [
    box('o', t('stats.connected'), f.counts.all, t('stats.workingCount', { count: f.counts.working })),
    box('r', t('stats.blocked'), f.counts.blocked, f.counts.blocked ? t('stats.redAlert') : ''),
    box('a', t('stats.activeSubagents'), f.subsWorking),
    box('a', t('stats.recentOutput'), fmtK(f.tpm), t('stats.recentRate')),
    box('', t('stats.speedP50'), f.tpsP50 == null ? '–' : f.tpsP50.toFixed(0), 'tok/s'),
    box('', t('stats.ttftP50'), f.ttftP50 == null ? '–' : fmtInt(f.ttftP50), 'ms'),
    box('o', t('stats.liveCost'), fmtUsd(f.cost)),
  ].join('');

  // La góndola brilla con la salida de la flota y lleva dentro la gráfica de la última hora.
  const peak = Math.max(1, ...f.series);
  $('nacelle-glow').style.opacity = (0.15 + 0.85 * Math.min(1, f.tpm / peak)).toFixed(2);
  $('nacelle-spark').setAttribute('points', sparkPoints(f.series.slice(-40), { w: NAC.w - 40, h: NAC.h - 12 })
    .split(' ').map((p) => { const [x, y] = p.split(','); return `${NAC.x + 20 + +x},${NAC.y + 6 + +y}`; }).join(' '));

  $('h-agents').textContent = f.counts.all;
  $('h-link').textContent = t(state.herdr.ok ? 'link.ok' : 'link.offline');
  if (state.host) $('h-host').textContent = state.host;
}

function renderEngines() {
  const active = new Set(state.agents.map((agent) => agent.agent).filter(Boolean));
  $('engine-count').textContent = tp('status.active', active.size).toLocaleUpperCase(getLocaleTag());
  $('engine-accounts').innerHTML = engineOverviewHTML(state.accounts, {
    error: state.accountProfilesError,
    agents: state.agents,
    sessions: state.sessions,
    engineKinds: state.engineKinds,
  });
}

// ---------- Luces por agente ----------
const lightNodes = new Map();
function renderLights() {
  const wrap = $('lights');
  const order = [...state.agents].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId, undefined, { numeric: true }) || a.paneId.localeCompare(b.paneId, undefined, { numeric: true }));
  const live = new Set(order.map((a) => a.paneId));
  order.forEach((a, i) => {
    let n = lightNodes.get(a.paneId);
    if (!n) { n = document.createElement('button'); n.type = 'button'; n.innerHTML = '<span></span>'; n.dataset.pane = a.paneId; lightNodes.set(a.paneId, n); }
    if (wrap.children[i] !== n) wrap.insertBefore(n, wrap.children[i] || null);
    n.className = `light st-${a.status}` + (view.selected === a.paneId ? ' selected' : '');
    n.title = `${a.workspaceLabel} · ${a.paneId}\n${a.title}`;
    n.setAttribute('aria-label', `${a.title || a.paneId}. ${STATUS_LABEL[a.status]}. ${a.workspaceLabel}.`);
    n.setAttribute('aria-pressed', String(view.selected === a.paneId));
    n.firstChild.textContent = a.paneId.split(':')[1]?.replace('p', '') || '';
  });
  for (const [pid, n] of lightNodes) if (!live.has(pid)) { n.remove(); lightNodes.delete(pid); }
}

// ---------- Detalle ----------
const detail = makeDetailPanel({ emptyText: () => t('detail.empty.ship'), onFocus: focusPane, onReload: (p) => loadOutput(p),
  engineKinds: () => state.engineKinds || [], accountProfiles: () => state.accountProfiles || [], onSwapDone: renderAll });
const selected = () => state.agents.find((x) => x.paneId === view.selected);
const selectedWorkspace = () => {
  const agents = state.agents.filter((agent) => agent.workspaceId === view.selectedWorkspace);
  if (!agents.length) return null;
  const source = state.workspaces.find((workspace) => workspace.id === view.selectedWorkspace);
  return { id: view.selectedWorkspace, label: source?.label || agents[0].workspaceLabel || view.selectedWorkspace, agents };
};

function syncWorkspaceSelection() {
  for (const band of document.querySelectorAll('.ws-band')) band.classList.toggle('selected', band.dataset.ws === view.selectedWorkspace);
  for (const callout of document.querySelectorAll('.callout-label')) callout.classList.toggle('selected', callout.dataset.ws === view.selectedWorkspace);
  for (const line of document.querySelectorAll('.callout-line')) line.classList.toggle('selected', line.dataset.ws === view.selectedWorkspace);
}

function openWorkspace(workspaceId) {
  view.selectedWorkspace = workspaceId;
  view.selected = null;
  for (const node of cellNodes.values()) node.rect.classList.remove('selected');
  renderLights();
  syncWorkspaceSelection();
  const workspace = selectedWorkspace();
  if (!workspace) { view.selectedWorkspace = null; detail.render(null); return; }
  detail.renderWorkspace(workspace, workspace.agents, state.sessions, null, select);
}

function select(paneId) {
  const a = state.agents.find((agent) => agent.paneId === paneId);
  if (!a) return;
  view.selected = paneId;
  view.selectedWorkspace = a.workspaceId;
  for (const [pid, n] of cellNodes) n.rect.classList.toggle('selected', pid === paneId);
  const cell = layoutCache?.cells.find((candidate) => candidate.agent.paneId === paneId);
  if (cell) centerShipOn(cell.x, cell.y);
  renderLights();
  syncWorkspaceSelection();
  const workspace = selectedWorkspace();
  detail.renderWorkspace(workspace, workspace.agents, state.sessions, paneId, select);
  loadOutput(paneId);
}
const alerts = () => renderAlerts($('alert-list'), $('alert-count'), state.agents, { alert: `${t('alert.red')} · ${t('brand.name')}`, idle: t('meta.msd.title') });

let renderQueued = false;
function renderAll() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    view.fleet = fleetStats(state.agents, state.sessions); // una sola pasada para toda la vista
    drawShip(); renderReadouts(); renderLights(); renderEngines(); alerts();
    const workspace = selectedWorkspace();
    if (workspace) detail.renderWorkspaceIfChanged(workspace, workspace.agents, state.sessions, view.selected, select);
    else if (view.selectedWorkspace || view.selected) { view.selectedWorkspace = null; view.selected = null; detail.render(null); }
  });
}

// ---------- Arranque ----------
SHIP = await fetch('ship.json').then((r) => r.json());
drawHulls();

let resizeFrame = 0;
function refreshShipTypography() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    if (layoutCache) {
      const { groups, plan, cw, ch } = layoutCache;
      $('callouts').innerHTML = '';
      drawCallouts(groups, plan, cw, ch, true);
    }
    refreshReadableSvgTexts();
  });
}
if ('ResizeObserver' in window) new ResizeObserver(refreshShipTypography).observe($('ship'));
else window.addEventListener('resize', refreshShipTypography, { passive: true });
applyShipViewport({ refreshTypography: false });

// Un listener por contenedor en lugar de dos por compartimento.
const pick = (e) => e.target.closest('[data-pane]')?.dataset.pane;
const pickWorkspace = (e) => e.target.closest('[data-workspace-select]')?.dataset.workspaceSelect;
const activateShipTarget = (event) => {
  const paneId = pick(event);
  if (paneId) select(paneId);
  else {
    const workspaceId = pickWorkspace(event);
    if (workspaceId) openWorkspace(workspaceId);
  }
};
let shipPan = null;
let suppressShipClick = false;
$('ship').addEventListener('pointerdown', (event) => {
  if (view.shipZoom <= 1 || event.button !== 0) return;
  shipPan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, centerX: view.shipCenterX, centerY: view.shipCenterY, moved: false };
  $('ship').setPointerCapture(event.pointerId);
  $('ship-wrap').classList.add('is-panning');
});
$('ship').addEventListener('pointermove', (event) => {
  if (!shipPan || shipPan.pointerId !== event.pointerId) return;
  const dx = event.clientX - shipPan.x, dy = event.clientY - shipPan.y;
  shipPan.moved ||= Math.hypot(dx, dy) > 4;
  const scale = shipScreenScale();
  view.shipCenterX = shipPan.centerX - dx / scale;
  view.shipCenterY = shipPan.centerY - dy / scale;
  applyShipViewport({ refreshTypography: false });
});
const finishShipPan = (event) => {
  if (!shipPan || shipPan.pointerId !== event.pointerId) return;
  suppressShipClick = shipPan.moved;
  shipPan = null;
  $('ship-wrap').classList.remove('is-panning');
  refreshShipTypography();
};
$('ship').addEventListener('pointerup', finishShipPan);
$('ship').addEventListener('pointercancel', finishShipPan);
$('ship').addEventListener('click', (e) => {
  if (suppressShipClick) { suppressShipClick = false; e.preventDefault(); return; }
  activateShipTarget(e);
});
$('ship').addEventListener('dblclick', (e) => { const p = pick(e); if (p) focusPane(p); });
$('ship').addEventListener('keydown', (e) => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); activateShipTarget(e); } });
$('ship-zoom-out').addEventListener('click', () => changeShipZoom(-1));
$('ship-zoom-reset').addEventListener('click', resetShipZoom);
$('ship-zoom-in').addEventListener('click', () => changeShipZoom(1));
$('lights').addEventListener('click', (e) => { const p = pick(e); if (p) select(p); });
$('lights').addEventListener('dblclick', (e) => { const p = pick(e); if (p) focusPane(p); });
$('alert-list').addEventListener('click', (e) => { const p = pick(e); if (p) select(p); });
$('alert-list').addEventListener('dblclick', (e) => { const p = pick(e); if (p) focusPane(p); });
$('alert-list').addEventListener('keydown', (e) => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); const p = pick(e); if (p) select(p); } });
ticker.wire();

const renderSoundButton = () => { $('btn-sound').textContent = t(view.sound ? 'sound.on' : 'sound.off'); };
const renderClock = () => { $('h-clock').textContent = new Date().toLocaleTimeString(getLocaleTag()); };
bindLocaleSelector('language-select', () => {
  ticker.rerender();
  renderSoundButton();
  renderClock();
  drawHulls();
  applyShipViewport({ refreshTypography: false });
  if (!view.selectedWorkspace && !selected()) detail.render(null);
  renderAll();
});
renderSoundButton();
renderClock();

$('btn-sound').addEventListener('click', () => {
  view.sound = !view.sound;
  renderSoundButton();
  $('btn-sound').classList.toggle('on', view.sound);
  $('btn-sound').setAttribute('aria-pressed', String(view.sound));
  if (view.sound) beep('done');
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { view.selected = null; view.selectedWorkspace = null; detail.render(null); renderAll(); } });
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
