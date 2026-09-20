import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// Constructores de cargas OTLP para las pruebas.
export const otlpLog = (name, attrs, ts = Date.now()) => ({
  resourceLogs: [{ resource: {}, scopeLogs: [{ logRecords: [{
    timeUnixNano: String(BigInt(ts) * 1000000n),
    attributes: Object.entries({ 'event.name': name, ...attrs }).map(([key, v]) => ({
      key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: String(v) },
    })),
  }] }] }],
});
export const apiRequest = (attrs) => otlpLog('api_request', attrs);

// Windows no expone permisos POSIX (`stat.mode` siempre dice 0o666) ni deja crear enlaces simbólicos
// sin privilegio, así que esas comprobaciones solo tienen sentido —y solo se exigen— en POSIX.
export const POSIX = process.platform !== 'win32';
export const expectMode = (stat, expected) => { if (POSIX) assert.equal(stat.mode & 0o777, expected); };
export const expectPrivate = (stat, message) => { if (POSIX) assert.equal(stat.mode & 0o077, 0, message); };
/** Crea el enlace o salta la prueba cuando el sistema no lo permite. Devuelve false si se saltó. */
export async function symlinkOrSkip(t, target, file) {
  try { await fsp.symlink(target, file); return true; }
  catch (error) { if (error.code !== 'EPERM') throw error; t.skip('el sistema no permite crear enlaces simbólicos'); return false; }
}

/** Los launchers POSIX (bin/plugin, bin/lcars-statusline) necesitan `sh`; en Windows solo existe con Git for Windows. */
export const HAS_SH = spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0;
export const NEEDS_SH = { skip: !HAS_SH && 'requiere sh' };
