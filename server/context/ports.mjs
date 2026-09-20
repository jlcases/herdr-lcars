// Puertos: lo que el dominio necesita del mundo, expresado como contratos y nada más.
//
// Ni el dominio ni los casos de uso importan `node:fs`, `node:child_process` ni el socket de Herdr.
// Reciben estos puertos ya construidos, lo que permite ejercitarlos enteros con dobles en memoria.

/** @typedef {{ now(): number }} Clock */
/** @typedef {{ next(): string }} IdGenerator */

/**
 * @typedef {object} ContextRepository
 * @property {(contextId: string, options?: object) => Promise<object|null>} load
 * @property {(contextId: string, options: object, mutate: (record: object) => object|null|Promise<object|null>) => Promise<object>} update
 */

/**
 * @typedef {object} WorkspaceProbe
 * @property {(cwd: string) => Promise<{repoRoot: string|null, branch: string|null, checkoutPath: string, dirty: string, head: string|null, fingerprint: string, files: Array<{path: string, status: string}>}>} inspect
 * @property {(checkoutPath: string, from: string, to: string) => Promise<Array<{sha: string, subject: string}>>} commitsBetween
 */

/**
 * Lector del hilo nativo de un motor. OPCIONAL por diseño: el traspaso funciona sin ninguno.
 * @typedef {object} ThreadSource
 * @property {string} kind
 * @property {(sessionId: string) => Promise<{turns: Array<{role: string, text: string}>, failures: string[]}|null>} read
 */

/**
 * @typedef {object} AgentRuntime
 * @property {(paneId: string, opts: object) => Promise<string>} splitPane devuelve el id del panel nuevo
 * @property {(paneId: string) => Promise<void>} closePane
 * @property {(name: string, kind: string, paneId: string) => Promise<void>} startAgent
 * @property {(name: string) => Promise<void>} waitReady
 * @property {(name: string, text: string) => Promise<void>} prompt
 * @property {(paneId: string, lines: number) => Promise<string>} readPane
 */

/**
 * Catálogo de perfiles no secretos. Convierte un id validado en el entorno de lanzamiento.
 * @typedef {object} AccountProfileCatalog
 * @property {(id: string|null, provider: string) => object|null} resolve
 */

/**
 * Catálogo de motores que el runtime ha confirmado como disponibles.
 * @typedef {object} EngineCatalog
 * @property {(kind: string) => boolean} has
 */

/** Los métodos que exige cada puerto. Un puerto incompleto falla al componer, no en producción. */
export const CONTRACTS = {
  Clock: ['now'],
  IdGenerator: ['next'],
  ContextRepository: ['load', 'update'],
  WorkspaceProbe: ['inspect', 'commitsBetween'],
  ThreadSource: ['read'],
  AgentRuntime: ['splitPane', 'closePane', 'startAgent', 'waitReady', 'prompt', 'readPane'],
  EngineCatalog: ['has'],
  AccountProfileCatalog: ['resolve'],
};

/**
 * Comprueba que un adaptador cumple el contrato de su puerto.
 * @throws {TypeError} nombrando el puerto y los métodos que faltan.
 */
export function requirePort(port, name) {
  const contract = CONTRACTS[name];
  if (!contract) throw new TypeError(`puerto desconocido: ${name}`);
  if (!port || typeof port !== 'object') throw new TypeError(`${name}: falta el adaptador`);
  const missing = contract.filter((m) => typeof port[m] !== 'function');
  if (missing.length) throw new TypeError(`${name}: al adaptador le faltan métodos: ${missing.join(', ')}`);
  return port;
}
