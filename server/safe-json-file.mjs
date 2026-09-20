import fsp from 'node:fs/promises';
import { constants } from 'node:fs';

/** Lee JSON local sin seguir enlaces simbolicos ni cargar accidentalmente ficheros enormes. */
export async function readJSONFile(file, {
  maxBytes = 4 * 1024 * 1024,
  requirePrivate = false,
  platform = process.platform,
} = {}) {
  const handle = await fsp.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(new Error('se esperaba un fichero regular'), { code: 'INVALID_FILE_TYPE' });
    // En POSIX el token no puede quedar legible por grupo u otros. Windows protege este fichero
    // mediante ACL y los bits POSIX que expone Node no describen esos permisos.
    if (requirePrivate && platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw Object.assign(new Error('el fichero de credenciales no es privado'), { code: 'INSECURE_PERMISSIONS' });
    }
    if (stat.size > maxBytes) throw Object.assign(new Error('fichero JSON demasiado grande'), { code: 'FILE_TOO_LARGE' });
    const data = await handle.readFile();
    if (data.length > maxBytes) throw Object.assign(new Error('fichero JSON demasiado grande'), { code: 'FILE_TOO_LARGE' });
    return JSON.parse(data.toString('utf8'));
  } finally { await handle.close(); }
}
