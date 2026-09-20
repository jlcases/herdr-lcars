import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import {
  accountGaugesHTML, accountProfileSelectHTML, demoFleet, detailSignature, engineOverviewHTML,
  fleetStats, swapControlHTML, workspaceAgentsHTML,
} from '../public/shared.js';
import { MESSAGES, setLocale, t } from '../public/i18n.js';
import {
  CALLOUT_DETAIL_PITCH_PX, MIN_TEXT_PX, anchoredScaleTransform, calloutDetailFits, readableTextScale,
  svgMeetScale, zoomedViewBox,
} from '../public/svg-readable-text.js';

test.beforeEach(() => setLocale('es', { persist: false, notify: false }));

test('escala: el puente agrega la capacidad pública de 2.000 agentes', () => {
  const fleet = demoFleet(2_000);
  const stats = fleetStats(fleet.agents, fleet.sessions);
  assert.equal(fleet.agents.length, 2_000);
  assert.equal(Object.keys(fleet.sessions).length, 2_000);
  assert.equal(stats.counts.all, 2_000);
});

const contrast = (foreground, background) => {
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
};

test('relevo: enseña preparación, cobertura real y escapa memoria no fiable', () => {
  const html = swapControlHTML({ agent: 'claude' }, ['claude', 'codex'], {
    context: { branch: 'main', dirty: ' M x' }, canHandoff: true,
    coverage: { quality: 'complete', narrative: true }, lineage: [{ kind: 'claude' }, { kind: 'pi' }],
    memory: {
      goal: { text: '<img src=x onerror=alert(1)>' }, files: [{ path: 'server/a.mjs' }],
      totalFiles: 8, dirtyFiles: 1, turns: 4, decisions: 2, updatedAt: Date.now(), historyIncomplete: true,
    },
  });
  assert.match(html, /Preparar relevo/);
  assert.match(html, /memoria completa/);
  assert.match(html, /4 turnos guardados/);
  assert.match(html, /y 7 más/);
  assert.match(html, /mecánica dudosa/);
  assert.match(html, /claude/);
  assert.match(html, /pi/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('relevo: un contexto vacío explica el siguiente paso y no ofrece el botón', () => {
  const html = swapControlHTML({ agent: 'claude' }, ['claude', 'codex'], {
    context: { branch: 'main', dirty: '' }, canHandoff: false,
    coverage: { quality: 'empty', narrative: false }, memory: {}, lineage: [],
  });
  assert.match(html, /Anota el objetivo/);
  assert.doesNotMatch(html, /id="btn-swap"/);
});

test('cuotas: 5 h y 7 d conservan sitio y una ausencia declara datos parciales', () => {
  const html = accountGaugesHTML([{
    key: 'a', provider: 'claude', label: 'Trabajo', tier: 'max', signal: 'live', headroom: 60,
    expectedWindows: [{ id: 'five_hour', minutes: 300 }, { id: 'seven_day', minutes: 10_080 }],
    windows: [{ id: 'seven_day', minutes: 10_080, remainingPercent: 60, expired: false, resetsAt: 1_900_000_000, source: 'claude-api' }],
  }]);
  assert.match(html, />Corto · 5 h</);
  assert.match(html, /sin dato/);
  assert.match(html, />Semanal · 7 d</);
  assert.match(html, /60%/);
  assert.match(html, /SOLO LÍMITE SEMANAL/);
  assert.match(html, /Motor<\/span> Claude Code/);
  assert.match(html, /Cuenta<\/span> Trabajo/);
  assert.match(html, /Plan max/);
  assert.match(html, /Se repone/);
  assert.match(html, /class="g-windows"/);
  assert.doesNotMatch(html, /Corto · 5 h:[^]*100 %/);
});

test('cuotas: el cliente antiguo también reserva 5 h y no confunde parcial con sin señal', () => {
  const html = accountGaugesHTML([{
    key: 'a', provider: 'codex', label: 'Personal', tier: 'pro', signal: 'live', headroom: 92,
    windows: [{ id: 'seven_day', minutes: 10_080, remainingPercent: 92, expired: false, resetsAt: 1_900_000_000, source: 'codex' }],
  }]);
  assert.match(html, />Corto · 5 h</);
  assert.match(html, />Semanal · 7 d</);
  assert.match(html, /SOLO LÍMITE SEMANAL/);
  assert.match(html, /Codex \(OpenAI\)/);
  assert.match(html, /Plan pro/);
  assert.doesNotMatch(html, /a-signal none[^>]*>SIN DATOS/);
});

test('motores: separa agentes activos de cuentas con telemetría de cuota', () => {
  const html = engineOverviewHTML([{
    provider: 'claude', label: 'Trabajo', signal: 'live',
    windows: [{ id: 'five_hour', remainingPercent: 80, source: 'claude-api' }],
  }], {
    agents: [{ agent: 'claude' }, { agent: 'claude' }, { agent: 'kimi' }],
    engineKinds: ['claude', 'codex', 'kimi', 'grok', 'opencode', 'pi'],
  });
  assert.match(html, /Claude Code/);
  assert.match(html, /2 agentes/);
  assert.match(html, /Kimi/);
  assert.match(html, /1 agente/);
  assert.match(html, /cuota no publicada/);
  assert.match(html, /Otros motores compatibles/);
  assert.match(html, /Codex \(OpenAI\) · Grok · OpenCode · Pi/);
});

test('motores: un Pi local no se presenta como una cuota remota desconocida', () => {
  const html = engineOverviewHTML([], {
    agents: [{ agent: 'pi', sessionId: 'pi-local-1' }],
    sessions: { 'pi-local-1': { provider: 'mlx', local: true } },
    engineKinds: ['pi'],
  });
  assert.match(html, /Pi/);
  assert.match(html, /local · sin cuota de cuenta/);
  assert.doesNotMatch(html, /cuota no publicada/);
});

test('detalle del sistema: un workspace conserva visibles e identificables todos sus agentes', () => {
  const agents = [
    { paneId: 'wB:p1', workspaceLabel: 'multimodal', tabLabel: 'core', agent: 'codex', status: 'working', statusSince: Date.now() - 20_000, title: 'Recupera la conversación', cwd: '/repo/worktrees/videos/core', sessionId: 's1' },
    { paneId: 'wB:p2', workspaceLabel: 'multimodal', tabLabel: 'video2', agent: 'codex', status: 'idle', statusSince: Date.now() - 60_000, title: 'Confirma el repositorio', cwd: '/repo/worktrees/videos/video2', sessionId: 's2' },
    { paneId: 'wB:p3', workspaceLabel: 'multimodal', tabLabel: 'video3', agent: 'claude', status: 'blocked', statusSince: Date.now() - 120_000, title: 'Render bloqueado', cwd: 'C:\\repo\\videos\\video3', sessionId: 's3' },
  ];
  const html = workspaceAgentsHTML({ id: 'wB', label: 'multimodal' }, agents, {
    s1: { model: 'gpt-5', recent: { tokPerSecLast: 73 }, totals: { output: 12_000 }, costUsd: 1.25 },
    s2: { totals: { output: 3_000 } },
    s3: { model: 'claude-opus-5', totals: { output: 8_000 }, costUsd: 2 },
  }, 'wB:p2');
  assert.equal((html.match(/data-agent-pane=/g) || []).length, 3);
  for (const name of ['>core<', '>video2<', '>video3<']) assert.match(html, new RegExp(name));
  for (const fullName of ['multimodal / core', 'multimodal / video2', 'multimodal / video3']) assert.match(html, new RegExp(fullName));
  for (const task of ['Recupera la conversación', 'Confirma el repositorio', 'Render bloqueado']) assert.match(html, new RegExp(task));
  assert.match(html, /Codex \(OpenAI\), panel wB:p1/);
  assert.match(html, /Claude Code, panel wB:p3/);
  assert.match(html, /…\/worktrees\/videos\/core/);
  assert.match(html, /…\/repo\/videos\/video3/);
  assert.equal((html.match(/class="workspace-agent-node"/g) || []).length, 3);
  assert.match(html, /data-agent-pane="wB:p2" aria-pressed="true"/);
  assert.match(html, /3 agentes · 1 trabajando · 1 bloqueados/);
});

test('detalle del sistema: el árbol explica un workspace vacío y no inventa identidades', () => {
  const empty = workspaceAgentsHTML({ id: 'w0', label: 'vacío' }, [], {}, null);
  assert.match(empty, /Este workspace no tiene agentes conectados/);
  assert.doesNotMatch(empty, /data-agent-pane=/);
  assert.doesNotMatch(empty, /undefined|null/);

  const unnamed = workspaceAgentsHTML({ id: 'w1', label: 'tools' }, [{
    paneId: 'w1:pR', workspaceLabel: 'tools', tabLabel: '', agent: 'codex', status: 'unexpected',
    statusSince: null, title: '', cwd: '', sessionId: null,
  }], {}, null);
  assert.match(unnamed, />w1:pR</);
  assert.match(unnamed, /Sin clasificar/);
  assert.match(unnamed, /carpeta no informada/);
  assert.doesNotMatch(unnamed, /st-unexpected/);
});

test('cabeceras: distinguen agentes conectados de trabajo y salida reciente', async () => {
  const [html, app, msd] = await Promise.all([
    fsp.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fsp.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fsp.readFile(new URL('../public/msd.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /Agentes conectados/);
  assert.match(html, /Salida reciente/);
  assert.match(app, /'s-active'\)\.textContent = f\.counts\.all/);
  assert.match(msd, /t\('stats\.connected'\), f\.counts\.all/);
  assert.match(msd, /t\('stats\.recentOutput'\).*t\('stats\.recentRate'\)/s);
  assert.match(app, /idle: t\('meta\.compact\.title'\)/);
  assert.match(msd, /idle: t\('meta\.msd\.title'\)/);
  assert.match(app, /renderClock\(\);/);
  assert.match(msd, /applyShipViewport\(\{ refreshTypography: false \}\)/);
  for (const source of [html, app, msd]) assert.doesNotMatch(source, /Agentes activos/);
});

test('relevo: ofrece perfiles legibles y permite cambiar de cuenta en el mismo motor', () => {
  const profiles = [
    { id: 'claude-default', provider: 'claude', label: 'Trabajo', isDefault: true, headroom: 4 },
    { id: 'claude-spare', provider: 'claude', label: 'Personal', isDefault: false, headroom: 82 },
  ];
  const select = accountProfileSelectHTML('claude', profiles, { agent: 'claude', accountProfileId: 'claude-default' });
  assert.match(select, /Personal · 82% restante/);
  assert.doesNotMatch(select, /Trabajo/);
  const html = swapControlHTML({ agent: 'claude', accountProfileId: 'claude-default' }, ['claude', 'codex'], {
    context: { branch: 'main', dirty: '' }, canHandoff: true, coverage: { quality: 'complete' }, memory: {}, lineage: [],
  }, profiles);
  assert.match(html, /value="claude"/);
  assert.match(html, /id="swap-profile-slot"/);
  assert.notEqual(
    detailSignature({ paneId: 'p', agent: 'claude', accountProfileId: 'work' }, {}),
    detailSignature({ paneId: 'p', agent: 'claude', accountProfileId: 'personal' }, {}),
    'cambiar la cuenta activa invalida el detalle',
  );
});

test('las vistas comparten una semántica de estado inequívoca y accesible', async () => {
  const [css, lcars] = await Promise.all([
    fsp.readFile(new URL('../public/msd.css', import.meta.url), 'utf8'),
    fsp.readFile(new URL('../public/lcars.css', import.meta.url), 'utf8'),
  ]);
  assert.match(css, /\.lights \{/);
  assert.match(css, /\.light \{/);
  for (const color of ['#cc99cc', '#9977aa', '#ff9966', '#ffcc66', '#99ccff', '#ff5555']) assert.match(css, new RegExp(color, 'i'));
  assert.ok(contrast('#9977aa', '#0a0710') >= 4.5);
  assert.ok(contrast('#999999', '#0a0710') >= 4.5);
  assert.ok(contrast('#000000', '#ff8a3d') >= 4.5, 'los números sobre cuadrados en espera deben pasar AA');
  assert.ok(contrast('#000000', '#66d99a') >= 4.5, 'los números sobre cuadrados terminados deben pasar AA');
  assert.ok(contrast('#ffcc99', '#3a2d40') >= 4.5, 'los números sobre cuadrados unknown deben pasar AA');
  for (const stylesheet of [css, lcars]) {
    assert.match(stylesheet, /--st-working:\s*#ffcc66/);
    assert.match(stylesheet, /--st-idle:\s*#ff8a3d/);
    assert.match(stylesheet, /--st-done:\s*#66d99a/);
    assert.match(stylesheet, /--st-blocked:\s*#ff5555/);
  }
  assert.match(css, /\.light\.st-idle span \{ color: #000; \}/);
  assert.match(css, /\.log li\.k-done \.k, \.log li\.k-turn_done \.k \{ color: var\(--st-done\); \}/);
  assert.match(css, /\.log li\.k-idle \.k \{ color: var\(--st-idle\); \}/);
});

test('MSD conserva una tipografía legible al reducir el plano SVG', async () => {
  const [css, compact, context, html] = await Promise.all([
    fsp.readFile(new URL('../public/msd.css', import.meta.url), 'utf8'),
    fsp.readFile(new URL('../public/lcars.css', import.meta.url), 'utf8'),
    fsp.readFile(new URL('../public/context.css', import.meta.url), 'utf8'),
    fsp.readFile(new URL('../public/msd.html', import.meta.url), 'utf8'),
  ]);
  const scale = svgMeetScale(1240, 670);
  const secondaryFactor = readableTextScale(20, MIN_TEXT_PX.secondary, scale);
  const primaryFactor = readableTextScale(27, MIN_TEXT_PX.primary, scale);
  assert.ok(20 * scale * secondaryFactor >= 13);
  assert.ok(27 * scale * primaryFactor >= 15);
  assert.equal(CALLOUT_DETAIL_PITCH_PX, 54);
  assert.equal(calloutDetailFits(96, scale), false, 'dos líneas no caben en un paso de 34 px');
  assert.equal(calloutDetailFits(160, scale), true, 'dos líneas sí caben con al menos 54 px');
  assert.equal(calloutDetailFits(160, 0), false);
  assert.ok((74 - 4) * scale >= 22, 'título y subtítulo conservan al menos 22 px entre anclas');
  assert.match(anchoredScaleTransform(560, 500, primaryFactor), /translate\(560 500\) scale\(/);
  assert.match(css, /--text-min:\s*13px;\s*--text-ui:\s*15px/);
  assert.match(css, /--leading-ui:\s*1\.5;\s*--leading-copy:\s*1\.6/);
  assert.match(css, /\.light span[^}]*font-size:\s*var\(--text-min\)/s);
  assert.match(css, /\.side \{[^}]*grid-template-columns:\s*minmax\(330px, 1\.1fr\) minmax\(280px, \.9fr\)/s);
  assert.match(css, /\.readouts \{[^}]*grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\)/s);
  assert.match(css, /grid-template-rows:\s*minmax\(74px, 1fr\)/);
  assert.match(css, /\.bands \{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/s);
  assert.match(css, /grid-template-rows:\s*var\(--rail\) minmax\(0, 1fr\) clamp\(144px, 15vh, 170px\) var\(--rail\)/);
  assert.match(css, /\.side-detail \{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) clamp\(150px, 22vh, 210px\)/s);
  assert.match(css, /\.engine-body \{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.g-row \{[^}]*min-height:\s*68px[^}]*line-height:\s*var\(--leading-ui\)/s);
  assert.match(css, /\.acct-list \{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /\.g-windows \{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(compact, /--text-min:\s*13px/);
  assert.match(compact, /--leading-ui:\s*1\.5/);
  assert.match(compact, /\.g-row \{[^}]*min-height:\s*56px[^}]*line-height:\s*var\(--leading-ui\)/s);
  assert.match(css, /\.log li \{[^}]*padding:\s*10px 5px[^}]*line-height:\s*var\(--leading-ui\)/s);
  assert.doesNotMatch(`${compact}\n${context}`, /font-size:\s*(?:[0-9]|1[0-2])px/,
    'la interfaz HTML no vuelve a introducir texto inferior a 13 px');
  assert.match(html, /class="panel log"[\s\S]*id="ticker"/);
  assert.match(html, /class="panel engines"[\s\S]*id="engine-accounts"/);
  assert.match(html, /id="lights"[\s\S]*id="readouts"/, 'las fichas deben quedar entre la nave y las métricas');
  assert.doesNotMatch(html, /class="band log"/);
});

test('MSD permite ampliar, restablecer y desplazar el plano sin salir de sus límites', async () => {
  const [html, js] = await Promise.all([
    fsp.readFile(new URL('../public/msd.html', import.meta.url), 'utf8'),
    fsp.readFile(new URL('../public/msd.js', import.meta.url), 'utf8'),
  ]);
  assert.deepEqual(zoomedViewBox({ zoom: 2, centerX: 1800, centerY: 500 }), { x: 900, y: 250, width: 1800, height: 500 });
  const edge = zoomedViewBox({ zoom: 3, centerX: -100, centerY: 5000 });
  assert.equal(edge.x, 0);
  assert.equal(edge.width, 1200);
  assert.ok(Math.abs(edge.y - 2000 / 3) < Number.EPSILON * 1000);
  assert.ok(Math.abs(edge.height - 1000 / 3) < Number.EPSILON * 1000);
  for (const id of ['ship-zoom-out', 'ship-zoom-reset', 'ship-zoom-in']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(js, /SHIP_ZOOM_LEVELS/);
  assert.match(js, /pointermove/);
  assert.match(js, /centerShipOn/);
  assert.match(js, /function openWorkspace\(workspaceId\)/);
  assert.match(js, /data-workspace-select/);
  assert.match(js, /detail\.renderWorkspace/);
  assert.match(js, /view\.selected === a\.paneId/);
  assert.doesNotMatch(js, /state\.selected === a\.paneId/);
  assert.doesNotMatch(js, /\bconst t\s*=/, 'una variable local no puede ocultar la función de traducción');
  assert.match(js, /readableSvgText\(legendLabel,/);
  assert.match(js, /labelNode\.setAttribute\('aria-label', t\('ship\.selectWorkspace'/);
});

test('el selector de relevo conserva motor y cuenta durante repintados de telemetría', async () => {
  const source = await fsp.readFile(new URL('../public/shared.js', import.meta.url), 'utf8');
  assert.match(source, /const swapSelections = new Map\(\)/);
  assert.match(source, /swapSelections\.get\(a\.paneId\)/);
  assert.match(source, /selection\.profileId = profile\.value/);
});

test('HTML no necesita script inline y ofrece navegación de salto', async () => {
  for (const name of ['index.html', 'msd.html']) {
    const html = await fsp.readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
    assert.match(html, /class="skip-link"/);
    assert.match(html, /context\.css/);
  }
});

test('LCARS for Herdr ofrece español e inglés completos, persistentes y sin duplicar la lógica de producto', async () => {
  const [compact, msd] = await Promise.all([
    fsp.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fsp.readFile(new URL('../public/msd.html', import.meta.url), 'utf8'),
  ]);
  assert.deepEqual(Object.keys(MESSAGES.es).sort(), Object.keys(MESSAGES.en).sort());
  for (const html of [compact, msd]) {
    assert.match(html, /id="language-select"/);
    assert.match(html, /<option value="es">ES<\/option>/);
    assert.match(html, /<option value="en">EN<\/option>/);
    assert.match(html, /language\.css/);
    assert.match(html, /LCARS for Herdr/);
    assert.doesNotMatch(html, /HERDR FLEET|FLEET OPERATIONS · HERDR/);
  }

  setLocale('en', { persist: false, notify: false });
  assert.equal(t('status.idle'), 'Waiting');
  const quota = accountGaugesHTML([{
    key: 'a', provider: 'claude', label: 'Work', tier: 'max', signal: 'live',
    expectedWindows: [{ id: 'five_hour', minutes: 300 }, { id: 'seven_day', minutes: 10_080 }],
    windows: [{ id: 'seven_day', minutes: 10_080, remainingPercent: 60, resetsAt: 1_900_000_000 }],
  }]);
  assert.match(quota, />Short · 5 h</);
  assert.match(quota, />Weekly · 7 d</);
  assert.match(quota, /WEEKLY LIMIT ONLY/);
  assert.match(quota, /Engine<\/span> Claude Code/);
  assert.match(quota, /Account<\/span> Work/);
  assert.match(quota, /Resets/);
  assert.doesNotMatch(quota, /Corto|Semanal|Se repone/);

  const handoff = swapControlHTML({ agent: 'claude' }, ['claude', 'codex'], {
    context: { branch: 'main', dirty: '' }, canHandoff: true,
    coverage: { quality: 'complete', narrative: true }, memory: {}, lineage: [],
  });
  assert.match(handoff, /Prepare handoff/);
  assert.match(handoff, /complete memory/);
  assert.doesNotMatch(handoff, /Preparar relevo|memoria completa/);

  const agent = { paneId: 'p', agent: 'claude', accountProfileId: 'work' };
  const signatureEn = detailSignature(agent, {});
  setLocale('es', { persist: false, notify: false });
  assert.notEqual(detailSignature(agent, {}), signatureEn, 'cambiar el idioma invalida el detalle para repintarlo');
});

test('la cubierta móvil conserva espacio útil y abre el detalle como panel cerrable', async () => {
  const [html, css, js] = await Promise.all([
    fsp.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fsp.readFile(new URL('../public/lcars.css', import.meta.url), 'utf8'),
    fsp.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="btn-detail-close"[^>]*data-i18n-aria-label="common\.close"/);
  assert.match(css, /grid-template-rows:\s*44px auto minmax\(0, 1fr\)/);
  assert.match(css, /\.ticker, \.right \{ display: none; \}/);
  assert.match(css, /body\.detail-open \.right/);
  assert.match(js, /function closeDetail\(\)/);
  assert.match(js, /btn-detail-close/);
});
