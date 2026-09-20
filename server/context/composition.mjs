// El único módulo que conoce adaptadores concretos. Todo lo demás depende de puertos.
//
// Cambiar de almacenamiento, de ejecutor o de lectores es cambiar esta función; ni el dominio ni
// los casos de uso se enteran, y por eso se pueden ejercitar enteros con dobles en memoria.
import path from 'node:path';
import os from 'node:os';
import { ContextGateway } from './usecases/contextGateway.mjs';
import { IngestActivity } from './usecases/ingestActivity.mjs';
import { Remember } from './usecases/remember.mjs';
import { DescribeContext } from './usecases/describeContext.mjs';
import { HandOff } from './usecases/handOff.mjs';
import { ThreadSourceRegistry } from './registry.mjs';
import { FileContextRepository } from './adapters/fileContextRepository.mjs';
import { GitWorkspaceProbe } from './adapters/gitWorkspaceProbe.mjs';
import { EngineCatalog } from './adapters/engineCatalog.mjs';
import { HerdrAgentRuntime } from './adapters/herdrAgentRuntime.mjs';
import { systemClock } from './adapters/systemClock.mjs';
import { systemIds } from './adapters/systemIds.mjs';
import { claudeThreadSource, codexThreadSource } from './adapters/threadSources.mjs';
import { AccountProfileCatalog } from '../account-profiles.mjs';

const STATE_HOME = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
export const DEFAULT_STATE_DIR = process.env.HERDR_LCARS_CONTEXT_DIR
  || path.join(STATE_HOME, 'herdr-lcars', 'contexts');

/**
 * Monta la memoria de contexto con sus adaptadores reales.
 * @param {{socketPath?: string, stateDir?: string, log?: object, engineKinds?: string[],
 * repository?: object, probe?: object, runtime?: object, profiles?: object, clock?: object, ids?: object, threadSources?: object[]}} opts
 */
export function buildContextMemory({
  socketPath = undefined,
  stateDir = DEFAULT_STATE_DIR,
  log = null,
  engineKinds = ['claude', 'codex', 'opencode'],
  repository = new FileContextRepository(stateDir),
  probe = new GitWorkspaceProbe(),
  runtime = new HerdrAgentRuntime({ socketPath }),
  profiles = new AccountProfileCatalog({ log }),
  clock = systemClock,
  ids = systemIds,
  threadSources = [claudeThreadSource, codexThreadSource],
} = {}) {
  const gateway = new ContextGateway({
    repository,
    probe,
    clock,
  });
  const threads = new ThreadSourceRegistry(threadSources);
  const engines = new EngineCatalog(engineKinds);
  return {
    gateway, engines,
    threads,
    ingest: new IngestActivity({ gateway }),
    remember: new Remember({ gateway }),
    describe: new DescribeContext({ gateway }),
    handOff: new HandOff({ gateway, runtime, engines, profiles, ids, threads, log }),
  };
}
