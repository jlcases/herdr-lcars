// Relevo transaccional: memoria primero, efectos externos después, resultado siempre trazado.
import { makeEvent } from '../domain/events.mjs';
import { coverage, newTurns } from '../domain/record.mjs';
import { renderBrief, DEFAULT_BUDGET } from '../domain/brief.mjs';
import { agentNameFor } from '../domain/ids.mjs';
import { boundedText, cappedText, normalizedTextKey } from '../domain/text.mjs';
import { requirePort } from '../ports.mjs';

const REQUEST_ID = /^[a-z0-9][a-z0-9._:-]{7,127}$/i;
const statusError = (message, status = 502, details = {}) => Object.assign(new Error(message), { status, details });
const safeError = (error) => cappedText(error?.message || String(error), { max: 1_000, empty: false });
const PUBLIC_FAILURE = Object.freeze({
  start: 'No se pudo iniciar el motor de destino. Revisa el registro de Herdr.',
  delivery: 'No se pudo confirmar la entrega. Revisa el panel nuevo antes de repetirla.',
  acknowledgement: 'No se pudo leer el acuse del panel nuevo.',
});

export class HandOff {
  #active = new Set();
  #requests = new Map();

  /**
   * @param {{gateway: import('./contextGateway.mjs').ContextGateway,
   *          runtime: import('../ports.mjs').AgentRuntime,
   *          engines: import('../ports.mjs').EngineCatalog,
   *          profiles: import('../ports.mjs').AccountProfileCatalog,
   *          ids: import('../ports.mjs').IdGenerator,
   *          threads: import('../registry.mjs').ThreadSourceRegistry,
   *          log?: object}} deps
   */
  constructor({ gateway, runtime, engines, profiles, ids, threads, log = null }) {
    this.gateway = gateway;
    this.runtime = requirePort(runtime, 'AgentRuntime');
    this.engines = requirePort(engines, 'EngineCatalog');
    this.profiles = requirePort(profiles, 'AccountProfileCatalog');
    this.ids = requirePort(ids, 'IdGenerator');
    this.threads = threads;
    this.log = log;
  }

  async #enrich(resolved, fromKind, sessionId) {
    const source = this.threads?.get(fromKind);
    if (!source || !sessionId) return { ...resolved, enriched: false };
    let thread = null;
    try { thread = await source.read(sessionId); }
    catch (error) { this.log?.warn?.(`lector de ${fromKind}: ${error.message}`); }
    if (!thread) return { ...resolved, enriched: false };

    const at = this.gateway.now();
    const result = await this.gateway.commit(resolved, (current) => {
      const events = newTurns(current, Array.isArray(thread.turns) ? thread.turns : []).map((turn) => makeEvent('turn', at, {
        role: turn.role,
        text: cappedText(turn.text, { max: 8_000, empty: false }),
        sourceKey: cappedText(turn.sourceKey, { max: 300 }) || normalizedTextKey(turn.role, turn.text),
      }));
      const known = new Set(current.failures.map((failure) => failure.sourceKey || normalizedTextKey('failure', failure.text)));
      for (const raw of (Array.isArray(thread.failures) ? thread.failures : []).slice(-10)) {
        const item = typeof raw === 'string' ? { text: raw } : raw;
        if (!item || typeof item.text !== 'string') continue;
        const text = cappedText(item?.text, { max: 1_000, empty: false });
        const sourceKey = cappedText(item.sourceKey, { max: 300 }) || normalizedTextKey('failure', text);
        if (known.has(sourceKey)) continue;
        known.add(sourceKey);
        events.push(makeEvent('failure', at, { text, sourceKey }));
      }
      return events;
    });
    return { ...resolved, record: result.record, enriched: result.applied > 0 };
  }

  async #finish(resolved, id, fields) {
    try {
      const safeFields = { ...fields, error: fields.error ? cappedText(fields.error, { max: 1_000 }) : null };
      const result = await this.gateway.commit(resolved, [makeEvent('handoff_finished', this.gateway.now(), { id, ...safeFields })]);
      return { persisted: true, record: result.record };
    } catch (error) {
      this.log?.error?.(`no se pudo cerrar el relevo ${id} en memoria: ${error.message}`);
      return { persisted: false, record: resolved.record, error: error.message };
    }
  }

  async #execute({ resolved, agent, fromKind, toKind, profile, budget, requestId }) {
    const sourceSession = typeof agent.sessionId === 'string'
      ? cappedText(agent.sessionId, { max: 200 }) || null : null;
    const enriched = await this.#enrich(resolved, fromKind, sourceSession);
    const cov = coverage(enriched.record);
    if (!cov.handoffReady) {
      throw statusError('no hay memoria útil de este contexto todavía; anota el objetivo o deja que el agente produzca cambios', 409);
    }

    const startedAt = this.gateway.now();
    const from = {
      kind: fromKind,
      sessionId: sourceSession,
      paneId: boundedText(agent.paneId, { name: 'panel', max: 120 }),
    };
    const intended = { kind: toKind, profileId: profile?.id ?? null, profileLabel: profile?.label ?? null };
    const started = await this.gateway.commit(enriched, [makeEvent('handoff_started', startedAt, {
      id: requestId, from, to: intended, paneId: agent.paneId,
    })]);
    const tracked = { ...enriched, record: started.record };
    const brief = renderBrief(tracked.record, {
      fromKind, toKind, profileLabel: profile?.label, tree: resolved.workspace.dirty, budget,
    });

    let newPane = null;
    let name = null;
    let delivered = false;
    try {
      const pane = await this.runtime.splitPane(agent.paneId, {
        cwd: resolved.workspace.checkoutPath, direction: 'right', env: profile?.launchEnv || {},
      });
      if (!pane) throw new Error('el runtime no devolvió el panel nuevo');
      newPane = boundedText(String(pane), { name: 'panel nuevo', max: 120 });
      name = agentNameFor(resolved.workspace, toKind, profile?.id || '');
      await this.runtime.startAgent(name, toKind, newPane);
      await this.runtime.waitReady(name);
    } catch (error) {
      const message = safeError(error);
      this.log?.warn?.(`arranque del relevo a ${toKind}: ${message}`);
      if (newPane) await this.runtime.closePane(newPane).catch((closeError) => this.log?.warn?.(`cerrar panel ${newPane}: ${closeError.message}`));
      const finished = await this.#finish(tracked, requestId, {
        status: 'failed', delivered: false, to: { ...intended, paneId: newPane, name }, error: message,
      });
      throw statusError(PUBLIC_FAILURE.start, 502, {
        handoffId: requestId, paneId: newPane, memoryPersisted: finished.persisted,
      });
    }

    try {
      await this.runtime.prompt(name, brief.text);
      delivered = true;
    } catch (error) {
      const message = safeError(error);
      this.log?.warn?.(`entrega del relevo a ${toKind}: ${message}`);
      // La entrega puede haber llegado antes de que el transporte fallara. El panel queda visible
      // para que el usuario pueda comprobarlo; cerrarlo aquí podría destruir trabajo válido.
      const finished = await this.#finish(tracked, requestId, {
        status: 'failed', delivered: false, to: { ...intended, paneId: newPane, name }, error: message,
      });
      return {
        ok: false, error: PUBLIC_FAILURE.delivery,
        status: 502, handoffId: requestId, memoryPersisted: finished.persisted,
        context: { id: tracked.contextId, repoRoot: tracked.record.repoRoot, branch: tracked.record.branch, checkoutPath: tracked.record.checkoutPath },
        from, to: { ...intended, paneId: newPane, name }, coverage: cov,
        note: 'El panel nuevo queda abierto porque la entrega es ambigua. Compruébalo antes de cerrarlo.',
      };
    }

    let ack = null;
    let ackError = null;
    let ackDiagnostic = null;
    try { ack = boundedText((await this.runtime.readPane(newPane, 60) || '').slice(-1_200), { name: 'acuse', max: 1_200, empty: true }); }
    catch (error) {
      ackDiagnostic = safeError(error);
      ackError = PUBLIC_FAILURE.acknowledgement;
      this.log?.warn?.(`acuse del relevo a ${toKind}: ${ackDiagnostic}`);
    }

    const to = { ...intended, paneId: newPane, name };
    const finished = await this.#finish(tracked, requestId, { status: 'completed', delivered, to, error: ackDiagnostic });
    this.log?.info?.(`relevo ${fromKind} → ${toKind} en ${resolved.workspace.branch || resolved.workspace.checkoutPath}`);
    return {
      ok: true, handoffId: requestId, memoryPersisted: finished.persisted,
      context: { id: tracked.contextId, repoRoot: tracked.record.repoRoot, branch: tracked.record.branch, checkoutPath: tracked.record.checkoutPath },
      from, to, turns: brief.turns, files: brief.files, briefChars: brief.text.length,
      truncated: brief.truncated, coverage: cov, ack, ackError,
      note: 'El agente de origen sigue abierto. Ciérralo solo después de comprobar el relevo.',
    };
  }

  /**
   * @param {{agent: {agent: string, paneId: string, cwd: string, sessionId?: string|null},
   *          toKind: string, profileId?: string|null, budget?: number, requestId?: string}} input
   */
  async run({ agent, toKind, profileId = null, budget = DEFAULT_BUDGET, requestId }) {
    if (!agent?.cwd || !agent?.paneId || !agent?.agent) throw statusError('agente desconocido', 404);
    const destination = boundedText(toKind, { name: 'motor de destino', max: 40 });
    const fromKind = boundedText(agent.agent, { name: 'motor de origen', max: 40 });
    if (!this.engines.has(destination)) throw statusError(`motor no disponible: ${destination}`, 400);
    const profile = this.profiles.resolve(profileId, destination);
    if (fromKind === destination && (!profile || profile.id === agent.accountProfileId
      || (!agent.accountProfileId && profile.isDefault))) {
      throw statusError('ya está en ese motor y perfil de cuenta', 400);
    }
    requestId ??= this.ids.next();
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw statusError('request_id no válido', 400);

    const resolved = await this.gateway.resolve(agent.cwd);
    const existing = this.#requests.get(requestId);
    if (existing) {
      if (existing.contextId !== resolved.contextId) throw statusError('request_id ya pertenece a otro contexto', 409);
      return existing.promise;
    }
    if (this.#active.has(resolved.contextId)) throw statusError('ya hay un relevo en curso para este contexto', 409);

    this.#active.add(resolved.contextId);
    const operation = this.#execute({ resolved, agent, fromKind, toKind: destination, profile, budget, requestId })
      .finally(() => this.#active.delete(resolved.contextId));
    const entry = { contextId: resolved.contextId, promise: operation };
    while (this.#requests.size >= 1000) {
      const oldestId = this.#requests.keys().next().value;
      const oldest = this.#requests.get(oldestId);
      clearTimeout(oldest?.timer); this.#requests.delete(oldestId);
    }
    this.#requests.set(requestId, entry);
    const timer = setTimeout(() => { if (this.#requests.get(requestId) === entry) this.#requests.delete(requestId); }, 5 * 60_000);
    entry.timer = timer;
    timer.unref?.();
    return operation;
  }
}
