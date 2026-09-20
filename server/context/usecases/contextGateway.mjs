// Colaborador común de los casos de uso: traduce un directorio en un contexto con su registro, y
// confirma eventos sobre él. Existe para que los cuatro casos de uso no repitan la misma danza.
import { contextIdOf, legacyContextIds } from '../domain/ids.mjs';
import { emptyRecord, applyAll } from '../domain/record.mjs';
import { requirePort } from '../ports.mjs';

export class ContextGateway {
  /** @param {{repository: import('../ports.mjs').ContextRepository, probe: import('../ports.mjs').WorkspaceProbe, clock: import('../ports.mjs').Clock}} deps */
  constructor({ repository, probe, clock }) {
    this.repository = requirePort(repository, 'ContextRepository');
    this.probe = requirePort(probe, 'WorkspaceProbe');
    this.clock = requirePort(clock, 'Clock');
  }

  /**
   * Contexto de un directorio con su registro. Si nunca se ha visto, devuelve uno vacío en vez de
   * null: no saber nada de un contexto es un estado legítimo, no un error.
   */
  async resolve(cwd) {
    const workspace = await this.probe.inspect(cwd);
    const contextId = contextIdOf(workspace);
    const aliases = legacyContextIds(workspace);
    const stored = await this.repository.load(contextId, { aliases, workspace });
    // El workspace manda sobre lo guardado: la rama puede haber cambiado desde la última vez.
    const record = stored
      ? { ...stored, repoRoot: workspace.repoRoot, branch: workspace.branch, checkoutPath: workspace.checkoutPath }
      : emptyRecord(contextId, workspace);
    return { workspace, contextId, aliases, record, isNew: !stored };
  }

  /**
   * Pliega sobre la última revisión, dentro del bloqueo del repositorio. `decide` se vuelve a
   * evaluar ahí: dos observadores simultáneos no pueden perder ni duplicar hechos.
   */
  async commit(resolved, decide) {
    let applied = 0;
    const record = await this.repository.update(resolved.contextId, {
      aliases: resolved.aliases,
      workspace: resolved.workspace,
      create: () => emptyRecord(resolved.contextId, resolved.workspace),
    }, (current) => {
      const aligned = {
        ...current,
        repoRoot: resolved.workspace.repoRoot,
        branch: resolved.workspace.branch,
        checkoutPath: resolved.workspace.checkoutPath,
      };
      const events = typeof decide === 'function' ? decide(aligned) : decide;
      if (!Array.isArray(events)) throw new TypeError('la transaccion de contexto debe devolver eventos');
      applied = events.length;
      const moved = current.repoRoot !== aligned.repoRoot || current.branch !== aligned.branch || current.checkoutPath !== aligned.checkoutPath;
      return events.length ? applyAll(aligned, events) : moved ? aligned : null;
    });
    return { record, applied };
  }

  now() { return this.clock.now(); }
}
