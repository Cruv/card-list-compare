import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrintGeneratorRuntime, runPrintCommand } from './printGeneratorRuntime.js';

export const MAX_PRINT_COPIES = 250;
export const PRINT_RECIPE = Object.freeze({
  id: 'household-letter-v6', template: 'letter-standard-v6', cardSize: 'standard', paperSize: 'letter',
  ppi: 600, quality: 100, crop: '1mm', registration: 3, skip: Object.freeze([4]),
  cardsPerSheet: 7, pageWidthPoints: 792, pageHeightPoints: 612,
  colorSpace: 'DeviceRGB', embeddedIcc: false, colorNormalized: false,
});
const USABLE_SLOTS = [0, 1, 2, 3, 5, 6, 7];
const MAX_PDF_BYTES = 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * MAX_PDF_BYTES;
const DEFAULT_DATA = process.env.DB_PATH ? path.dirname(path.resolve(process.env.DB_PATH))
  : fileURLToPath(new URL('../data', import.meta.url));

export function planPrintSheets(cards) {
  if (!Array.isArray(cards) || !cards.length || cards.length > MAX_PRINT_COPIES) {
    throw new Error(`PDF generation requires 1–${MAX_PRINT_COPIES} physical card copies`);
  }
  const ids = new Set();
  for (const card of cards) {
    if (!card || typeof card.id !== 'string' || !card.id || card.id.length > 200 || ids.has(card.id)) throw new Error('Each physical copy must have a unique ID');
    if (!path.isAbsolute(card.frontPath || '') || (card.backPath != null && !path.isAbsolute(card.backPath))) throw new Error(`Copy ${card.id} requires absolute staged image paths`);
    ids.add(card.id);
  }
  const ordinary = cards.filter(card => !card.backPath);
  const doubleFaced = cards.filter(card => card.backPath);
  const packetCount = Math.ceil(doubleFaced.length / PRINT_RECIPE.cardsPerSheet);
  return [
    ...(ordinary.length ? [{ id: 'fronts', kind: 'ordinary', cards: ordinary }] : []),
    ...Array.from({ length: packetCount }, (_, index) => ({
      id: `double-faced-${String(index + 1).padStart(3, '0')}`, kind: 'dfc',
      cards: doubleFaced.slice(index * PRINT_RECIPE.cardsPerSheet, (index + 1) * PRINT_RECIPE.cardsPerSheet),
      packetIndex: index + 1, packetCount,
    })),
  ].map(group => ({
    ...group,
    chunks: Array.from({ length: Math.ceil(group.cards.length / 7) }, (_, i) => group.cards.slice(i * 7, i * 7 + 7)),
    slotMap: group.cards.map((card, i) => ({
      cardId: card.id, sheet: Math.floor(i / 7) + 1, slot: USABLE_SLOTS[i % 7],
      frontPage: Math.floor(i / 7) * (group.kind === 'dfc' ? 2 : 1) + 1,
      ...(group.kind === 'dfc' ? { backPage: Math.floor(i / 7) * 2 + 2 } : {}),
    })),
  }));
}

export function createPrintGenerator(options = {}) {
  const runtime = options.runtime || new PrintGeneratorRuntime({ dataDir: DEFAULT_DATA, ...options });
  const run = options.run || runPrintCommand;
  let generating = false;
  return {
    initialize: () => runtime.initialize(), refresh: () => runtime.refresh(), getStatus: () => runtime.getStatus(),
    prune: options => runtime.prune(options),
    async generate({ cards, outputDir, signal, onProgress = () => {}, maxOutputBytes = MAX_OUTPUT_BYTES, batchLabel = 'CLC' }) {
      const plan = planPrintSheets(cards);
      if (!path.isAbsolute(outputDir || '')) throw new Error('PDF output directory must be absolute');
      if (typeof batchLabel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,23}$/.test(batchLabel)) {
        throw new Error('Batch label must contain 1–24 printable letters, numbers, spaces, hyphens or underscores');
      }
      if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > MAX_OUTPUT_BYTES) {
        throw new Error('PDF output budget must be a positive integer no larger than 2 GiB');
      }
      if (generating) throw new Error('The PDF generator is busy');
      const captured = runtime.capture();
      generating = true;
      const working = path.join(outputDir, `.preparing-${randomUUID()}`);
      const artifacts = [], images = [], slots = [];
      const published = [];
      try {
        await fs.mkdir(working, { recursive: true });
        // Never replace completed artifacts during an accidental duplicate invocation.
        for (const group of plan) {
          try { await fs.access(path.join(outputDir, `${group.id}.pdf`)); }
          catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          throw new Error('PDF output already exists; create a new job for a reprint');
        }
        let completedSheets = 0;
        let completedBytes = 0;
        const totalSheets = plan.reduce((sum, group) => sum + group.chunks.length, 0);
        const python = path.join(captured.directory, 'venv/bin/python');
        const execute = args => run(python, [path.join(captured.directory, 'adapter.py'), ...args], {
          signal, timeout: 120_000, env: { MPLCONFIGDIR: path.join(working, 'matplotlib') },
        });
        for (const group of plan) {
          const label = group.kind === 'dfc'
            ? `${batchLabel} DFC ${group.packetIndex}/${group.packetCount}` : `${batchLabel} fronts`;
          const parts = [];
          let partBytes = 0;
          for (const [index, chunk] of group.chunks.entries()) {
            if (signal?.aborted) throw signal.reason || new Error('PDF generation canceled');
            const chunkDirectory = path.join(working, `${group.id}-${index + 1}`);
            await fs.mkdir(chunkDirectory);
            const input = path.join(chunkDirectory, 'input.json');
            await fs.writeFile(input, JSON.stringify({ cards: chunk, source: path.join(captured.directory, 'source'),
              label: group.kind === 'dfc' ? label : `${label} ${index + 1}/${group.chunks.length}`,
              directory: chunkDirectory, doubleFaced: group.kind === 'dfc' }));
            await execute(['chunk', input]);
            const result = JSON.parse(await fs.readFile(path.join(chunkDirectory, 'result.json'), 'utf8'));
            images.push(...result.images);
            parts.push(path.join(chunkDirectory, 'sheet.pdf'));
            partBytes += (await fs.stat(parts.at(-1))).size;
            if (partBytes > MAX_PDF_BYTES) throw new Error('Generated PDF exceeds the 1 GiB artifact limit');
            if (completedBytes + partBytes > maxOutputBytes) throw new Error('Generated PDFs exceed the remaining job storage budget');
            onProgress({ phase: 'generating', completedSheets: ++completedSheets, totalSheets });
          }
          const stagedOutput = path.join(working, `${group.id}.pdf`);
          const mergeInput = path.join(working, `${group.id}-merge.json`);
          const pageCount = group.chunks.length * (group.kind === 'dfc' ? 2 : 1);
          await fs.writeFile(mergeInput, JSON.stringify({ inputs: parts, output: stagedOutput, pageCount }));
          await execute(['merge', mergeInput]);
          const size = (await fs.stat(stagedOutput)).size;
          if (!size || size > MAX_PDF_BYTES) throw new Error('Generated PDF exceeds the 1 GiB artifact limit');
          if (completedBytes + size > maxOutputBytes) throw new Error('Generated PDFs exceed the remaining job storage budget');
          completedBytes += size;
          // Each final artifact is self-contained after the worker validates its
          // merge; release the compressed sheet copies before the next group.
          for (const filename of parts) await fs.rm(path.dirname(filename), { recursive: true, force: true });
          const hash = createHash('sha256');
          for await (const buffer of createReadStream(stagedOutput)) hash.update(buffer);
          const sha256 = hash.digest('hex');
          artifacts.push({ id: group.id, kind: group.kind, path: path.join(outputDir, `${group.id}.pdf`),
            sha256, size, pageCount, cardCount: group.cards.length, sheetCount: group.chunks.length, slotMap: group.slotMap,
            label, ...(group.kind === 'dfc' ? { packetIndex: group.packetIndex, packetCount: group.packetCount } : {}) });
          slots.push(...group.slotMap.map(slot => ({ ...slot, artifactId: group.id })));
        }
        if (signal?.aborted) throw signal.reason || new Error('PDF generation canceled');
        for (const artifact of artifacts) {
          // Exclusive hard-link creation is atomic and cannot overwrite an existing artifact.
          await fs.link(path.join(working, `${artifact.id}.pdf`), artifact.path);
          published.push(artifact.path);
        }
        return { revision: captured.revision, runtimeVersion: path.basename(captured.directory), recipe: PRINT_RECIPE, artifacts, slots, images };
      } catch (error) {
        // Any published paths belong to this invocation; existing artifacts were checked before generation.
        for (const filename of published) await fs.rm(filename, { force: true });
        throw error;
      } finally {
        try { await fs.rm(working, { recursive: true, force: true }); }
        finally { captured.release?.(); generating = false; }
      }
    },
  };
}

const singleton = createPrintGenerator();
const disabledStatus = () => ({ ...singleton.getStatus(), available: false, updating: false,
  fallbackReason: 'PDF generation is disabled by PRINT_ENABLED=false.' });
export const initializePrintGenerator = () => process.env.PRINT_ENABLED === 'false' ? Promise.resolve(disabledStatus()) : singleton.initialize();
export const refreshPrintGenerator = () => process.env.PRINT_ENABLED === 'false' ? Promise.resolve(disabledStatus()) : singleton.refresh();
export const getPrintGeneratorStatus = () => process.env.PRINT_ENABLED === 'false' ? disabledStatus() : singleton.getStatus();
export const generatePrintPdfs = options => {
  if (process.env.PRINT_ENABLED === 'false') return Promise.reject(new Error('PDF generation is disabled'));
  return singleton.generate(options);
};
export const prunePrintGenerator = options => singleton.prune(options);
