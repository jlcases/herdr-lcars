// Registro de lectores de hilo. Añadir un motor es registrar un adaptador: ni el dominio ni los
// casos de uso cambian. Es opcional de arriba abajo, porque el traspaso ya no depende de ellos.
import { requirePort } from './ports.mjs';

export class ThreadSourceRegistry {
  constructor(sources = []) {
    this.byKind = new Map();
    for (const s of sources) this.register(s);
  }

  register(source) {
    if (!source?.kind) throw new TypeError('un lector de hilo necesita «kind»');
    requirePort(source, 'ThreadSource');
    this.byKind.set(source.kind, source);
    return this;
  }

  /** El lector de un motor, o null si ese motor no tiene lector. Null es normal, no un fallo. */
  get(kind) { return this.byKind.get(kind) ?? null; }
  kinds() { return [...this.byKind.keys()]; }
}
