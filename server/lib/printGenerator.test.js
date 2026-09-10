import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
  it('separates ordinary copies and one-sheet DFC packets without changing their slots or pairs', () => {
    const cards = Array.from({ length: 16 }, (_, i) => ({ id: `copy-${i}`, frontPath: '/art/front.png',
      ...(i % 2 ? { backPath: '/art/back.png' } : {}) }));
    const [ordinary, first, second] = planPrintSheets(cards);
    expect(ordinary.chunks.map(cards => cards.length)).toEqual([7, 1]);
    expect(first).toMatchObject({ id: 'double-faced-001', packetIndex: 1, packetCount: 2 });
    expect(second).toMatchObject({ id: 'double-faced-002', packetIndex: 2, packetCount: 2 });
    expect(first.chunks.map(cards => cards.length)).toEqual([7]);
    expect(second.chunks.map(cards => cards.length)).toEqual([1]);
    expect(ordinary.slotMap[4]).toMatchObject({ cardId: 'copy-8', slot: 5, sheet: 1, frontPage: 1 });
    expect(second.slotMap[0]).toEqual({ cardId: 'copy-15', slot: 0, sheet: 1, frontPage: 1, backPage: 2 });
    expect(first.slotMap.map(slot => slot.slot)).toEqual([0, 1, 2, 3, 5, 6, 7]);
  });
  it.each([1, 7, 8, 250])('keeps every one of %i DFC copies in exactly one packet of at most seven', count => {
    const cards = Array.from({ length: count }, (_, i) => ({ id: `copy-${i}`, frontPath: '/a', backPath: '/b' }));
    const groups = planPrintSheets(cards);
    expect(groups).toHaveLength(Math.ceil(count / 7));
    expect(groups.flatMap(group => group.cards.map(card => card.id))).toEqual(cards.map(card => card.id));
    for (const [index, group] of groups.entries()) {
      expect(group).toMatchObject({ kind: 'dfc', packetIndex: index + 1, packetCount: groups.length });
      expect(group.chunks).toHaveLength(1);
      expect(group.cards.length).toBeLessThanOrEqual(7);
      expect(group.slotMap.every(slot => slot.sheet === 1 && slot.frontPage === 1 && slot.backPage === 2 && slot.slot !== 4)).toBe(true);
    }
  });
  it('bounds the maximum mixed deck to one ordinary artifact and 36 ordered DFC packets', () => {
    const cards = Array.from({ length: 250 }, (_, i) => ({ id: `copy-${i}`, frontPath: '/a', ...(i ? { backPath: '/b' } : {}) }));
    const groups = planPrintSheets(cards);
    expect(groups).toHaveLength(37);
    expect(groups[0]).toMatchObject({ id: 'fronts', kind: 'ordinary' });
    expect(groups.at(-1)).toMatchObject({ id: 'double-faced-036', packetIndex: 36, packetCount: 36 });
    expect(groups.map(group => group.id)).toEqual([...groups.map(group => group.id)].sort((a, b) => a === 'fronts' ? -1 : b === 'fronts' ? 1 : a.localeCompare(b)));
    expect(new Set(groups.flatMap(group => group.slotMap.map(slot => slot.cardId))).size).toBe(250);
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

  it('does nothing when a disabled, never-initialized runtime has no versions directory', async () => {
    const directory = await temp();
    const run = vi.fn();
    const runtime = new PrintGeneratorRuntime({ dataDir: directory, run });
    expect(await runtime.prune({ retainVersions: [] })).toEqual({ removed: [], removedWheels: [] });
    expect(await fs.readdir(directory)).toEqual([]);
    // An orphaned wheel cache is also preserved; cleanup must not initialize the runtime.
    const wheels = path.join(directory, 'silhouette-card-maker', 'wheels');
    await fs.mkdir(wheels, { recursive: true });
    await fs.writeFile(path.join(wheels, 'pillow-12.0.0-cached.whl'), 'cached wheel fixture');
    expect(await runtime.prune({ retainVersions: [] })).toEqual({ removed: [], removedWheels: [] });
    expect(await fs.readdir(runtime.root)).toEqual(['wheels']);
    expect(await fs.readFile(path.join(wheels, 'pillow-12.0.0-cached.whl'), 'utf8')).toBe('cached wheel fixture');
    expect(run).not.toHaveBeenCalled();
  });

  it('still rejects unsafe cleanup requests and propagates other versions-directory errors', async () => {
    const runtime = new PrintGeneratorRuntime({ dataDir: await temp() });
    await expect(runtime.prune()).rejects.toThrow('retained job-version list');
    runtime.pending = Promise.resolve();
    await expect(runtime.prune({ retainVersions: [] })).rejects.toThrow('during an update');
    runtime.pending = null;
    await fs.mkdir(runtime.root);
    await fs.writeFile(path.join(runtime.root, 'versions'), 'not a directory');
    await expect(runtime.prune({ retainVersions: [] })).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

describe('PDF adapter publication', () => {
  it.each([1, 7, 8, 249])('publishes %i DFC copies as paired packets after ordinary fronts, with matching labels and checksums', async count => {
    const directory = await temp();
    const release = vi.fn();
    const runtime = { capture: () => ({ directory: '/runtime/immutable', revision: 'fixed', release }) };
    const requests = [], merges = [];
    const run = async (_command, args) => {
      const request = JSON.parse(await fs.readFile(args[2], 'utf8'));
      if (args[1] === 'chunk') {
        requests.push(request);
        await fs.writeFile(path.join(request.directory, 'sheet.pdf'), request.label);
        await fs.writeFile(path.join(request.directory, 'result.json'), JSON.stringify({ images: request.cards.map(({ id }) => ({ id })) }));
      } else {
        merges.push(request);
        expect(request.inputs).toHaveLength(1);
        await fs.copyFile(request.inputs[0], request.output);
      }
    };
    const cards = [{ id: 'ordinary', frontPath: '/ordinary.png' }, ...Array.from({ length: count }, (_, i) => ({
      id: `copy-${i}`, frontPath: `/front-${i}.png`, backPath: `/back-${i}.png`,
    }))];
    const onProgress = vi.fn();
    const result = await createPrintGenerator({ runtime, run }).generate({ cards, outputDir: directory, batchLabel: 'CLC 1234abcd', onProgress });
    const packetCount = Math.ceil(count / 7);
    expect(result.artifacts).toHaveLength(packetCount + 1);
    expect(result.artifacts[0]).toMatchObject({ id: 'fronts', kind: 'ordinary', pageCount: 1, cardCount: 1, label: 'CLC 1234abcd fronts' });
    expect(result.artifacts[0]).not.toHaveProperty('packetIndex');
    expect(requests[0]).toMatchObject({ label: 'CLC 1234abcd fronts 1/1', doubleFaced: false });
    for (let i = 1; i <= packetCount; i++) {
      const artifact = result.artifacts[i];
      expect(artifact).toMatchObject({
        id: `double-faced-${String(i).padStart(3, '0')}`, kind: 'dfc', pageCount: 2, sheetCount: 1,
        cardCount: Math.min(7, count - (i - 1) * 7), packetIndex: i, packetCount, label: `CLC 1234abcd DFC ${i}/${packetCount}`,
      });
      expect(requests[i]).toMatchObject({ label: artifact.label, doubleFaced: true });
      expect(merges[i].pageCount).toBe(2);
      expect(artifact.slotMap.map(slot => slot.cardId)).toEqual(requests[i].cards.map(card => card.id));
      expect(artifact.slotMap.every(slot => slot.frontPage === 1 && slot.backPage === 2)).toBe(true);
      expect(result.slots.filter(slot => slot.artifactId === artifact.id)).toEqual(artifact.slotMap.map(slot => ({ ...slot, artifactId: artifact.id })));
    }
    for (const artifact of result.artifacts) {
      const bytes = await fs.readFile(artifact.path);
      expect(artifact.size).toBe(bytes.length);
      expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    expect(result.images.map(image => image.id)).toEqual(cards.map(card => card.id));
    expect(result.slots.map(slot => slot.cardId)).toEqual(cards.map(card => card.id));
    expect(requests.flatMap(request => request.cards)).toEqual(cards);
    expect(result.artifacts.reduce((sum, artifact) => sum + artifact.cardCount, 0)).toBe(cards.length);
    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual(Array.from({ length: packetCount + 1 }, (_, i) => ({
      phase: 'generating', completedSheets: i + 1, totalSheets: packetCount + 1,
    })));
    expect((await fs.readdir(directory)).sort()).toEqual(result.artifacts.map(artifact => path.basename(artifact.path)).sort());
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(['', 'CLC\nnext', 'CLC/'.repeat(7), 'x'.repeat(25), null])('rejects invalid batch label %s before capturing a runtime', async batchLabel => {
    const runtime = { capture: vi.fn() };
    await expect(createPrintGenerator({ runtime }).generate({ outputDir: await temp(), batchLabel,
      cards: [{ id: 'one', frontPath: '/front.png' }],
    })).rejects.toThrow('Batch label');
    expect(runtime.capture).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Infinity, NaN, '100', 2 * 1024 ** 3 + 1])('rejects invalid output budget %s before capturing a runtime', async maxOutputBytes => {
    const runtime = { capture: vi.fn() };
    const generator = createPrintGenerator({ runtime });
    await expect(generator.generate({ outputDir: await temp(), maxOutputBytes,
      cards: [{ id: 'one', frontPath: '/front.png' }],
    })).rejects.toThrow('output budget');
    expect(runtime.capture).not.toHaveBeenCalled();
  });

  it('enforces the remaining total output budget across artifacts before the next merge', async () => {
    const directory = await temp();
    const runtime = { capture: () => ({ directory: '/runtime/immutable', revision: 'fixed' }) };
    const run = vi.fn(async (_command, args) => {
      const request = JSON.parse(await fs.readFile(args[2], 'utf8'));
      if (args[1] === 'chunk') {
        await fs.writeFile(path.join(request.directory, 'sheet.pdf'), Buffer.alloc(60));
        await fs.writeFile(path.join(request.directory, 'result.json'), JSON.stringify({ images: [] }));
      } else await fs.writeFile(request.output, Buffer.alloc(60));
    });
    const generator = createPrintGenerator({ runtime, run });
    await expect(generator.generate({ outputDir: directory, maxOutputBytes: 100, cards: [
      { id: 'one', frontPath: '/a.png' }, { id: 'two', frontPath: '/b.png', backPath: '/c.png' },
    ] })).rejects.toThrow('remaining job storage budget');
    expect(run.mock.calls.map(([, args]) => args[1])).toEqual(['chunk', 'merge', 'chunk']);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('rejects a merged PDF that grows beyond its output budget and never publishes it', async () => {
    const directory = await temp();
    const runtime = { capture: () => ({ directory: '/runtime/immutable', revision: 'fixed' }) };
    const run = async (_command, args) => {
      const request = JSON.parse(await fs.readFile(args[2], 'utf8'));
      if (args[1] === 'chunk') {
        await fs.writeFile(path.join(request.directory, 'sheet.pdf'), Buffer.alloc(50));
        await fs.writeFile(path.join(request.directory, 'result.json'), JSON.stringify({ images: [] }));
      } else await fs.writeFile(request.output, Buffer.alloc(101));
    };
    const generator = createPrintGenerator({ runtime, run });
    await expect(generator.generate({ outputDir: directory, maxOutputBytes: 100,
      cards: [{ id: 'one', frontPath: '/a.png' }],
    })).rejects.toThrow('remaining job storage budget');
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('releases merged chunk files before generating the next artifact and preserves image metadata', async () => {
    const directory = await temp();
    const runtime = { capture: () => ({ directory: '/runtime/immutable', revision: 'fixed' }) };
    let previousChunk;
    const run = async (_command, args) => {
      const request = JSON.parse(await fs.readFile(args[2], 'utf8'));
      if (args[1] === 'chunk') {
        if (previousChunk) await expect(fs.access(previousChunk)).rejects.toThrow();
        previousChunk = request.directory;
        await fs.writeFile(path.join(request.directory, 'sheet.pdf'), Buffer.alloc(60));
        await fs.writeFile(path.join(request.directory, 'result.json'), JSON.stringify({ images: [{ id: request.cards[0].id }] }));
      } else {
        expect((await fs.stat(request.inputs[0])).size).toBe(60);
        await fs.writeFile(request.output, Buffer.alloc(60));
      }
    };
    const generator = createPrintGenerator({ runtime, run });
    const result = await generator.generate({ outputDir: directory, maxOutputBytes: 120, cards: [
      { id: 'one', frontPath: '/a.png' }, { id: 'two', frontPath: '/b.png', backPath: '/c.png' },
    ] });
    expect(result.images).toEqual([{ id: 'one' }, { id: 'two' }]);
    expect(result.artifacts.map(artifact => artifact.size)).toEqual([60, 60]);
    expect((await fs.readdir(directory)).sort()).toEqual(['double-faced-001.pdf', 'fronts.pdf']);
  });

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

  it.each(['decode', 'budget'])('removes all prepared packets when a later packet fails through %s', async failure => {
    const directory = await temp();
    const release = vi.fn();
    const runtime = { capture: () => ({ directory: '/runtime/immutable', revision: 'fixed', release }) };
    const run = vi.fn(async (_command, args) => {
      const request = JSON.parse(await fs.readFile(args[2], 'utf8'));
      if (args[1] === 'chunk') {
        if (failure === 'decode' && request.cards[0].id === 'copy-7') throw new Error('Packet 2 back image could not be decoded');
        await fs.writeFile(path.join(request.directory, 'sheet.pdf'), Buffer.alloc(60));
        await fs.writeFile(path.join(request.directory, 'result.json'), JSON.stringify({ images: [] }));
      } else await fs.writeFile(request.output, Buffer.alloc(60));
    });
    await expect(createPrintGenerator({ runtime, run }).generate({ outputDir: directory,
      maxOutputBytes: failure === 'budget' ? 100 : 1000,
      cards: Array.from({ length: 8 }, (_, i) => ({ id: `copy-${i}`, frontPath: '/a.png', backPath: '/b.png' })),
    })).rejects.toThrow(failure === 'decode' ? 'Packet 2 back image' : 'remaining job storage budget');
    expect(run.mock.calls.map(([, args]) => args[1])).toEqual(['chunk', 'merge', 'chunk']);
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
