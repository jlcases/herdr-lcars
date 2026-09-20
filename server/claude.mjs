// Lo que hay que saber del formato en disco de Claude Code: dónde vive cada cosa y cómo leer una fila
// de transcript. El formato es interno y no documentado, así que todo lo que lo toca vive aquí.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mapLimit } from './concurrency.mjs';
import { isSafeSessionId } from './identifiers.mjs';

export const PROJECTS = process.env.LCARS_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
export const CACHE_HOME = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');

const INDEX_TTL_MS = 30_000;
const dirCache = new Map();

async function projectDirs(root) {
  const cached = dirCache.get(root);
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.names;
  let names;
  try { names = (await fsp.readdir(root)).slice(0, 5000); } catch { names = []; }
  dirCache.set(root, { names, at: Date.now() });
  if (dirCache.size > 64) dirCache.delete(dirCache.keys().next().value);
  return names;
}

const inside = (root, candidate) => candidate.startsWith(`${root}${path.sep}`);

/** Busca `<proyecto>/<sessionId><suffix>` con concurrencia acotada y sin seguir enlaces externos. */
async function findInProjects(sessionId, suffix, wantDir, roots = [PROJECTS]) {
  if (!isSafeSessionId(sessionId)) return null;
  const safeRoots = [...new Set((Array.isArray(roots) ? roots : [roots])
    .filter((root) => typeof root === 'string' && path.isAbsolute(root)).map((root) => path.resolve(root)))].slice(0, 32);
  for (const projects of safeRoots) {
    const names = await projectDirs(projects);
    let root;
    try { root = await fsp.realpath(projects); } catch { continue; }
    const hits = await mapLimit(names, 16, async (directory) => {
      const candidate = path.join(projects, directory, sessionId + suffix);
      try {
        const real = await fsp.realpath(candidate);
        if (!inside(root, real)) return null;
        return (await fsp.stat(real)).isDirectory() === wantDir ? real : null;
      } catch { return null; }
    });
    const hit = hits.find(Boolean);
    if (hit) return hit;
  }
  return null;
}

/** Transcript de la sesión: `<proyecto>/<sessionId>.jsonl` */
export const findSessionFile = (sessionId, roots) => findInProjects(sessionId, '.jsonl', false, roots);
/** Directorio de la sesión, con `subagents/` dentro: `<proyecto>/<sessionId>/` */
export const findSessionDir = (sessionId, roots) => findInProjects(sessionId, '', true, roots);

/** Lo que la telemetría necesita de una fila `assistant` del transcript. */
export function readAssistantRow(o) {
  const m = o.message;
  if (!m) return null;
  const tools = [];
  let text = '';
  for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b.type === 'tool_use' && b.name) tools.push([b.id, b.name]);
    else if (b.type === 'text' && b.text) text = b.text;
  }
  return {
    requestId: o.requestId || m.id || o.uuid,
    model: m.model, usage: m.usage || null, stopReason: m.stop_reason || null,
    tools, text, sidechain: !!o.isSidechain,
  };
}

/** ¿Es esta fila `user` una orden del usuario (y no el resultado de una herramienta)? */
export function isUserPrompt(o) {
  if (o.isMeta) return false;
  const c = o.message?.content;
  return typeof c === 'string' || (Array.isArray(c) && c.some((b) => b.type === 'text'));
}
