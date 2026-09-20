// Capa narrativa: lo que solo sabe quien está trabajando. Objetivo, decisiones, siguiente paso.
//
// Es opcional a propósito. El motor al que te pasas cuando se acaba la cuota suele ser el más
// flojo, así que la memoria no puede depender de que mantenga un diario con disciplina.
import { makeEvent } from '../domain/events.mjs';
import { boundedText } from '../domain/text.mjs';

const FIELDS = {
  goal: (at, text, by) => makeEvent('goal_set', at, { text, by }),
  nextStep: (at, text, by) => makeEvent('next_step', at, { text, by }),
  decision: (at, text, by) => makeEvent('decision', at, { text, by }),
};

export class Remember {
  /** @param {{gateway: import('./contextGateway.mjs').ContextGateway}} deps */
  constructor({ gateway }) { this.gateway = gateway; }

  /**
   * Anota memoria narrativa sobre el contexto de un directorio.
   * @param {{cwd: string, goal?: string, nextStep?: string, decision?: string, requires?: Array<{kind: string, name: string}>, by?: string}} input
   */
  async run({ cwd, by = null, requires = [], ...fields }) {
    if (!cwd) throw Object.assign(new Error('hace falta un directorio'), { status: 400 });
    const unknown = Object.keys(fields).filter((k) => !Object.hasOwn(FIELDS, k));
    if (unknown.length) throw Object.assign(new Error(`campos desconocidos: ${unknown.join(', ')}`), { status: 400 });

    if (!Array.isArray(requires) || requires.length > 30) {
      throw Object.assign(new Error('requires debe ser una lista de hasta 30 elementos'), { status: 400 });
    }
    const resolved = await this.gateway.resolve(cwd);
    const at = this.gateway.now();
    const events = [];
    const author = by == null ? null : boundedText(by, { field: 'by', max: 64 });
    for (const [key, build] of Object.entries(FIELDS)) {
      if (fields[key] === undefined) continue;
      events.push(build(at, boundedText(fields[key], { field: key, max: key === 'decision' ? 2_000 : 4_000 }), author));
    }
    for (const requirement of requires) {
      if (!requirement || typeof requirement !== 'object') {
        throw Object.assign(new Error('cada requisito debe ser un objeto'), { status: 400 });
      }
      events.push(makeEvent('requirement', at, {
        kind: boundedText(requirement.kind, { field: 'kind', max: 20 }),
        name: boundedText(requirement.name, { field: 'name', max: 160 }),
      }));
    }
    if (!events.length) throw Object.assign(new Error('no hay nada que recordar'), { status: 400 });

    return this.gateway.commit(resolved, events);
  }
}
