// Snapshot Git exacto y acotado. El formato -z conserva cualquier nombre de fichero valido.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { stableToken } from '../domain/text.mjs';
import { isInsidePath, normalizePath, realPath } from '../../paths.mjs';

function runGit(args, cwd, { timeout = 8_000 } = {}) {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, timeout, maxBuffer: 8 << 20, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout);
    const failure = new Error(`git ${args[0]} fallo${stderr?.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}`);
    failure.code = error.code; failure.cause = error; reject(failure);
  }));
}

const entryPath = (entry, count) => entry.split(' ').slice(count).join(' ');

export function parsePorcelainV2(text) {
  const records = String(text).split('\0');
  const files = [];
  let branch = null, head = null;
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row) continue;
    if (row.startsWith('# branch.oid ')) { head = row.slice(13) === '(initial)' ? null : row.slice(13); continue; }
    if (row.startsWith('# branch.head ')) { branch = row.slice(14); if (branch === '(detached)') branch = 'HEAD'; continue; }
    if (row.startsWith('1 ')) { files.push({ status: row.slice(2, 4), path: entryPath(row, 8) }); continue; }
    if (row.startsWith('2 ')) {
      files.push({ status: row.slice(2, 4), path: entryPath(row, 9), previousPath: records[++i] ?? null });
      continue;
    }
    if (row.startsWith('u ')) { files.push({ status: row.slice(2, 4), path: entryPath(row, 10) }); continue; }
    if (row.startsWith('? ')) files.push({ status: '??', path: row.slice(2) });
  }
  return { branch, head, files: files.filter((f) => f.path) };
}

export class GitWorkspaceProbe {
  #locations = new Map();

  async #location(cwd) {
    let real;
    try { real = await realPath(cwd); } catch { throw Object.assign(new Error('el directorio no existe'), { status: 400 }); }
    const cached = this.#locations.get(real);
    if (cached) return cached;
    for (const known of new Set(this.#locations.values())) {
      if (isInsidePath(known.checkoutPath, real)) {
        this.#locations.set(real, known);
        return known;
      }
    }
    try {
      const out = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], real);
      // git escribe `C:/repo` en Windows; el resto del sistema maneja `C:\repo`.
      const [commonDir, checkoutPath] = out.split(/\r?\n/).filter(Boolean).map((line) => normalizePath(line));
      const repoRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
      const location = { repoRoot, checkoutPath };
      this.#locations.set(real, location); this.#locations.set(checkoutPath, location);
      return location;
    } catch (error) {
      if (error.code === 128 || String(error.message).includes('not a git repository')) return { repoRoot: null, checkoutPath: real };
      throw error;
    }
  }

  async inspect(cwd) {
    const location = await this.#location(cwd);
    if (!location.repoRoot) return { ...location, branch: null, head: null, files: [], fingerprint: stableToken(`plain:${location.checkoutPath}`), dirty: '' };
    const parsed = parsePorcelainV2(await runGit(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], location.checkoutPath));
    const fingerprint = stableToken(JSON.stringify([parsed.head, parsed.files.map((f) => [f.status, f.path, f.previousPath ?? null])]));
    const dirty = parsed.files.map((f) => `${f.status} ${f.previousPath ? `${f.previousPath} -> ` : ''}${f.path}`).join('\n');
    return { ...location, branch: parsed.branch, head: parsed.head, files: parsed.files, fingerprint, dirty };
  }

  async commitsBetween(checkoutPath, from, to) {
    if (!from || !to || from === to) return [];
    let out;
    try { out = await runGit(['log', '--reverse', '--max-count=50', '--format=%H%x00%s', '-z', `${from}..${to}`, '--'], checkoutPath); }
    catch { out = await runGit(['log', '-1', '--format=%H%x00%s', '-z', to, '--'], checkoutPath); }
    const fields = out.split('\0').filter(Boolean);
    const commits = [];
    for (let i = 0; i < fields.length; i += 2) commits.push({ sha: fields[i], subject: fields[i + 1] ?? '' });
    return commits;
  }
}
