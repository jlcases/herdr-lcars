// Identidad de un contexto de trabajo. Puro: sin disco, sin red, sin reloj.
//
// Un agente no es un CLI, es una carpeta con trabajo a medias en una rama. Esa tripleta es lo que
// persiste cuando el motor cambia, así que es lo que identifica el contexto. El motor es un atributo.

import { stableToken } from './text.mjs';

/** @typedef {{ repoRoot: string|null, branch: string|null, checkoutPath: string }} Workspace */

/**
 * Identificador estable de un contexto de trabajo.
 * Fuera de un repositorio no hay rama que valga, así que la ruta del checkout es la identidad.
 * @param {Workspace} ws
 * @returns {string}
 */
export function contextIdOf(ws) {
  if (!ws || typeof ws.checkoutPath !== 'string' || !ws.checkoutPath) {
    throw new TypeError('un contexto necesita al menos la ruta del checkout');
  }
  return `ctx:v2:${JSON.stringify([ws.repoRoot ?? null, ws.branch ?? null, ws.checkoutPath])}`;
}

/** Identificadores que usaron versiones anteriores; solo sirven para importar sin perder memoria. */
export function legacyContextIds(ws) {
  if (!ws?.checkoutPath) return [];
  const ids = [ws.checkoutPath];
  if (ws.repoRoot && ws.branch) ids.unshift(`${ws.repoRoot}#${ws.branch}`);
  return [...new Set(ids)];
}

/** Nombre de agente que Herdr aceptará para este contexto y motor. */
export function agentNameFor(ws, kind, discriminator = '') {
  const branch = (ws?.branch || 'wip').replace(/[^a-z0-9_-]/gi, '-').toLowerCase().slice(0, 10) || 'wip';
  const engine = String(kind || 'agent').replace(/[^a-z0-9_-]/gi, '-').toLowerCase().slice(0, 8) || 'agent';
  const identity = contextIdOf(ws);
  const token = stableToken(discriminator ? `${identity}\0${discriminator}` : identity).slice(-8);
  return `ctx-${branch}-${engine}-${token}`.slice(0, 32);
}
