// Dobles en memoria de los puertos: ejercitan casos de uso sin disco, git, sockets ni esperas.

export class FakeClock {
  constructor(start = 1_700_000_000_000) { this.t = start; }
  now() { return this.t; }
  advance(ms) { this.t += ms; return this.t; }
}

export class FakeIdGenerator {
  constructor(prefix = '00000000-0000-4000-8000-') { this.prefix = prefix; this.sequence = 0; }
  next() { this.sequence += 1; return `${this.prefix}${String(this.sequence).padStart(12, '0')}`; }
}

export class InMemoryContextRepository {
  constructor() { this.byId = new Map(); this.writes = 0; this.failOn = null; this.queues = new Map(); }
  breakOn(op) { this.failOn = op; return this; }
  #maybeFail(op) {
    if (this.failOn !== op) return;
    this.failOn = null;
    throw new Error(`almacenamiento caído en ${op}`);
  }
  async load(id) { this.#maybeFail('load'); return structuredClone(this.byId.get(id) ?? null); }
  update(id, options, mutate) {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      this.#maybeFail('update');
      const current = structuredClone(this.byId.get(id) ?? options.create());
      const next = await mutate(structuredClone(current));
      if (next == null) return current;
      this.writes += 1;
      this.byId.set(id, structuredClone(next));
      return structuredClone(next);
    });
    this.queues.set(id, run);
    return run.finally(() => { if (this.queues.get(id) === run) this.queues.delete(id); });
  }
}

export class FakeWorkspaceProbe {
  constructor(workspace = {}, commits = []) {
    this.workspace = {
      repoRoot: '/repo', branch: 'main', checkoutPath: '/repo', dirty: '', head: 'abc1234',
      files: [], fingerprint: 'clean-abc1234', ...workspace,
    };
    this.commits = commits;
    this.failOn = null;
    this.calls = { inspect: 0, commitsBetween: 0 };
  }
  breakOn(op) { this.failOn = op; return this; }
  #maybeFail(op) { if (this.failOn === op) { this.failOn = null; throw new Error(`git no responde en ${op}`); } }
  async inspect(cwd) {
    this.#maybeFail('inspect'); this.calls.inspect += 1;
    return structuredClone({ ...this.workspace, checkoutPath: this.workspace.checkoutPath ?? cwd });
  }
  async commitsBetween() {
    this.#maybeFail('commitsBetween'); this.calls.commitsBetween += 1;
    return structuredClone(this.commits);
  }
  setSnapshot(patch) {
    Object.assign(this.workspace, patch);
    if (!Object.hasOwn(patch, 'fingerprint')) {
      this.workspace.fingerprint = JSON.stringify([this.workspace.head, this.workspace.files.map((f) => [f.status, f.path])]);
    }
    this.workspace.dirty = this.workspace.files.map((f) => `${f.status || '??'} ${f.path}`).join('\n');
    return this;
  }
  setCommits(commits) { this.commits = commits; return this; }
}

export class FakeAgentRuntime {
  constructor({ pane = 'w1:p9' } = {}) {
    this.pane = pane;
    this.calls = [];
    this.failOn = null;
    this.paneOutput = 'objetivo: seguir\nhecho: nada\nsiguiente: esperar';
    this.closed = [];
  }
  breakOn(op, message = 'fallo simulado') { this.failOn = { op, message }; return this; }
  #record(op, args) { this.calls.push({ op, args }); }
  #maybeFail(op) {
    if (this.failOn?.op !== op) return;
    const { message } = this.failOn;
    this.failOn = null;
    throw new Error(message);
  }
  async splitPane(paneId, opts) { this.#record('splitPane', { paneId, opts }); this.#maybeFail('splitPane'); return this.pane; }
  async closePane(paneId) { this.#record('closePane', { paneId }); this.closed.push(paneId); this.#maybeFail('closePane'); }
  async startAgent(name, kind, paneId) { this.#record('startAgent', { name, kind, paneId }); this.#maybeFail('startAgent'); }
  async waitReady(name) { this.#record('waitReady', { name }); this.#maybeFail('waitReady'); }
  async prompt(name, text) { this.#record('prompt', { name, text }); this.#maybeFail('prompt'); }
  async readPane(paneId, lines) { this.#record('readPane', { paneId, lines }); this.#maybeFail('readPane'); return this.paneOutput; }
  get delivered() { return this.calls.find((call) => call.op === 'prompt')?.args.text ?? null; }
}

export class FakeEngineCatalog {
  constructor(kinds = ['claude', 'codex', 'opencode', 'pi', 'grok']) { this.kinds = new Set(kinds); }
  has(kind) { return this.kinds.has(kind); }
}

export class FakeAccountProfileCatalog {
  resolve(id, provider) {
    if (!['claude', 'codex'].includes(provider)) return null;
    const profileId = id || `${provider}-default`;
    return {
      id: profileId, provider, label: profileId, isDefault: !id,
      launchEnv: { LCARS_ACCOUNT_PROFILE: profileId },
    };
  }
}

export function fakeThreadSource(kind, thread, { throws = false } = {}) {
  return {
    kind,
    async read() {
      if (throws) throw new Error(`no se pudo leer el hilo de ${kind}`);
      return thread;
    },
  };
}

// Alias temporal para que una prueba externa que usara el nombre anterior siga teniendo un doble útil.
export const InMemoryRecordStore = InMemoryContextRepository;
