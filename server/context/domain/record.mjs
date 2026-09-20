// Agregado de contexto. Se actualiza mediante eventos validados y se persiste como snapshot
// versionado; no pretende ser un event store.
import { invalidReason, layerOf, LAYER } from './events.mjs';
import { normalizedTextKey, redactSecrets } from './text.mjs';

export const RECORD_VERSION = 2;
export const CAPS = { files: 400, commits: 50, failures: 20, turns: 40, decisions: 30, agents: 40, requirements: 30, handoffs: 40 };

export function emptyRecord(contextId, workspace = {}) {
  return {
    version: RECORD_VERSION,
    contextId,
    repoRoot: workspace.repoRoot ?? null,
    branch: workspace.branch ?? null,
    checkoutPath: workspace.checkoutPath ?? null,
    goal: null,
    nextStep: null,
    head: null,
    worktree: { fingerprint: null, clean: true, totalFiles: 0, observedAt: null },
    decisions: [], files: [], commits: [], failures: [], turns: [], agents: [], requirements: [], handoffs: [],
    events: 0,
    updatedAt: null,
    historyIncomplete: false,
  };
}

const tail = (list, cap) => (list.length > cap ? list.slice(list.length - cap) : list);
const keyOfAgent = (a) => a.sessionId ? `${a.kind}:${a.sessionId}` : `${a.kind}:${a.paneId}`;

const REDUCERS = {
  worktree_observed: (rec, e) => {
    const byPath = new Map(rec.files.map((f) => [f.path, f]));
    for (const f of e.files) {
      const prev = byPath.get(f.path);
      byPath.set(f.path, {
        path: f.path,
        status: f.status ?? prev?.status ?? null,
        previousPath: f.previousPath ?? prev?.previousPath ?? null,
        added: Number.isInteger(f.added) ? f.added : (prev?.added ?? null),
        removed: Number.isInteger(f.removed) ? f.removed : (prev?.removed ?? null),
        firstAt: prev?.firstAt ?? e.at,
        lastAt: e.at,
      });
    }
    const files = [...byPath.values()].sort((a, b) => a.lastAt - b.lastAt);
    return {
      files: tail(files, CAPS.files),
      head: e.head ?? rec.head,
      worktree: { fingerprint: e.fingerprint, clean: (e.totalFiles ?? e.files.length) === 0,
        totalFiles: e.totalFiles ?? e.files.length, observedAt: e.at },
    };
  },
  commit: (rec, e) => ({
    commits: rec.commits.some((c) => c.sha === e.sha)
      ? rec.commits
      : tail([...rec.commits, { at: e.at, sha: e.sha, subject: e.subject ?? null }], CAPS.commits),
    head: e.sha,
  }),
  failure: (rec, e) => ({ failures: tail([...rec.failures, { at: e.at, text: e.text, sourceKey: e.sourceKey ?? null }], CAPS.failures) }),
  turn: (rec, e) => ({ turns: tail([...rec.turns, { at: e.at, role: e.role, text: e.text, sourceKey: e.sourceKey ?? null }], CAPS.turns) }),
  engine_seen: (rec, e) => {
    const seen = new Map(rec.agents.map((a) => [keyOfAgent(a), a]));
    const agent = { at: e.at, kind: e.kind, sessionId: e.sessionId ?? null, paneId: e.paneId };
    seen.set(keyOfAgent(agent), agent);
    return { agents: tail([...seen.values()], CAPS.agents) };
  },
  handoff_started: (rec, e) => ({
    handoffs: tail([...rec.handoffs.filter((h) => h.id !== e.id), {
      id: e.id, at: e.at, status: 'started', from: e.from, to: e.to, paneId: e.paneId ?? null,
    }], CAPS.handoffs),
  }),
  handoff_finished: (rec, e) => ({
    handoffs: tail(rec.handoffs.map((h) => h.id === e.id
      ? { ...h, finishedAt: e.at, status: e.status, to: e.to ?? h.to, error: e.error ?? null, delivered: Boolean(e.delivered) }
      : h), CAPS.handoffs),
  }),
  requirement: (rec, e) => {
    const key = (r) => `${r.kind}:${r.name}`;
    const seen = new Map(rec.requirements.map((r) => [key(r), r]));
    seen.set(key(e), { kind: e.kind, name: e.name, lastAt: e.at });
    return { requirements: tail([...seen.values()], CAPS.requirements) };
  },
  goal_set: (_rec, e) => ({ goal: { text: e.text, at: e.at, by: e.by ?? null } }),
  next_step: (_rec, e) => ({ nextStep: { text: e.text, at: e.at, by: e.by ?? null } }),
  decision: (rec, e) => ({ decisions: tail([...rec.decisions, { at: e.at, text: e.text, by: e.by ?? null }], CAPS.decisions) }),
};

export function applyEvent(record, event) {
  const reason = invalidReason(event);
  if (reason) throw Object.assign(new Error(reason), { status: 400 });
  const patch = REDUCERS[event.type](record, event);
  return { ...record, ...patch, events: record.events + 1, updatedAt: Math.max(record.updatedAt ?? 0, event.at) };
}

export const applyAll = (record, events) => events.reduce(applyEvent, record);

export function coverage(record) {
  const narrative = Boolean(record.goal || record.nextStep || record.decisions.length || record.requirements.length);
  const mechanical = Boolean(record.files.length || record.commits.length || record.turns.length || record.failures.length);
  const handoffReady = narrative || mechanical;
  const quality = narrative && mechanical ? 'complete' : handoffReady ? 'basic' : 'empty';
  const missing = [!record.goal && 'goal', !record.nextStep && 'nextStep', !record.turns.length && 'thread'].filter(Boolean);
  return { narrative, mechanical, handoffReady, quality, missing,
    layers: [mechanical && LAYER.MECHANICAL, narrative && LAYER.NARRATIVE].filter(Boolean) };
}

export function newTurns(record, incoming) {
  const seenKeys = new Set(record.turns.map((t) => t.sourceKey).filter(Boolean));
  const seenFallback = new Set(record.turns.filter((t) => !t.sourceKey).map((t) => normalizedTextKey(t.role, t.text)));
  const out = [];
  if (!Array.isArray(incoming)) return out;
  for (const raw of incoming.slice(-CAPS.turns * 2)) {
    if (!raw || typeof raw !== 'object' || !['humano', 'agente'].includes(raw.role) || typeof raw.text !== 'string') continue;
    const t = { ...raw, text: redactSecrets(raw.text) };
    const key = t.sourceKey || normalizedTextKey(t.role, t.text);
    const seen = t.sourceKey ? seenKeys : seenFallback;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function engineLineage(record) {
  const completed = record.handoffs.filter((h) => h.status === 'completed' && h.delivered);
  if (!completed.length) return record.agents.length ? [{ kind: record.agents[0].kind, at: record.agents[0].at, sessionId: record.agents[0].sessionId }] : [];
  const out = [{ kind: completed[0].from.kind, at: completed[0].at, sessionId: completed[0].from.sessionId ?? null }];
  for (const h of completed) {
    if (out.at(-1)?.kind !== h.to.kind) out.push({ kind: h.to.kind, at: h.finishedAt ?? h.at, sessionId: h.to.sessionId ?? null });
  }
  return out;
}

const corrupt = (message) => {
  const error = new Error(`snapshot de contexto invalido: ${message}`);
  error.code = 'CONTEXT_CORRUPT';
  throw error;
};
const timeOrNull = (value, field) => {
  if (value == null) return null;
  if (!Number.isInteger(value) || value <= 0) corrupt(field);
  return value;
};
const stringOrNull = (value, max, field, { required = false, redact = false } = {}) => {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || (required && !value) || value.length > max || value.includes('\0')) corrupt(field);
  return redact ? redactSecrets(value) : value;
};
const listOf = (record, name, cap, map) => {
  const value = record[name];
  if (!Array.isArray(value) || value.length > cap) corrupt(name);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) corrupt(`${name}[${index}]`);
    return map(item, `${name}[${index}]`);
  });
};
const narrative = (value, max, field) => value == null ? null : {
  text: stringOrNull(value.text, max, `${field}.text`, { required: true, redact: true }),
  at: timeOrNull(value.at, `${field}.at`),
  by: stringOrNull(value.by, 64, `${field}.by`),
};
const endpoint = (value, field) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) corrupt(field);
  return { kind: stringOrNull(value.kind, 40, `${field}.kind`, { required: true }),
    sessionId: stringOrNull(value.sessionId, 200, `${field}.sessionId`) };
};

/** Valida snapshots v2 al cruzar el puerto de persistencia y descarta campos no pertenecientes al dominio. */
function normalizeCurrentRecord(raw, contextId, workspace) {
  if (raw.contextId !== contextId) corrupt('contextId');
  const base = emptyRecord(contextId, workspace);
  const worktree = raw.worktree;
  if (!worktree || typeof worktree !== 'object' || Array.isArray(worktree)) corrupt('worktree');
  if (typeof worktree.clean !== 'boolean' || !Number.isInteger(worktree.totalFiles) || worktree.totalFiles < 0) corrupt('worktree');

  const record = {
    ...base,
    repoRoot: workspace.repoRoot ?? stringOrNull(raw.repoRoot, 4_000, 'repoRoot'),
    branch: workspace.branch ?? stringOrNull(raw.branch, 1_000, 'branch'),
    checkoutPath: workspace.checkoutPath ?? stringOrNull(raw.checkoutPath, 4_000, 'checkoutPath'),
    goal: narrative(raw.goal, 4_000, 'goal'),
    nextStep: narrative(raw.nextStep, 4_000, 'nextStep'),
    head: stringOrNull(raw.head, 80, 'head'),
    worktree: {
      fingerprint: stringOrNull(worktree.fingerprint, 200, 'worktree.fingerprint'),
      clean: worktree.clean, totalFiles: worktree.totalFiles,
      observedAt: timeOrNull(worktree.observedAt, 'worktree.observedAt'),
    },
    events: Number.isSafeInteger(raw.events) && raw.events >= 0 ? raw.events : corrupt('events'),
    updatedAt: timeOrNull(raw.updatedAt, 'updatedAt'),
    historyIncomplete: raw.historyIncomplete === true,
  };

  record.files = listOf(raw, 'files', CAPS.files, (file, field) => ({
    path: stringOrNull(file.path, 2_000, `${field}.path`, { required: true }),
    status: stringOrNull(file.status, 8, `${field}.status`),
    previousPath: stringOrNull(file.previousPath, 2_000, `${field}.previousPath`),
    added: file.added == null ? null : (Number.isInteger(file.added) && file.added >= 0 ? file.added : corrupt(`${field}.added`)),
    removed: file.removed == null ? null : (Number.isInteger(file.removed) && file.removed >= 0 ? file.removed : corrupt(`${field}.removed`)),
    firstAt: timeOrNull(file.firstAt, `${field}.firstAt`), lastAt: timeOrNull(file.lastAt, `${field}.lastAt`),
  }));
  record.commits = listOf(raw, 'commits', CAPS.commits, (commit, field) => ({
    at: timeOrNull(commit.at, `${field}.at`), sha: stringOrNull(commit.sha, 80, `${field}.sha`, { required: true }),
    subject: stringOrNull(commit.subject, 500, `${field}.subject`, { redact: true }),
  }));
  record.failures = listOf(raw, 'failures', CAPS.failures, (failure, field) => ({
    at: timeOrNull(failure.at, `${field}.at`),
    text: stringOrNull(failure.text, 1_000, `${field}.text`, { required: true, redact: true }),
    sourceKey: stringOrNull(failure.sourceKey, 300, `${field}.sourceKey`),
  }));
  record.turns = listOf(raw, 'turns', CAPS.turns, (turn, field) => {
    if (!['humano', 'agente'].includes(turn.role)) corrupt(`${field}.role`);
    return { at: timeOrNull(turn.at, `${field}.at`), role: turn.role,
      text: stringOrNull(turn.text, 8_000, `${field}.text`, { required: true, redact: true }),
      sourceKey: stringOrNull(turn.sourceKey, 300, `${field}.sourceKey`) };
  });
  record.decisions = listOf(raw, 'decisions', CAPS.decisions, (decision, field) => ({
    at: timeOrNull(decision.at, `${field}.at`),
    text: stringOrNull(decision.text, 2_000, `${field}.text`, { required: true, redact: true }),
    by: stringOrNull(decision.by, 64, `${field}.by`),
  }));
  record.agents = listOf(raw, 'agents', CAPS.agents, (agent, field) => ({
    at: timeOrNull(agent.at, `${field}.at`), kind: stringOrNull(agent.kind, 40, `${field}.kind`, { required: true }),
    sessionId: stringOrNull(agent.sessionId, 200, `${field}.sessionId`),
    paneId: stringOrNull(agent.paneId, 120, `${field}.paneId`, { required: true }),
  }));
  record.requirements = listOf(raw, 'requirements', CAPS.requirements, (requirement, field) => {
    if (!['mcp', 'permission'].includes(requirement.kind)) corrupt(`${field}.kind`);
    return { kind: requirement.kind, name: stringOrNull(requirement.name, 160, `${field}.name`, { required: true, redact: true }),
      lastAt: timeOrNull(requirement.lastAt, `${field}.lastAt`) };
  });
  record.handoffs = listOf(raw, 'handoffs', CAPS.handoffs, (handoff, field) => {
    if (!['started', 'completed', 'failed'].includes(handoff.status)) corrupt(`${field}.status`);
    return {
      id: stringOrNull(handoff.id, 128, `${field}.id`, { required: true }), at: timeOrNull(handoff.at, `${field}.at`),
      finishedAt: timeOrNull(handoff.finishedAt, `${field}.finishedAt`), status: handoff.status,
      from: endpoint(handoff.from, `${field}.from`), to: endpoint(handoff.to, `${field}.to`),
      paneId: stringOrNull(handoff.paneId, 120, `${field}.paneId`),
      error: stringOrNull(handoff.error, 1_000, `${field}.error`, { redact: true }), delivered: handoff.delivered === true,
    };
  });
  return record;
}

/** Importa snapshots antiguos sin perpetuar su mecanica no fiable. */
export function migrateRecord(raw, contextId, workspace = {}) {
  if (!raw || typeof raw !== 'object') return emptyRecord(contextId, workspace);
  if (raw.version === RECORD_VERSION) {
    return normalizeCurrentRecord(raw, contextId, workspace);
  }
  const next = emptyRecord(contextId, workspace);
  const safe = (s, max) => typeof s === 'string' ? redactSecrets(s).slice(0, max) : '';
  const oldList = (value) => Array.isArray(value) ? value : [];
  const oldTime = (value) => Number.isInteger(value) && value > 0 ? value : null;
  const oldBy = (value) => safe(value, 64) || null;
  const oldNarrative = (value) => {
    const text = safe(value?.text, 4_000);
    return text ? { text, at: oldTime(value?.at), by: oldBy(value?.by) } : null;
  };
  next.goal = oldNarrative(raw.goal);
  next.nextStep = oldNarrative(raw.nextStep);
  next.decisions = oldList(raw.decisions).slice(-CAPS.decisions).map((d) => ({
    at: oldTime(d?.at), text: safe(d?.text, 2_000), by: oldBy(d?.by),
  })).filter((d) => d.text);
  next.failures = oldList(raw.failures).slice(-CAPS.failures).map((f) => ({
    at: oldTime(f?.at), text: safe(f?.text, 1_000), sourceKey: safe(f?.sourceKey, 300) || null,
  })).filter((f) => f.text);
  next.turns = oldList(raw.turns).slice(-CAPS.turns).map((t) => ({
    at: oldTime(t?.at), role: t?.role, text: safe(t?.text, 8_000), sourceKey: safe(t?.sourceKey, 300) || null,
  })).filter((t) => t.text && ['humano', 'agente'].includes(t.role));
  next.requirements = oldList(raw.requirements).slice(-CAPS.requirements).map((r) => ({
    kind: r?.kind, name: safe(r?.name, 160), lastAt: oldTime(r?.lastAt),
  })).filter((r) => r.name && ['mcp', 'permission'].includes(r.kind));
  next.events = Number.isSafeInteger(raw.events) && raw.events >= 0 ? raw.events : 0;
  next.updatedAt = oldTime(raw.updatedAt);
  next.head = safe(raw.head, 80) || null;
  next.historyIncomplete = true;
  return next;
}

export { layerOf };
