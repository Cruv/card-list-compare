import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPrintGenerator, planPrintSheets, PRINT_RECIPE } from './printGenerator.js';
import { headlessRequirements, PrintGeneratorRuntime, runPrintCommand } from './printGeneratorRuntime.js';

const temporary = [];
async function temp() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clc-print-test-'));
  temporary.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });

describe('physical PDF sheet planning', () => {
  it('splits ordinary/DFC copies, repeats all quantities, and preserves page pairs across chunks', () => {
    const cards = Array.from({ length: 16 }, (_, i) => ({ id: `copy-${i}`, frontPath: '/art/front.png',
      ...(i % 2 ? { backPath: '/art/back.png' } : {}) }));
    const [ordinary, dfc] = planPrintSheets(cards);
    expect(ordinary.chunks.map(cards => cards.length)).toEqual([7, 1]);
    expect(dfc.chunks.map(cards => cards.length)).toEqual([7, 1]);
    expect(ordinary.slotMap[4]).toMatchObject({ cardId: 'copy-8', slot: 5, sheet: 1, frontPage: 1 });
    expect(dfc.slotMap[7]).toEqual({ cardId: 'copy-15', slot: 0, sheet: 2, frontPage: 3, backPage: 4 });
    expect(dfc.slotMap.some(slot => slot.slot === 4)).toBe(false);
  });
  it('rejects duplicate copies, missing staged paths, empty and oversized requests', () => {
    expect(() => planPrintSheets([])).toThrow('physical card copies');
    expect(() => planPrintSheets([{ id: 'x', frontPath: '../file' }])).toThrow('absolute');
    expect(() => planPrintSheets([{ id: 'x', frontPath: '/a' }, { id: 'x', frontPath: '/b' }])).toThrow('unique');
    expect(() => planPrintSheets(Array.from({ length: 251 }, (_, i) => ({ id: `${i}`, frontPath: '/a' })))).toThrow('250');
    expect(PRINT_RECIPE).toMatchObject({ id: 'household-letter-v6', ppi: 600, crop: '1mm', registration: 3 });
  });
});

describe('cached generator runtime', () => {
  it('selects only pinned headless upstream dependencies plus the merger', () => {
    const upstream = ['click', 'filetype', 'matplotlib', 'natsort', 'numpy', 'pillow', 'pydantic', 'pyautogui', 'pywinauto']
      .map(name => `${name}==1.2.3`).join('\n');
    const selected = headlessRequirements(upstream, 'pypdf==6.10.0');
    expect(selected).toContain('pypdf==6.10.0');
    expect(selected).not.toContain('pyautogui');
    expect(selected).not.toContain('pywinauto');
    expect(() => headlessRequirements(upstream.replace('pillow==1.2.3', 'pillow>=1'), '')).toThrow('pins');
  });

  async function fixture() {
    const directory = await temp();
    const repository = path.join(directory, 'upstream');
    await runPrintCommand('git', ['init', '--initial-branch=main', repository]);
    await runPrintCommand('git', ['-C', repository, 'config', 'user.name', 'CLC Test']);
    await runPrintCommand('git', ['-C', repository, 'config', 'user.email', 'test@example.invalid']);
    const commit = async value => {
      await fs.writeFile(path.join(repository, 'code.txt'), value);
      await runPrintCommand('git', ['-C', repository, 'add', '.']);
      await runPrintCommand('git', ['-C', repository, 'commit', '-m', value]);
      return runPrintCommand('git', ['-C', repository, 'rev-parse', 'HEAD']);
    };
    const revision = await commit('initial');
    const run = (command, args, options) => command === 'git' ? runPrintCommand(command, args, options) : Promise.resolve('stable-python-ABI');
    const prepareCandidate = vi.fn(async () => {});
    const runtime = new PrintGeneratorRuntime({ dataDir: directory, repository, run, prepareCandidate });
    return { directory, repository, revision, commit, run, prepareCandidate, runtime };
  }

  it('activates latest main, shares refresh calls, keeps a captured revision stable, and falls back after failed validation', async () => {
    const f = await fixture();
    const first = f.runtime.initialize();
    expect(f.runtime.refresh()).toBe(first);
    expect(await first).toMatchObject({ available: true, revision: f.revision, fallbackReason: null });
    const captured = f.runtime.capture();
    const newer = await f.commit('newer');
    f.prepareCandidate.mockRejectedValueOnce(new Error('new dependencies incompatible'));
    expect(await f.runtime.refresh()).toMatchObject({ revision: f.revision, available: true });
    expect(f.runtime.getStatus().fallbackReason).toContain('cached');
    expect(await f.runtime.refresh()).toMatchObject({ revision: newer, fallbackReason: null });
    expect(await fs.readFile(path.join(captured.directory, 'source/code.txt'), 'utf8')).toBe('initial');
    expect(captured.revision).toBe(f.revision);
    captured.release();
    const status = f.runtime.getStatus();
    expect(JSON.stringify(status)).not.toContain(f.directory);
  });

  it('loads a cached version in a fresh process with unreachable upstream and keeps first-offline startup available', async () => {
    const f = await fixture();
    await f.runtime.initialize();
    await fs.rename(f.repository, `${f.repository}-offline`);
    const fresh = new PrintGeneratorRuntime({ dataDir: f.directory, repository: f.repository, run: f.run, prepareCandidate: f.prepareCandidate });
    expect(await fresh.initialize()).toMatchObject({ available: true, revision: f.revision });
    expect(fresh.getStatus().fallbackReason).toContain('cached');
    const empty = new PrintGeneratorRuntime({ dataDir: await temp(), repository: f.repository, run: f.run, prepareCandidate: f.prepareCandidate });
    expect(await empty.initialize()).toMatchObject({ available: false, revision: null });
    expect(() => empty.capture()).toThrow('unavailable');
  });

  it('recreates a missing compatible venv offline and rejects an unsafe cached pointer', async () => {
    const f = await fixture();
    await f.runtime.initialize();
    await fs.rename(f.repository, `${f.repository}-offline`);
    const run = (command, args, options) => command.includes('/venv/')
      ? Promise.reject(new Error('missing environment')) : f.run(command, args, options);
    const fresh = new PrintGeneratorRuntime({ dataDir: f.directory, repository: f.repository, run, prepareCandidate: f.prepareCandidate });
    expect(await fresh.initialize()).toMatchObject({ available: true, revision: f.revision });
    expect(f.prepareCandidate.mock.calls.at(-1)[0]).toMatchObject({ offline: true });
    expect(fresh.getStatus().fallbackReason).toBe('Using the cached generator; update failed.');
    expect(fresh.getStatus().lastSuccessfulCheckAt).toBeTruthy();
    const other = await temp();
    await fs.mkdir(path.join(other, 'silhouette-card-maker'));
    await fs.writeFile(path.join(other, 'silhouette-card-maker/active.json'), JSON.stringify({ version: '../../outside' }));
    const invalid = new PrintGeneratorRuntime({ dataDir: other, repository: f.repository, run: f.run, prepareCandidate: f.prepareCandidate });
    expect(await invalid.initialize()).toMatchObject({ available: false });
  });

  it('cleanup preserves previous, running, and explicitly retained job versions', async () => {
    const f = await fixture();
    await f.runtime.initialize();
    const captured = f.runtime.capture();
    await f.commit('second'); await f.runtime.refresh();
    await f.commit('third'); await f.runtime.refresh();
    expect(await f.runtime.prune({ retainVersions: [] })).toMatchObject({ removed: [] });
    captured.release();
    expect((await f.runtime.prune({ retainVersions: [path.basename(captured.directory)] })).removed).toEqual([]);
    expect((await f.runtime.prune({ retainVersions: [] })).removed).toEqual([path.basename(captured.directory)]);
  });
});

describe('PDF adapter publication', () => {
  it('rejects excessive compressed page data before allocating a whole-deck merger', async () => {
    const directory = await temp();
    const runtime = { capture: () => ({ directory: '/runtime/immutable', revision: 'fixed' }) };
    const run = vi.fn(async (_command, args) => {
      expect(args[1]).toBe('chunk');
      const request = JSON.parse(await fs.readFile(args[2], 'utf8'));
      const pdf = await fs.open(path.join(request.directory, 'sheet.pdf'), 'w');
      await pdf.truncate(600 * 1024 * 1024); // Sparse fixture: does not allocate 600 MiB.
      await pdf.close();
      await fs.writeFile(path.join(request.directory, 'result.json'), JSON.stringify({ images: [] }));
    });
    const generator = createPrintGenerator({ runtime, run });
    await expect(generator.generate({ outputDir: directory,
      cards: Array.from({ length: 8 }, (_, i) => ({ id: `${i}`, frontPath: '/front.png' })),
    })).rejects.toThrow('1 GiB');
    expect(run).toHaveBeenCalledTimes(2);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('does not publish a partial ordinary artifact when a required DFC sheet fails', async () => {
    const directory = await temp();
    const release = vi.fn();
    const runtime = { capture: () => ({ directory: '/runtime/immutable', revision: 'fixed', release }) };
    const run = async (_command, args) => {
      const request = JSON.parse(await fs.readFile(args[2], 'utf8'));
      if (args[1] === 'chunk') {
        if (request.doubleFaced) throw new Error('Back image could not be decoded');
        await fs.writeFile(path.join(request.directory, 'sheet.pdf'), 'synthetic test content');
        await fs.writeFile(path.join(request.directory, 'result.json'), JSON.stringify({ images: [] }));
      } else await fs.writeFile(request.output, 'synthetic test content');
    };
    const generator = createPrintGenerator({ runtime, run });
    await expect(generator.generate({ outputDir: directory, cards: [
      { id: 'one', frontPath: '/a.png' }, { id: 'two', frontPath: '/b.png', backPath: '/c.png' },
    ] })).rejects.toThrow('Back image');
    expect(await fs.readdir(directory)).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('terminates a blocked helper on cancellation rather than leaving it running', async () => {
    const controller = new AbortController();
    const command = runPrintCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });
    controller.abort(new Error('Canceled by test'));
    await expect(command).rejects.toThrow('Canceled by test');
  });
});
