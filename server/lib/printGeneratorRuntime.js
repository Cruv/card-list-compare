import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCM_REPOSITORY = 'https://github.com/Alan-Cha/silhouette-card-maker.git';
export const PRINT_WORKER = fileURLToPath(new URL('./printGeneratorWorker.py', import.meta.url));
const MERGE_REQUIREMENTS = fileURLToPath(new URL('./printGeneratorRequirements.txt', import.meta.url));
const REQUIRED_PACKAGES = ['click', 'filetype', 'matplotlib', 'natsort', 'numpy', 'pillow', 'pydantic'];
const COMPATIBILITY_PROBE = 'import json,platform,sys,sysconfig; print(json.dumps([sys.version,sys.implementation.cache_tag,sysconfig.get_config_var("SOABI"),platform.machine(),platform.system(),platform.libc_ver()]))';

/** All child processes use argv, closed stdin, bounded output, and a killable process group. */
export function runPrintCommand(command, args, { cwd, signal, timeout = 120_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('PDF generation canceled'));
    const child = spawn(command, args, {
      cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', MPLBACKEND: 'Agg', PYTHONUNBUFFERED: '1', ...env, SCM_EXTRA_LAYOUTS: '' },
    });
    let output = '', failure;
    const stop = error => {
      failure = error;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* Child already exited. */ }
    };
    const abort = () => stop(signal.reason || new Error('PDF generation canceled'));
    const timer = setTimeout(() => stop(new Error('Print helper timed out')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const read = chunk => { output = (output + chunk.toString()).slice(-24_000); };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${path.basename(command)} failed (${code}): ${output.slice(-2000)}`));
      else resolve(output.trim());
    });
  });
}

export function headlessRequirements(upstream, extra) {
  const pins = new Map();
  for (const line of upstream.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-zA-Z0-9_-]+)==([a-zA-Z0-9.+!-]+)$/);
    if (match) pins.set(match[1].toLowerCase().replaceAll('_', '-'), `${match[1]}==${match[2]}`);
  }
  const selected = REQUIRED_PACKAGES.map(name => {
    if (!pins.has(name)) throw new Error(`Upstream no longer pins required package ${name}`);
    return pins.get(name);
  });
  return [...selected, extra.trim(), ''].join('\n');
}

export async function atomicJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2));
  await fs.rename(temporary, filename);
}

const digest = value => createHash('sha256').update(value).digest('hex');

/** Versions are never modified after activation; active.json is the only moving pointer. */
export class PrintGeneratorRuntime {
  constructor({ dataDir, pythonPath = process.env.PRINT_PYTHON || 'python3', repository = SCM_REPOSITORY,
    run = runPrintCommand, prepareCandidate } = {}) {
    if (!dataDir) throw new Error('Print runtime requires a data directory');
    this.root = path.resolve(dataDir, 'silhouette-card-maker');
    this.pythonPath = pythonPath;
    this.repository = repository;
    this.run = run;
    this.prepareCandidate = prepareCandidate;
    this.active = null;
    this.previousVersion = null;
    this.inUse = new Map();
    this.pending = null;
    this.status = { available: false, updating: false, revision: null, recipeId: 'household-letter-v6',
      lastCheckedAt: null, lastSuccessfulCheckAt: null, fallbackReason: null };
  }

  getStatus() { return { ...this.status }; }
  capture() {
    if (!this.active) throw new Error('PDF generator is unavailable; retry its update after connectivity is restored');
    const version = path.basename(this.active.directory);
    this.inUse.set(version, (this.inUse.get(version) || 0) + 1);
    let released = false;
    return { ...this.active, release: () => {
      if (released) return;
      released = true;
      this.inUse.set(version, this.inUse.get(version) - 1);
    } };
  }
  initialize() { return this.refresh(); }
  refresh() {
    if (this.pending) return this.pending;
    this.pending = this.update().finally(() => { this.pending = null; });
    return this.pending;
  }

  async update() {
    this.status.updating = true;
    this.status.lastCheckedAt = new Date().toISOString();
    let phase = 'runtime';
    try {
      await fs.mkdir(path.join(this.root, 'versions'), { recursive: true });
      const compatibility = digest(await this.run(this.pythonPath, ['-c', COMPATIBILITY_PROBE], { timeout: 15_000 }));
      const adapterHash = digest(await fs.readFile(PRINT_WORKER));
      let saved;
      try {
        saved = JSON.parse(await fs.readFile(path.join(this.root, 'active.json'), 'utf8'));
        if (!/^[a-f0-9]{40}-[a-f0-9]{12}-[a-f0-9-]+$/.test(saved.version)) {
          saved = undefined;
          throw new Error('Invalid cached version');
        }
        this.previousVersion = saved.previousVersion || null;
        this.status.lastSuccessfulCheckAt = saved.lastSuccessfulCheckAt || null;
        const directory = path.join(this.root, 'versions', saved.version);
        const metadata = JSON.parse(await fs.readFile(path.join(directory, 'ready.json'), 'utf8'));
        if (metadata.compatibility === compatibility && metadata.adapterHash === adapterHash) {
          await this.run(path.join(directory, 'venv/bin/python'), ['-c', 'import PIL, pypdf, click, utilities'], {
            cwd: path.join(directory, 'source'), timeout: 15_000,
          });
          this.activate({ ...metadata, directory });
          this.status.lastSuccessfulCheckAt = saved.lastSuccessfulCheckAt || null;
        }
      } catch { /* Missing or incompatible cache is recovered below, without preventing app startup. */ }

      // Try the latest upstream main in a separate bare fetch store. Working versions stay immutable.
      phase = 'update';
      const mirror = path.join(this.root, 'repository.git');
      await this.run('git', ['init', '--bare', mirror], { timeout: 15_000 });
      let revision;
      try {
        await this.run('git', ['--git-dir', mirror, 'fetch', '--depth=1', '--force', this.repository, 'main:refs/heads/main'], { timeout: 30_000 });
        revision = await this.run('git', ['--git-dir', mirror, 'rev-parse', 'refs/heads/main'], { timeout: 15_000 });
      } catch (error) {
        // A new compatible Python environment can be recreated offline from saved source/wheels.
        if (!this.active && saved) {
          phase = 'cached runtime rebuild';
          const oldDirectory = path.join(this.root, 'versions', saved.version);
          const old = JSON.parse(await fs.readFile(path.join(oldDirectory, 'ready.json'), 'utf8'));
          await this.prepare(old.revision, compatibility, adapterHash, { cachedSource: path.join(oldDirectory, 'source'), offline: true });
          phase = 'update';
        }
        throw error;
      }
      if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid upstream revision');
      if (!this.active || this.active.revision !== revision || this.active.adapterHash !== adapterHash) {
        phase = 'candidate validation';
        await this.prepare(revision, compatibility, adapterHash, { mirror });
      }
      this.status.lastSuccessfulCheckAt = new Date().toISOString();
      await atomicJson(path.join(this.root, 'active.json'), {
        version: path.basename(this.active.directory), lastSuccessfulCheckAt: this.status.lastSuccessfulCheckAt,
        previousVersion: this.previousVersion,
      });
      this.status.fallbackReason = null;
    } catch (error) {
      // Public status deliberately omits command output, local paths, and credentials.
      this.status.fallbackReason = this.active
        ? `Using the cached generator; ${phase} failed.`
        : `PDF generation unavailable; ${phase} failed and no compatible cached runtime is ready.`;
      this.lastError = error;
    } finally {
      this.status.updating = false;
      this.status.available = !!this.active;
    }
    return this.getStatus();
  }

  activate(runtime) {
    if (this.active && this.active.directory !== runtime.directory) this.previousVersion = path.basename(this.active.directory);
    this.active = Object.freeze(runtime);
    this.status.available = true;
    this.status.revision = runtime.revision;
  }

  async prepare(revision, compatibility, adapterHash, { mirror, cachedSource, offline = false }) {
    const directory = path.join(this.root, 'versions', `${revision}-${compatibility.slice(0, 12)}-${randomUUID()}`);
    await fs.mkdir(directory);
    try {
      const source = path.join(directory, 'source');
      if (cachedSource) await fs.cp(cachedSource, source, { recursive: true });
      else {
        await this.run('git', ['clone', '--no-hardlinks', '--branch', 'main', mirror, source], { timeout: 30_000 });
        await this.run('git', ['-C', source, 'checkout', '--detach', revision], { timeout: 15_000 });
      }
      const metadata = { revision, compatibility, adapterHash, validatedAt: new Date().toISOString() };
      await fs.copyFile(PRINT_WORKER, path.join(directory, 'adapter.py'));
      if (this.prepareCandidate) await this.prepareCandidate({ directory, offline });
      else await this.installAndValidate(directory, compatibility, offline);
      await atomicJson(path.join(directory, 'ready.json'), metadata);
      // Keep the former active version and all captured job versions. Retention is explicit future work.
      await atomicJson(path.join(this.root, 'active.json'), { version: path.basename(directory),
        previousVersion: this.active ? path.basename(this.active.directory) : this.previousVersion,
        lastSuccessfulCheckAt: this.status.lastSuccessfulCheckAt });
      this.activate({ ...metadata, directory });
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /** Caller supplies all versions referenced by durable jobs; active, previous, running jobs are always kept. */
  async prune({ retainVersions } = {}) {
    if (!Array.isArray(retainVersions)) throw new Error('Runtime cleanup requires the retained job-version list');
    if (this.pending) throw new Error('Cannot clean runtimes during an update');
    const keep = new Set([...retainVersions, this.previousVersion, this.active && path.basename(this.active.directory),
      ...[...this.inUse].filter(([, count]) => count > 0).map(([version]) => version)]);
    const removed = [];
    let versions;
    try { versions = await fs.readdir(path.join(this.root, 'versions'), { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return { removed: [], removedWheels: [] };
      throw error;
    }
    for (const entry of versions) {
      if (entry.isDirectory() && /^[a-f0-9]{40}-[a-f0-9]{12}-[a-f0-9-]+$/.test(entry.name) && !keep.has(entry.name)) {
        await fs.rm(path.join(this.root, 'versions', entry.name), { recursive: true, force: true });
        removed.push(entry.name);
      }
    }
    // Keep every wheel version needed by retained environments, including alternate platform wheels.
    const wheelPins = new Set();
    let canPruneWheels = true;
    for (const entry of await fs.readdir(path.join(this.root, 'versions'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const resolved = await fs.readFile(path.join(this.root, 'versions', entry.name, 'resolved-requirements.txt'), 'utf8');
        for (const line of resolved.split(/\r?\n/)) {
          const [name, version] = line.split('==');
          if (name && version) wheelPins.add(`${name.toLowerCase().replaceAll('-', '_')}-${version}`);
        }
      } catch { canPruneWheels = false; }
    }
    const removedWheels = [];
    if (canPruneWheels && wheelPins.size) {
      const wheelDirectory = path.join(this.root, 'wheels');
      for (const filename of await fs.readdir(wheelDirectory).catch(() => [])) {
        const [name, version] = filename.split('-');
        if (filename.endsWith('.whl') && !wheelPins.has(`${name.toLowerCase()}-${version}`)) {
          await fs.rm(path.join(wheelDirectory, filename), { force: true });
          removedWheels.push(filename);
        }
      }
    }
    return { removed, removedWheels };
  }

  async installAndValidate(directory, _compatibility, offline) {
    const requirements = headlessRequirements(
      await fs.readFile(path.join(directory, 'source/requirements.txt'), 'utf8'),
      await fs.readFile(MERGE_REQUIREMENTS, 'utf8'),
    );
    const requirementsPath = path.join(directory, 'requirements.txt');
    await fs.writeFile(requirementsPath, requirements);
    const wheels = path.join(this.root, 'wheels');
    await fs.mkdir(wheels, { recursive: true });
    await this.run(this.pythonPath, ['-m', 'venv', path.join(directory, 'venv')]);
    const python = path.join(directory, 'venv/bin/python');
    const install = () => this.run(python, ['-m', 'pip', 'install', '--no-index', '--find-links', wheels, '-r', requirementsPath]);
    try { await install(); }
    catch (error) {
      if (offline) throw error;
      await this.run(python, ['-m', 'pip', 'download', '--only-binary=:all:', '--disable-pip-version-check', '--timeout', '15', '--retries', '1', '--dest', wheels, '-r', requirementsPath], { timeout: 180_000 });
      await install();
    }
    await fs.writeFile(path.join(directory, 'resolved-requirements.txt'), await this.run(python, ['-m', 'pip', 'freeze']));
    await this.run(python, [path.join(directory, 'adapter.py'), 'smoke', path.join(directory, 'source'), path.join(directory, 'smoke')], {
      timeout: 120_000, env: { MPLCONFIGDIR: path.join(directory, 'matplotlib') },
    });
    await fs.rm(path.join(directory, 'smoke'), { recursive: true, force: true });
  }
}
