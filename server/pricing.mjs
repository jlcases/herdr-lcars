// Precios Anthropic API (USD por millón de tokens). Fuente: skill claude-api (caché 2026-06-24).
// Cache write 5m = 1.25× input, 1h = 2× input, cache read = 0.10× input, salvo Fable 5.1 (read $0.25/M).
const M = 1_000_000;
const base = (input, output, cacheRead = input * 0.1) => ({
  input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2,
});
export const PRICES = {
  'claude-fable-5-1': base(10, 50, 0.25),
  'claude-mythos-5-1': base(10, 50, 0.25),
  'claude-fable-5': base(10, 50),
  'claude-opus-5': base(5, 25),
  'claude-opus-4-8': base(5, 25),
  'claude-opus-4-7': base(5, 25),
  'claude-opus-4-6': base(5, 25),
  'claude-sonnet-5': base(2, 10),
  'claude-sonnet-4-6': base(3, 15),
  'claude-haiku-4-5': base(1, 5),
};
const ALIASES = [
  [/^claude-haiku-4-5/, 'claude-haiku-4-5'],
  [/^opus(\[1m\])?$/, 'claude-opus-5'],
  [/^sonnet(\[1m\])?$/, 'claude-sonnet-5'],
  [/^fable$/, 'claude-fable-5-1'],
];
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// Otros proveedores (OpenAI, Kimi, Gemini, DeepSeek…): tabla derivada de CASIA, con comodines en los alias.
const EXTRA = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'pricing-extra.json'), 'utf8')).models;
const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
const EXTRA_INDEX = EXTRA.map((m) => ({ ...m, res: [m.model, ...(m.aliases || [])].map(globToRe) }));
function extraPrice(model) {
  const bare = model.replace(/^.*\//, ''); // "accounts/fireworks/routers/kimi-k2p7-code-fast" → último tramo
  for (const m of EXTRA_INDEX) if (m.res.some((re) => re.test(model) || re.test(bare))) return { input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite5m: m.cacheWrite, cacheWrite1h: m.cacheWrite };
  return null;
}

export function priceFor(model) {
  if (!model || model === '<synthetic>') return null;
  if (!/claude|opus|sonnet|haiku|fable|mythos/.test(model)) { const e = extraPrice(model); if (e) return e; }
  if (PRICES[model]) return PRICES[model];
  const clean = model.replace(/\[1m\]$/, '');
  if (PRICES[clean]) return PRICES[clean];
  for (const [re, id] of ALIASES) if (re.test(model)) return PRICES[id];
  // Fallback por familia
  if (/fable|mythos/.test(model)) return PRICES['claude-fable-5-1'];
  if (/opus/.test(model)) return PRICES['claude-opus-5'];
  if (/sonnet/.test(model)) return PRICES['claude-sonnet-5'];
  if (/haiku/.test(model)) return PRICES['claude-haiku-4-5'];
  return null;
}
/** Coste en USD de un bloque `usage` de la API. Devuelve null si el modelo es desconocido. */
export function costOf(model, usage) {
  const p = priceFor(model);
  if (!p || !usage) return null;
  const c5 = usage.cache_creation?.ephemeral_5m_input_tokens;
  const c1 = usage.cache_creation?.ephemeral_1h_input_tokens;
  const creation = usage.cache_creation_input_tokens || 0;
  // Si no hay desglose 5m/1h, asumimos 5m (el más barato) para no inflar.
  const w5 = c5 ?? (c1 == null ? creation : 0);
  const w1 = c1 ?? 0;
  return (
    (usage.input_tokens || 0) * p.input +
    (usage.output_tokens || 0) * p.output +
    (usage.cache_read_input_tokens || 0) * p.cacheRead +
    w5 * p.cacheWrite5m + w1 * p.cacheWrite1h
  ) / M;
}
