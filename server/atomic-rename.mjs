// `rename` que sustituye un destino existente. En POSIX es atómico y no falla por estar el destino
// abierto; en Windows devuelve EPERM/EBUSY/EACCES mientras otro proceso (un lector, el antivirus,
// el indexador) tiene el fichero abierto, y el fallo es transitorio. Solo allí se reintenta.
import fsp from 'node:fs/promises';

const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function renameReplace(from, to, {
  platform = process.platform,
  rename = fsp.rename,
  attempts = 8,
  delayMs = 15,
} = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) {
      if (platform !== 'win32' || !TRANSIENT.has(error?.code) || attempt >= attempts) throw error;
      await wait(delayMs * attempt);
    }
  }
}
