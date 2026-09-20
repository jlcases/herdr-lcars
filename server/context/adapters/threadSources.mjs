// Lectores nativos opcionales. Solo leen una cola acotada y producen elementos con identidad estable.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PROJECTS, findSessionFile, readAssistantRow, isUserPrompt } from '../../claude.mjs';
import { requireSafeSessionId } from '../../identifiers.mjs';

const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_TURNS = 80;
const MAX_FAILURES = 30;
const codexFiles = new Map();

const pushTail = (list, value, max) => {
  list.push(value);
  if (list.length > max) list.splice(0, list.length - max);
};

async function eachTailObject(file, onObject) {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
    const length = stat.size - start;
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, start);
    let skipped = 0;
    if (start > 0) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      skipped = newline + 1;
    }
    const text = buffer.subarray(skipped).toString('utf8');
    let byteOffset = start + skipped;
    for (const line of text.split('\n')) {
      const sourceKey = `${path.basename(file)}:${byteOffset}`;
      byteOffset += Buffer.byteLength(line) + 1;
      if (!line) continue;
      let object;
      try { object = JSON.parse(line); } catch { continue; }
      await onObject(object, object.uuid || object.id || sourceKey);
    }
  } finally { await handle.close(); }
}

async function findCodexSession(roots, sessionId) {
  const safeRoots = [...new Set((Array.isArray(roots) ? roots : [roots])
    .filter((root) => typeof root === 'string' && path.isAbsolute(root)).map((root) => path.resolve(root)))].slice(0, 32);
  const cacheKey = `${safeRoots.join('\0')}\0${sessionId}`;
  const cached = codexFiles.get(cacheKey);
  if (cached) {
    try { if ((await fsp.lstat(cached)).isFile()) return cached; } catch { /* se redescubre */ }
    codexFiles.delete(cacheKey);
  }
  const suffix = `${sessionId}.jsonl`;
  const queue = safeRoots.map((dir) => ({ dir, depth: 0 }));
  let visited = 0;
  while (queue.length && visited++ < 5000) {
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = (await fsp.readdir(dir, { withFileTypes: true })).slice(0, 5000); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(suffix)) {
        codexFiles.set(cacheKey, full);
        if (codexFiles.size > 1000) codexFiles.delete(codexFiles.keys().next().value);
        return full;
      }
      if (entry.isDirectory() && depth < 4) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return null;
}

export const createClaudeThreadSource = ({ roots = () => [PROJECTS] } = {}) => ({
  kind: 'claude',
  async read(rawSessionId) {
    const sessionId = requireSafeSessionId(rawSessionId);
    const file = await findSessionFile(sessionId, typeof roots === 'function' ? roots() : roots);
    if (!file) return null;
    const turns = [], failures = [];
    await eachTailObject(file, (object, sourceKey) => {
      if (object.isSidechain) return;
      if (object.type === 'user') {
        if (isUserPrompt(object)) {
          const content = object.message.content;
          const text = typeof content === 'string' ? content
            : Array.isArray(content) ? content.filter((block) => block.type === 'text').map((block) => block.text).join('\n') : '';
          if (text) pushTail(turns, { role: 'humano', text, sourceKey }, MAX_TURNS);
        } else if (Array.isArray(object.message?.content)) {
          for (const block of object.message.content) {
            if (block.type === 'tool_result' && block.is_error) {
              pushTail(failures, { text: String(block.content), sourceKey: `${sourceKey}:tool` }, MAX_FAILURES);
            }
          }
        }
        return;
      }
      if (object.type !== 'assistant') return;
      const row = readAssistantRow(object);
      if (row?.text) pushTail(turns, { role: 'agente', text: row.text, sourceKey }, MAX_TURNS);
    });
    return { turns, failures, source: file };
  },
});

export const createCodexThreadSource = ({ roots = () => [process.env.LCARS_CODEX_SESSIONS || path.join(os.homedir(), '.codex', 'sessions')] } = {}) => ({
  kind: 'codex',
  async read(rawSessionId) {
    const sessionId = requireSafeSessionId(rawSessionId);
    const file = await findCodexSession(typeof roots === 'function' ? roots() : roots, sessionId);
    if (!file) return null;
    const turns = [], failures = [];
    await eachTailObject(file, (object, sourceKey) => {
      const payload = object.payload || {};
      if (object.type === 'response_item' && payload.type === 'message') {
        const text = (payload.content || []).map((content) => content.text || '').join('\n').trim();
        if (text) pushTail(turns, { role: payload.role === 'user' ? 'humano' : 'agente', text, sourceKey }, MAX_TURNS);
      } else if (object.type === 'event_msg' && payload.type === 'item_completed' && payload.item?.status === 'failed') {
        pushTail(failures, { text: `${payload.item.type || 'herramienta'} falló`, sourceKey }, MAX_FAILURES);
      }
    });
    return { turns, failures, source: file };
  },
});

export const claudeThreadSource = createClaudeThreadSource();
export const codexThreadSource = createCodexThreadSource();
