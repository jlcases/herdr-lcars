import { requirePort } from '../ports.mjs';

const KIND = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

/** Catálogo mutable en el borde: el caso de uso solo conoce el puerto `has`. */
export class EngineCatalog {
  #kinds = new Set();

  constructor(kinds = []) { this.replace(kinds); }

  replace(kinds = []) {
    this.#kinds = new Set(kinds.filter((kind) => typeof kind === 'string' && KIND.test(kind)));
    return this;
  }

  has(kind) { return typeof kind === 'string' && this.#kinds.has(kind); }
  list() { return [...this.#kinds].sort(); }
}

// Hace fallar pronto cualquier cambio accidental del contrato.
requirePort(new EngineCatalog(), 'EngineCatalog');
