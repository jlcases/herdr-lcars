// Seguimiento incremental de ficheros JSONL que otro proceso va escribiendo.
//
// Lo delicado es la última línea: mientras el escritor está a medias, leerla y parsearla daría basura,
// así que solo se consume si parsea entera; si no, el offset retrocede hasta su principio para
// releerla completa en la siguiente pasada. Esto estaba copiado en tres seguidores distintos.
import { constants } from 'node:fs';
import fsp from 'node:fs/promises';

const MAX_READ_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const SCAN_BUFFER_BYTES = 64 * 1024;

async function openRegularNoFollow(file) {
  // Windows no expone O_NOFOLLOW. Sus ACL protegen el perfil, pero aun así rechazamos el último
  // componente si ya es un enlace. POSIX hace la comprobación atómica al abrir.
  if (!constants.O_NOFOLLOW && (await fsp.lstat(file)).isSymbolicLink()) {
    throw Object.assign(new Error('no se siguen enlaces simbólicos'), { code: 'ELOOP' });
  }
  const handle = await fsp.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const stat = await handle.stat();
  if (!stat.isFile()) {
    await handle.close();
    throw Object.assign(new Error('se esperaba un fichero regular'), { code: 'INVALID_FILE_TYPE' });
  }
  return { handle, stat };
}

/** Primera línea de un fichero, sin leerlo entero (las cabeceras de sesión pueden ocupar decenas de KB). */
export async function firstLine(file, maxBytes = 512 * 1024) {
  const { handle, stat } = await openRegularNoFollow(file);
  try {
    const length = Math.min(Math.max(0, maxBytes), stat.size);
    if (!length) return '';
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    const newline = bytes.indexOf(0x0a);
    const line = newline === -1 ? bytes : bytes.subarray(0, newline);
    return (line.at(-1) === 0x0d ? line.subarray(0, line.length - 1) : line).toString('utf8');
  } finally { await handle.close(); }
}

/**
 * Lee lo añadido desde `offset` y llama a `onObject` con cada registro completo.
 * Devuelve { offset, changed, mtimeMs }. Lanza si el fichero desapareció.
 */
export async function tailJsonl(file, offset, onObject) {
  const opened = await openRegularNoFollow(file);
  const { handle } = opened;
  try {
    const st = opened.stat;
    if (st.size < offset) offset = 0; // truncado o reescrito desde cero
    if (st.size === offset) return { offset, changed: false, mtimeMs: st.mtimeMs };

    const start = offset;
    const length = Math.min(MAX_READ_BYTES, st.size - start);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    if (!bytesRead) return { offset, changed: false, mtimeMs: st.mtimeMs };
    const bytes = buffer.subarray(0, bytesRead);
    let cursor = 0, consumed = 0;

    const emit = (line) => {
      if (!line.length || line.length > MAX_LINE_BYTES) return;
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
      if (!line.length) return;
      try { onObject(JSON.parse(line.toString('utf8'))); } catch { /* linea ilegible: se ignora */ }
    };

    for (let newline = bytes.indexOf(0x0a, cursor); newline !== -1; newline = bytes.indexOf(0x0a, cursor)) {
      emit(bytes.subarray(cursor, newline));
      cursor = newline + 1;
      consumed = cursor;
    }

    const atEnd = start + bytesRead >= st.size;
    const remainder = bytes.subarray(cursor);
    if (atEnd && remainder.length) {
      try {
        const line = remainder.at(-1) === 0x0d ? remainder.subarray(0, remainder.length - 1) : remainder;
        if (line.length > MAX_LINE_BYTES) consumed = bytesRead;
        else { onObject(JSON.parse(line.toString('utf8'))); consumed = bytesRead; }
      } catch { /* linea final a medio escribir: se relee desde su inicio */ }
    } else if (!atEnd && remainder.length > MAX_LINE_BYTES) {
      // Una sola fila gigantesca no puede bloquear para siempre el seguidor. Se busca su salto de
      // linea con memoria constante; si no aparece pronto, se descarta hasta el EOF observado.
      let position = start + cursor + remainder.length;
      const scan = Buffer.allocUnsafe(SCAN_BUFFER_BYTES);
      const scanLimit = Math.min(st.size, position + MAX_READ_BYTES);
      let found = false;
      while (position < scanLimit) {
        const wanted = Math.min(scan.length, scanLimit - position);
        const next = await handle.read(scan, 0, wanted, position);
        if (!next.bytesRead) break;
        const newline = scan.subarray(0, next.bytesRead).indexOf(0x0a);
        if (newline !== -1) { consumed = position + newline + 1 - start; found = true; break; }
        position += next.bytesRead;
      }
      if (!found) consumed = st.size - start;
    }

    return { offset: start + consumed, changed: true, mtimeMs: st.mtimeMs };
  } finally { await handle.close(); }
}
