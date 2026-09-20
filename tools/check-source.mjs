#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const roots = ['bin', 'server', 'public', 'tests', 'tools'];
const files = [];

async function walk(dir) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (/\.(?:m?js)$/.test(entry.name)) files.push(target);
  }
}

for (const name of roots) await walk(path.join(root, name));
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

const manifest = await fsp.readFile(path.join(root, 'herdr-plugin.toml'), 'utf8');
for (const required of ['id = "dev.jlcases.herdr-lcars"', '[[startup]]', '[[actions]]', '[[panes]]']) {
  if (!manifest.includes(required)) throw new Error(`herdr-plugin.toml no contiene ${required}`);
}

const htmlFiles = ['index.html', 'msd.html'];
for (const name of htmlFiles) {
  const html = await fsp.readFile(path.join(root, 'public', name), 'utf8');
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) throw new Error(`${name} contiene JavaScript inline`);
}

console.log(`check: ${files.length} ficheros JavaScript, manifiesto y CSP compatibles`);
