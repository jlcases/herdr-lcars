// Límites de uso (ventanas 5h / 7d) que el statusline de Claude Code deja cacheados
// vía tmux-agent-indicator en ~/.cache/tmux-agent-indicator/claude-limits.json.
import path from 'node:path';
import { CACHE_HOME } from './claude.mjs';
import { readJSONFile } from './safe-json-file.mjs';

const FILE = process.env.TMUX_AGENT_LIMITS_CACHE_DIR
  ? path.join(process.env.TMUX_AGENT_LIMITS_CACHE_DIR, 'claude-limits.json')
  : path.join(CACHE_HOME, 'tmux-agent-indicator', 'claude-limits.json');

export async function readLimits() {
  try {
    const raw = await readJSONFile(FILE, { maxBytes: 1024 * 1024 });
    return {
      fetchedAt: Number.isFinite(Number(raw.fetched_at)) ? Number(raw.fetched_at) * 1000 : 0,
      windows: (Array.isArray(raw.windows) ? raw.windows : []).slice(0, 20).map((w) => ({
        minutes: Number.isFinite(Number(w?.window_minutes)) ? Math.max(0, Math.min(100_000, Number(w.window_minutes))) : null,
        usedPercent: Number.isFinite(Number(w?.used_percent)) ? Math.max(0, Math.min(100, Number(w.used_percent))) : null,
        resetsAt: Number.isFinite(Number(w?.resets_at)) ? Math.max(0, Math.min(1e12, Number(w.resets_at))) * 1000 : 0,
      })),
    };
  } catch { return null; }
}
