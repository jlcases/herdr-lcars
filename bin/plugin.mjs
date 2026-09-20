#!/usr/bin/env node
// Punto de entrada del plugin donde no hay `sh` (Windows). En macOS y Linux Herdr sigue usando bin/plugin.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Launcher, LauncherError } from '../server/launcher.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [command = 'open', argument] = process.argv.slice(2);
const USAGE = 'uso: plugin {start|stop|restart|open [deck]|fuel|fuel-pane|accounts|ping}';

try {
  if (!['start', 'stop', 'restart', 'open', 'fuel', 'fuel-pane', 'accounts', 'ping'].includes(command)) throw new LauncherError(USAGE, 2);
  const launcher = await new Launcher({ root }).init();
  switch (command) {
    case 'start': await launcher.start(); break;
    case 'stop': await launcher.stop(); break;
    case 'restart': await launcher.restart(); break;
    case 'open': await launcher.open(argument); break;
    case 'accounts': launcher.openTarget(launcher.layout.profilesFile); break;
    case 'ping': console.log(await launcher.ping()); break;
    case 'fuel': process.exitCode = await launcher.fuel(); break;
    case 'fuel-pane': process.exitCode = await launcher.fuelPane(); break;
  }
} catch (error) {
  console.error(error?.message || error);
  process.exitCode = error instanceof LauncherError ? error.status : 1;
}
