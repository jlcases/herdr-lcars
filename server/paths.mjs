// Identidad de rutas entre plataformas. En POSIX una ruta es tal cual; en Windows la misma carpeta
// llega escrita de varias formas (`C:/x`, `c:\X`, `\\?\C:\x`) según quién la emita: Herdr, git o el
// CLI del agente. Todo lo que compara rutas o las usa como clave pasa por aquí.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const nativeRealpath = promisify(fs.realpath.native);

const pathApi = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const stripNamespace = (value) => value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\[?.]\\/, '');

/** Forma canónica de escritura. En POSIX devuelve la ruta sin tocarla. */
export function normalizePath(value, platform = process.platform) {
  if (typeof value !== 'string' || !value || platform !== 'win32') return value;
  let out = path.win32.normalize(stripNamespace(value));
  if (/^[a-z]:/.test(out)) out = out[0].toUpperCase() + out.slice(1);
  const root = path.win32.parse(out).root;
  return out.length > root.length ? out.replace(/[\\/]+$/, '') : out;
}

/** Clave de comparación: en Windows el sistema de ficheros no distingue mayúsculas. */
export function pathKey(value, platform = process.platform) {
  const normalized = normalizePath(value, platform);
  return platform === 'win32' && typeof normalized === 'string' ? normalized.toLowerCase() : normalized;
}

/**
 * Formas en que otro programa puede haber guardado la misma carpeta, para usarlas en una consulta
 * exacta: OpenCode escribe `D:/dev/x` mientras Herdr informa `D:\dev\x`.
 */
export function pathVariants(value, platform = process.platform) {
  const normalized = normalizePath(value, platform);
  if (platform !== 'win32' || typeof normalized !== 'string') return [value];
  return [...new Set([value, normalized, normalized.replaceAll('\\', '/')])];
}

export const samePath =(a, b, platform = process.platform) => pathKey(a, platform) === pathKey(b, platform);

/** ¿`candidate` es `root` o cuelga de él? */
export function isInsidePath(root, candidate, platform = process.platform) {
  const base = pathKey(root, platform), target = pathKey(candidate, platform);
  if (typeof base !== 'string' || typeof target !== 'string') return false;
  if (target === base) return true;
  return target.startsWith(base.endsWith(pathApi(platform).sep) ? base : `${base}${pathApi(platform).sep}`);
}

/** `realpath` que en Windows devuelve también la capitalización real que guarda el disco. */
export async function realPath(value) {
  if (process.platform !== 'win32') return fsp.realpath(value);
  return normalizePath(await nativeRealpath(value), 'win32');
}
