// Capa mecánica de la memoria: lo que de verdad ha pasado en el árbol de trabajo.
//
// Se alimenta de git, no de las llamadas a herramientas del motor. Esa es la decisión de fondo:
// git ve los ficheros que cambian los ocho motores, incluidos los seis cuyo transcript no sé leer.
// Por eso la memoria deja de depender del formato de cada CLI.
import { makeEvent } from '../domain/events.mjs';
import { CAPS } from '../domain/record.mjs';
import { boundedText, cappedText } from '../domain/text.mjs';

export class IngestActivity {
  /** @param {{gateway: import('./contextGateway.mjs').ContextGateway}} deps */
  constructor({ gateway }) { this.gateway = gateway; }

  /**
   * Observa un contexto y pliega lo nuevo en su registro.
   * @param {{cwd: string, engineKind?: string|null, sessionId?: string|null, paneId?: string|null}} input
   * @returns {Promise<{contextId: string, record: object, applied: number}>}
   */
  async run({ cwd, engineKind = null, sessionId = null, paneId = null }) {
    if (!cwd) throw Object.assign(new Error('hace falta un directorio'), { status: 400 });
    const resolved = await this.gateway.resolve(cwd);
    const { workspace, record } = resolved;
    const at = this.gateway.now();
    const commits = record.head && workspace.head && record.head !== workspace.head
      ? await this.gateway.probe.commitsBetween(workspace.checkoutPath, record.head, workspace.head)
      : [];

    const result = await this.gateway.commit(resolved, (current) => {
      const events = [];
      for (const c of commits) {
        if (current.commits.some((known) => known.sha === c.sha)) continue;
        events.push(makeEvent('commit', at, {
          sha: boundedText(c.sha, { field: 'sha', max: 80 }),
          subject: cappedText(c.subject, { max: 500 }),
        }));
      }
      if (current.worktree.fingerprint !== workspace.fingerprint || current.head !== workspace.head) {
        events.push(makeEvent('worktree_observed', at, {
          files: workspace.files.slice(0, CAPS.files).map((file) => ({
            path: file.path,
            status: boundedText(file.status || '??', { field: 'estado', max: 8 }),
            previousPath: file.previousPath || null,
          })),
          totalFiles: workspace.files.length,
          fingerprint: workspace.fingerprint,
          head: workspace.head,
        }));
      }

      const kind = typeof engineKind === 'string' ? engineKind.trim().slice(0, 40) : '';
      const pane = typeof paneId === 'string' ? paneId.trim().slice(0, 120) : '';
      const session = typeof sessionId === 'string' ? sessionId.trim().slice(0, 200) : null;
      const knownAgent = current.agents.some((a) => a.kind === kind
        && (session ? a.sessionId === session : a.paneId === pane));
      if (kind && pane && !knownAgent) events.push(makeEvent('engine_seen', at, { kind, sessionId: session, paneId: pane }));
      return events;
    });
    return { contextId: resolved.contextId, ...result };
  }
}
