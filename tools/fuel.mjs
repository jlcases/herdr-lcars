// Cuadro de combustible para la ventana emergente de Herdr: cuánta cuota le queda a cada cuenta,
// qué agentes tira de cada motor y qué está bloqueado. SSE lo mantiene en tiempo real; cualquier
// tecla lo cierra.
const configuredPort = Number(process.env.LCARS_PORT || 4700);
const PORT = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535 ? configuredPort : 4700;
const W = () => Math.max(60, Math.min(process.stdout.columns || 100, 160));
const API = `http://127.0.0.1:${PORT}`;

const C = { off: '\x1b[0m', dim: '\x1b[2m', b: '\x1b[1m', am: '\x1b[38;5;215m', pe: '\x1b[38;5;147m', rd: '\x1b[38;5;203m', or: '\x1b[38;5;215m', gr: '\x1b[38;5;150m', bl: '\x1b[38;5;111m' };
const DEFAULT_WINDOWS = Object.freeze({
  claude: Object.freeze([{ id: 'five_hour', minutes: 300 }, { id: 'seven_day', minutes: 10_080 }]),
  codex: Object.freeze([{ id: 'five_hour', minutes: 300 }, { id: 'seven_day', minutes: 10_080 }]),
});
const safe = (value) => String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
const pad = (value, n) => { const s = safe(value); return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n); };
const fmtReset = (sec) => {
  if (!sec) return '—';
  const m = Math.round((sec * 1000 - Date.now()) / 60_000);
  if (m <= 0) return 'ya';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
};

function bar(left, width) {
  // La barra mide combustible RESTANTE, no consumo: es lo que se quiere leer de un vistazo.
  if (left == null) return C.dim + '·'.repeat(width) + C.off;
  left = Math.max(0, Math.min(100, left));
  const fill = Math.round((left / 100) * width);
  const col = left <= 10 ? C.rd : left <= 25 ? C.or : C.gr;
  return col + '█'.repeat(fill) + C.dim + '░'.repeat(width - fill) + C.off;
}

function render(state) {
  const w = W(), out = [];
  const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
  const agents = Array.isArray(state?.agents) ? state.agents : [];
  const sessions = state?.sessions && typeof state.sessions === 'object' ? state.sessions : {};
  // La cuenta va en la sesión, no en el agente: el panel lo cruza por sessionId.
  const accountOf = (g) => sessions[g.sessionId]?.accountKey;
  const link = state?.link || 'CONECTANDO';
  const linkColor = link === 'EN VIVO · SSE' ? C.gr : link === 'RECONECTANDO' ? C.or : C.dim;
  out.push(`${C.am}${C.b}COMBUSTIBLE POR CUENTA${C.off}  ${C.dim}${new Date().toLocaleTimeString('es-ES')} · ${agents.length} agentes · ${C.off}${linkColor}${link}${C.off}`);
  out.push(C.dim + '─'.repeat(w) + C.off);

  if (state?.accountProfilesError) out.push(`${C.rd}${C.b}Perfiles:${C.off} ${safe(state.accountProfilesError)}\n`);

  if (!accounts.length) out.push(`${C.dim}Ninguna cuenta identificada todavía. Lanza un agente y vuelve.${C.off}`);

  // Cada cuenta conserva las dos filas esperadas. Ausencia es «SIN SEÑAL», nunca 100 % restante.
  for (const a of accounts) {
    const head = a.headroom == null ? '  —' : `${String(Math.round(a.headroom)).padStart(3)}%`;
    const col = a.headroom == null ? C.dim : a.headroom <= 10 ? C.rd : a.headroom <= 25 ? C.or : C.gr;
    const mine = agents.filter((g) => accountOf(g) === a.key).length;
    const actual = new Map((a.windows || []).map((win) => [win.id, win]));
    const expected = a.expectedWindows?.length ? a.expectedWindows : DEFAULT_WINDOWS[a.provider] || (a.windows || []);
    const ordered = [...expected, ...(a.windows || []).filter((win) => !expected.some((spec) => spec.id === win.id))];
    const remaining = (win) => win?.remainingPercent ?? (win?.usedPercent == null ? null : 100 - win.usedPercent);
    const currentWindows = expected.map((spec) => actual.get(spec.id))
      .filter((win) => win && !win.expired && remaining(win) != null);
    const current = currentWindows.length;
    const source = currentWindows.some((win) => win.source === 'claude-api') ? 'CLAUDE'
      : currentWindows.some((win) => win.source === 'codex') ? 'CODEX'
        : currentWindows.some((win) => win.source === 'statusline') ? 'STATUSLINE' : 'SEÑAL';
    const freshness = { live: source, recent: 'RECIENTE', cold: 'EN FRÍO', none: 'SIN SEÑAL' }[a.signal] || 'SIN SEÑAL';
    const signal = current === 0 ? 'SIN SEÑAL' : current < expected.length ? `PARCIAL · ${freshness}`
      : a.signal === 'live' ? `EN VIVO · ${source}` : freshness;
    out.push(`${C.pe}${C.b}${pad(a.label || a.provider, 34)}${C.off} ${col}${C.b}${head} restante${C.off} ${C.dim}${pad(a.tier || a.provider, 14)} ${mine ? `${mine} agentes · ` : ''}${signal}${C.off}`);
    for (const spec of ordered) {
      const win = actual.get(spec.id);
      const name = spec.id === 'five_hour' ? '5 h' : spec.id === 'seven_day' ? '7 d' : `${Math.round(spec.minutes / 60)} h`;
      const left = remaining(win);
      const available = win && !win.expired && left != null;
      if (!available) {
        out.push(`  ${C.dim}${pad(name, 8)}${bar(null, Math.max(20, w - 58))}   —   SIN SEÑAL · esperando lectura${C.off}`);
        continue;
      }
      const roundedLeft = Math.round(left);
      const pace = win.pace == null ? '' : win.pace > 0 ? `${C.rd}+${Math.round(win.pace)}% sobre ritmo${C.off}` : `${C.gr}${Math.abs(Math.round(win.pace))}% bajo ritmo${C.off}`;
      out.push(`  ${C.dim}${pad(name, 8)}${C.off}${bar(left, Math.max(20, w - 58))} ${String(roundedLeft).padStart(3)}% restante  ${C.dim}repone en ${pad(fmtReset(win.resetsAt), 6)}${C.off}${win.cold ? ` ${C.dim}dato frío${C.off}` : ''} ${pace}`);
    }
    out.push('');
  }

  const blocked = agents.filter((g) => g.status === 'blocked');
  if (blocked.length) {
    out.push(`${C.rd}${C.b}${blocked.length} esperando respuesta${C.off}`);
    for (const g of blocked.slice(0, 5)) out.push(`  ${C.rd}▸${C.off} ${pad(g.title || g.paneId, 40)} ${C.dim}${safe(g.paneId)} · ${safe(g.agent)}${C.off}`);
    out.push('');
  }

  const byKind = new Map();
  for (const g of agents) if (g.status === 'working') byKind.set(g.agent, (byKind.get(g.agent) || 0) + 1);
  if (byKind.size) out.push(`${C.bl}Trabajando ahora:${C.off} ${[...byKind].map(([k, n]) => `${n} ${safe(k)}`).join(' · ')}`);
  out.push(`${C.dim}Cualquier tecla cierra. El relevo de motor se hace desde el panel.${C.off}`);
  return out.join('\n');
}

let state = { link: 'CONECTANDO' }, stopped = false, retryTimer = null;
const controller = new AbortController();
const paint = () => process.stdout.write('\x1b[H\x1b[2J' + render(state) + '\n');

function apply(event, payload) {
  if (event === 'state') state = { ...payload, link: 'EN VIVO · SSE' };
  else if (event === 'accounts') state = { ...state, ...payload, link: 'EN VIVO · SSE' };
  else if (event === 'tick') state = {
    ...state, ...payload,
    sessions: payload.sessions ? { ...(state.sessions || {}), ...payload.sessions } : state.sessions,
    link: 'EN VIVO · SSE',
  };
  else return;
  paint();
}

function consumeFrame(frame) {
  let event = 'message'; const data = [];
  for (const line of frame.replaceAll('\r', '').split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return;
  try { apply(event, JSON.parse(data.join('\n'))); } catch { /* un frame roto no tumba el pane */ }
}

async function connect() {
  if (stopped) return;
  try {
    state.link = 'CONECTANDO'; paint();
    const response = await fetch(`${API}/events`, {
      headers: { accept: 'text/event-stream' }, signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    state.link = 'EN VIVO · SSE'; paint();
    const decoder = new TextDecoder(); let pending = '';
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        consumeFrame(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
      }
    }
    if (!stopped) throw new Error('SSE cerrado');
  } catch (error) {
    if (stopped || error?.name === 'AbortError') return;
    state.link = 'RECONECTANDO'; paint();
    retryTimer = setTimeout(connect, 2_000);
  }
}

const quit = () => {
  stopped = true; clearTimeout(retryTimer); controller.abort();
  process.stdout.write('\x1b[?25h\n'); process.exit(0);
};
process.stdout.write('\x1b[?25l');
if (process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', quit); }
process.on('SIGINT', quit); process.on('SIGTERM', quit);
paint();
await connect();
