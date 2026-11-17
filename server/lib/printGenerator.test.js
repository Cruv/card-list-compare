import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPrintGenerator, planPrintSheets, printPageIdentification, PRINT_RECIPE, PRINT_RECIPES, CROWNED_A4_RECIPE, CROWNED_A4_LANDSCAPE_RECIPE, CROWNED_A4_PORTRAIT_SIX_RECIPE, DAHLE_A4_RECIPE } from './printGenerator.js';
import { headlessRequirements, PrintGeneratorRuntime, runPrintCommand } from './printGeneratorRuntime.js';
import { DOUBLE_FACED_FIRST } from './printWorkflow.js';

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
  it.each(Object.values(PRINT_RECIPES).concat(CROWNED_A4_RECIPE, CROWNED_A4_LANDSCAPE_RECIPE, CROWNED_A4_PORTRAIT_SIX_RECIPE, DAHLE_A4_RECIPE))('builds full sheets and preserves each face slot with $id', recipe => {
    const capacity = recipe.cardsPerSheet;
    const ordinary = Array.from({ length: capacity + 2 }, (_, i) => ({ id: `single-${i}`, frontPath: '/a' }));
    const double = Array.from({ length: capacity + 1 }, (_, i) => ({ id: `double-${i}`, frontPath: '/a', backPath: '/b' }));
    const [first, second, remaining] = planPrintSheets([...ordinary, ...double], recipe, DOUBLE_FACED_FIRST);
    expect(first).toMatchObject({ packetIndex: 1, packetCount: 2, doubleFacedCardCount: capacity });
    expect(first.cards).toEqual(double.slice(0, capacity));
    expect(second).toMatchObject({ packetIndex: 2, packetCount: 2, doubleFacedCardCount: 1 });
    expect(second.cards).toEqual([...ordinary.slice(0, capacity - 1), double.at(-1)]);
    expect(second.slotMap.slice(0, -1).every(slot => slot.frontPage === 1 && !Object.hasOwn(slot, 'backPage'))).toBe(true);
    const slots = Array.from({ length: capacity + recipe.skip.length }, (_, i) => i).filter(slot => !recipe.skip.includes(slot));
    expect(second.slotMap.at(-1)).toEqual({ cardId: double.at(-1).id, sheet: 1, slot: slots.at(-1),
      frontPage: 1, backPage: 2 });
    expect(remaining).toMatchObject({ id: 'fronts', cards: ordinary.slice(capacity - 1) });
  });
  it('keeps the last row clear and packs a 250-copy mixed or split batch into six-card sheets', () => {
    const recipe = CROWNED_A4_PORTRAIT_SIX_RECIPE;
    const cards = Array.from({ length: 250 }, (_, id) => ({ id: String(id), frontPath: '/a', ...(id === 0 ? {} : { backPath: '/b' }) }));
    expect(recipe.skip).toEqual([6, 7, 8]);
    const mixed = planPrintSheets(cards, recipe, DOUBLE_FACED_FIRST);
    expect(mixed).toHaveLength(42);
    expect(mixed.at(-1)).toMatchObject({ id: 'double-faced-042', doubleFacedCardCount: 3 });
    expect(mixed.at(-1).slotMap.map(({ cardId, slot, backPage }) => [cardId, slot, backPage])).toEqual([
      ['0', 0, undefined], ['247', 1, 2], ['248', 2, 2], ['249', 3, 2],
    ]);
    const separate = planPrintSheets(cards, recipe);
    expect(separate).toHaveLength(43);
    expect(separate[0]).toMatchObject({ id: 'fronts', kind: 'ordinary' });
    for (const plan of [mixed, separate]) {
      const slots = plan.flatMap(artifact => artifact.slotMap);
      expect(new Set(slots.map(slot => slot.cardId)).size).toBe(250);
      expect(slots.filter(slot => slot.backPage === 2)).toHaveLength(249);
      expect(slots.every(({ slot }) => slot < 6)).toBe(true);
    }
    expect(planPrintSheets(cards.slice(0, 13).map(({ id, frontPath }) => ({ id, frontPath })), recipe)[0].chunks.map(chunk => chunk.length)).toEqual([6, 6, 1]);
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

  it('rebuilds the saved source after a generator upgrade rejects newer upstream geometry', async () => {
    const f = await fixture();
    await f.runtime.initialize();
    await f.commit('incompatible layout');
    const { version } = JSON.parse(await fs.readFile(path.join(f.runtime.root, 'active.json'), 'utf8'));
    const filename = path.join(f.runtime.root, 'versions', version, 'ready.json');
    const metadata = JSON.parse(await fs.readFile(filename, 'utf8'));
    await fs.writeFile(filename, JSON.stringify({ ...metadata, adapterHash: 'previous adapter' }));
    f.prepareCandidate.mockRejectedValueOnce(new Error('unapproved registration geometry'));
    const fresh = new PrintGeneratorRuntime({ dataDir: f.directory, repository: f.repository, run: f.run, prepareCandidate: f.prepareCandidate });
    expect(await fresh.initialize()).toMatchObject({ available: true, revision: f.revision,
      fallbackReason: 'Using the cached generator; candidate validation failed.' });
    expect(f.prepareCandidate.mock.calls.at(-1)[0]).toMatchObject({ offline: true });
    const captured = fresh.capture();
    expect(await fs.readFile(path.join(captured.directory, 'source/code.txt'), 'utf8')).toBe('initial');
    captured.release();
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
  it('normalizes controls, Unicode and long names into bounded honest printed identification', () => {
    expect(printPageIdentification({ requesterName: ' Dénny\n\u202e(Franco) ', batchName: 'Jin’s “deck” — 🐉' })).toEqual({
      version: 1, requesterName: 'Denny (Franco)', batchName: 'Jin\'s "deck" - ?',
    });
    const long = printPageIdentification({ requesterName: 'W'.repeat(100), batchName: 'W'.repeat(300) });
    expect(long.requesterName).toHaveLength(48);
    expect(long.batchName).toHaveLength(96);
    expect(long.batchName.endsWith('...')).toBe(true);
    expect(printPageIdentification({ requesterName: '   ', batchName: '\n' })).toMatchObject({ requesterName: 'Unknown requester', batchName: 'Print list' });
    expect(() => printPageIdentification({ requesterName: null })).toThrow('bounded text');
    expect(() => printPageIdentification({ batchName: 'x'.repeat(4097) })).toThrow('bounded text');
  });

  it.each([[1, undefined], [7, 'letter'], [8, 'a4'], [249, 'letter'], [10, 'a4', 'crowned-a4'], [9, 'a4', 'crowned-a4-landscape'],
    [7, 'a4', 'crowned-a4-portrait-six']])('publishes %i DFC copies (%s) as paired packets after ordinary fronts, with matching labels and checksums', async (count, paperSize, printPreset) => {
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
    const result = await createPrintGenerator({ runtime, run }).generate({ cards, outputDir: directory, batchLabel: 'CLC 1234abcd',
      requesterName: 'Dénny', batchName: 'Friday proxies', onProgress, paperSize, printPreset });
    const presets = [CROWNED_A4_RECIPE, CROWNED_A4_LANDSCAPE_RECIPE, CROWNED_A4_PORTRAIT_SIX_RECIPE];
    const recipe = presets.find(preset => preset.printPreset === printPreset) || PRINT_RECIPES[paperSize ?? 'letter'];
    expect(result.recipe).toBe(recipe);
    expect([...requests, ...merges].every(request => request.paperSize === recipe.paperSize && request.printPreset === printPreset)).toBe(true);
    expect(result.printedIdentification).toEqual({ version: 1, requesterName: 'Denny', batchName: 'Friday proxies' });
    const packetCount = Math.ceil(count / recipe.cardsPerSheet);
    expect(result.artifacts).toHaveLength(packetCount + 1);
    expect(result.artifacts[0]).toMatchObject({ id: 'fronts', kind: 'ordinary', pageCount: 1, cardCount: 1, label: 'CLC 1234abcd fronts' });
    expect(result.artifacts[0]).not.toHaveProperty('packetIndex');
    expect(requests[0]).toMatchObject({ label: 'CLC 1234abcd fronts 1/1', doubleFaced: false });
    expect(result.artifacts[0].pageLabels).toEqual([{ page: 1, phase: 'fronts', label: 'CLC 1234abcd fronts 1/1' }]);
    for (let i = 1; i <= packetCount; i++) {
      const artifact = result.artifacts[i];
      expect(artifact).toMatchObject({
        id: `double-faced-${String(i).padStart(3, '0')}`, kind: 'dfc', pageCount: 2, sheetCount: 1,
        cardCount: Math.min(recipe.cardsPerSheet, count - (i - 1) * recipe.cardsPerSheet),
        packetIndex: i, packetCount, label: `CLC 1234abcd DFC ${i}/${packetCount}`,
      });
      expect(requests[i]).toMatchObject({ label: artifact.label, doubleFaced: true });
      expect(artifact.printedIdentification).toEqual(result.printedIdentification);
      expect(requests[i].printedIdentification).toEqual(result.printedIdentification);
      expect(artifact.pageLabels).toEqual([{ page: 1, phase: 'fronts', label: artifact.label }, { page: 2, phase: 'backs', label: artifact.label }]);
      expect(requests[i].pageLabels).toEqual(artifact.pageLabels);
      expect(merges[i].pageCount).toBe(2);
      expect(artifact.slotMap.map(slot => slot.cardId)).toEqual(requests[i].cards.map(card => card.id));
      if (printPreset) expect(artifact.slotMap.map(slot => slot.slot)).toEqual(Array.from({ length: artifact.cardCount }, (_, index) => index));
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

  it.each(['legal', '', null, ['a4'], '__proto__'])('rejects unknown paper %s before capturing a runtime', async paperSize => {
    const capture = vi.fn();
    await expect(createPrintGenerator({ runtime: { capture } }).generate({ paperSize })).rejects.toThrow('Paper size');
    expect(capture).not.toHaveBeenCalled();
  });

  it('publishes eight singles and one DFC as one Crowned A4 refeed packet and one physical sheet', async () => {
    const directory = await temp();
    const runtime = { capture: () => ({ directory: '/runtime', revision: 'fixed' }) };
    const run = async (_command, args) => {
      const request = JSON.parse(await fs.readFile(args[2], 'utf8'));
      if (args[1] === 'chunk') {
        expect(request).toMatchObject({ doubleFaced: true, sheetPacking: DOUBLE_FACED_FIRST });
        expect(request.cards.map(card => card.id)).toEqual([...cards.slice(1), cards[0]].map(card => card.id));
        await fs.writeFile(path.join(request.directory, 'sheet.pdf'), request.label);
        await fs.writeFile(path.join(request.directory, 'result.json'), '{"images":[]}');
      } else {
        expect(request).toMatchObject({ pageCount: 2 });
        await fs.copyFile(request.inputs[0], request.output);
      }
    };
    const cards = [{ id: 'double', frontPath: '/a', backPath: '/b' },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `single-${i}`, frontPath: '/a' }))];
    const onProgress = vi.fn();
    const result = await createPrintGenerator({ runtime, run }).generate({ cards, outputDir: directory, paperSize: 'a4',
      printPreset: 'crowned-a4', sheetPacking: DOUBLE_FACED_FIRST, onProgress });
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({ kind: 'dfc', pageCount: 2, sheetCount: 1, cardCount: 9,
      doubleFacedCardCount: 1, packetIndex: 1, packetCount: 1 });
    expect(result.slots.filter(slot => slot.backPage).map(slot => slot.cardId)).toEqual(['double']);
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({ phase: 'generating', completedSheets: 1, totalSheets: 1 });
  });

  it.each([['letter', 'crowned-a4'], ['letter', 'crowned-a4-landscape'], ['letter', 'crowned-a4-portrait-six'], ['letter', 'dahle-a4-punch'], ['a4', 'custom']])('rejects unsupported preset/stock pair %s %s before capturing a runtime', async (paperSize, printPreset) => {
    const capture = vi.fn();
    await expect(createPrintGenerator({ runtime: { capture } }).generate({ paperSize, printPreset })).rejects.toThrow('requires A4');
    expect(capture).not.toHaveBeenCalled();
  });

  it('writes nine Dahle slots per sheet with no Cameo marks even if requested', async () => {
    const directory = await temp(), chunkSizes = [];
    const runtime = { capture: () => ({ directory: '/runtime', revision: 'fixed' }) };
    const run = async (_command, args) => {
      const request = JSON.parse(await fs.readFile(args[2], 'utf8'));
      expect(request).toMatchObject({ paperSize: 'a4', printPreset: 'dahle-a4-punch' });
      if (args[1] === 'chunk') {
        expect(request.registrationMarks).toBe(false);
        expect(request.cards.every(card => card.frontSource === 'scryfall')).toBe(true);
        chunkSizes.push(request.cards.length);
        await fs.writeFile(path.join(request.directory, 'sheet.pdf'), request.label);
        await fs.writeFile(path.join(request.directory, 'result.json'), JSON.stringify({ images: [], registrationMarks: false }));
      } else {
        expect(request.pageCount).toBe(2);
        await fs.writeFile(request.output, 'merged');
      }
    };
    const cards = Array.from({ length: 11 }, (_, index) => ({ id: String(index), frontPath: '/a', frontSource: 'scryfall' }));
    const result = await createPrintGenerator({ runtime, run }).generate({
      cards, outputDir: directory, paperSize: 'a4', printPreset: 'dahle-a4-punch', registrationMarks: true,
    });
    expect(chunkSizes).toEqual([9, 2]);
    expect(result.recipe).toMatchObject({ cardWidthMm: 63, cardHeightMm: 88, bleedMm: 1, registration: 0 });
    expect(result.slots.slice(-2).map(({ slot, sheet }) => [slot, sheet])).toEqual([[0, 2], [1, 2]]);
  });

  it('tags every ordinary sheet with its own page number and preserves the exact packet identity', async () => {
    const directory = await temp(), requests = [];
    const runtime = { capture: () => ({ directory: '/runtime', revision: 'fixed' }) };
    const run = async (_command, args) => {
      const request = JSON.parse(await fs.readFile(args[2], 'utf8'));
      if (args[1] === 'chunk') {
        requests.push(request);
        await fs.writeFile(path.join(request.directory, 'sheet.pdf'), request.label);
        await fs.writeFile(path.join(request.directory, 'result.json'), JSON.stringify({ images: [] }));
      } else await fs.writeFile(request.output, 'merged');
    };
    const result = await createPrintGenerator({ runtime, run }).generate({ outputDir: directory, batchLabel: 'CLC 1234abcd',
      cards: Array.from({ length: 15 }, (_, i) => ({ id: `copy-${i}`, frontPath: '/front.png' })),
      requesterName: '(Denny) \\ printer', batchName: 'W'.repeat(120) });
    expect(result.artifacts[0].label).toBe('CLC 1234abcd fronts');
    expect(result.artifacts[0].pageLabels).toEqual([1, 2, 3].map(page => ({ page, phase: 'fronts', label: `CLC 1234abcd fronts ${page}/3` })));
    expect(requests.map(request => request.pageLabels)).toEqual([1, 2, 3].map(page => [{ page: 1, phase: 'fronts', label: `CLC 1234abcd fronts ${page}/3` }]));
    expect(result.artifacts[0].printedIdentification).toEqual(result.printedIdentification);
  });

  it('requires the adapter to confirm mark removal before publishing paired pages', async () => {
    const directory = await temp(), requests = [];
    const runtime = { capture: () => ({ directory: '/runtime', revision: 'fixed' }) };
    let registrationMarks;
    const run = async (_command, args) => {
      const request = JSON.parse(await fs.readFile(args[2], 'utf8'));
      if (args[1] === 'chunk') {
        requests.push(request);
        await fs.writeFile(path.join(request.directory, 'sheet.pdf'), request.label);
        await fs.writeFile(path.join(request.directory, 'result.json'), JSON.stringify({ images: [], registrationMarks }));
      } else await fs.copyFile(request.inputs[0], request.output);
    };
    const generator = createPrintGenerator({ runtime, run });
    const input = { outputDir: directory, registrationMarks: false, cards: [
      { id: 'one', frontPath: '/front.png', backPath: '/back.png' },
    ] };
    await expect(generator.generate(input)).rejects.toThrow('did not confirm');
    expect(await fs.readdir(directory)).toEqual([]);

    registrationMarks = false;
    const result = await generator.generate(input);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.registrationMarks).toBe(false);
      expect(request.pageLabels.map(({ phase }) => phase)).toEqual(['fronts', 'backs']);
    }
    expect(result.artifacts[0]).toMatchObject({ pageCount: 2, kind: 'dfc' });
    expect(await fs.readdir(directory)).toEqual(['double-faced-001.pdf']);
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
