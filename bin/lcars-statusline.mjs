#!/usr/bin/env node
// Wrapper del statusline de Claude Code para LCARS for Herdr (sin `sh`, para Windows): guarda el JSON
// de la sesión y encadena el comando original, que llega como argumentos, para que la barra siga igual.
// Es el equivalente de bin/lcars-statusline. Nada de lo que falle aquí puede romper el statusline.
import { spawn } from 'node:child_process';
import { writeStatusDrop } from '../server/statusdrop.mjs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Ejecuta el comando encadenado con el mismo stdin y devuelve su código de salida. */
function chain(argv, input) {
  return new Promise((resolve) => {
    // Node ≥ 22 no lanza .cmd/.bat sin shell (p. ej. las shims de npx en Windows).
    const shell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(argv[0]);
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true, shell });
    child.on('error', (error) => { process.stderr.write(`lcars-statusline: ${error.message}\n`); resolve(127); });
    child.on('close', (code) => resolve(code ?? 1));
    child.stdin.on('error', () => {}); // el comando puede cerrar stdin sin leerlo
    child.stdin.end(input);
  });
}

const input = await readStdin();
await writeStatusDrop(input.toString('utf8'));
const argv = process.argv.slice(2);
process.exitCode = argv.length ? await chain(argv, input) : 0;
