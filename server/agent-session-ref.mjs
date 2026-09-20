import path from 'node:path';
import { isSafeSessionId } from './identifiers.mjs';

const MAX_SESSION_PATH = 4096;

const pathApi = (platform) => platform === 'win32' ? path.win32 : path.posix;

/**
 * Valida la referencia opaca que Herdr recibe de cada integración.
 *
 * Un id puede cruzar directamente al almacén de telemetría. Una ruta nunca se convierte aquí en
 * id: queda como dato privado para el adaptador del motor, que debe comprobar raíz, tipo y cabecera
 * antes de leerla. De este modo el servidor HTTP no publica rutas de sesiones por accidente.
 */
export function agentSessionRef(value, platform = process.platform) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.kind === 'id') {
    return isSafeSessionId(value.value) ? { kind: 'id', value: value.value } : null;
  }
  if (value.kind !== 'path' || typeof value.value !== 'string'
    || !value.value || value.value.length > MAX_SESSION_PATH || value.value.includes('\0')) return null;
  return pathApi(platform).isAbsolute(value.value) ? { kind: 'path', value: value.value } : null;
}
