import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DAHLE_A4_PRESET, dahleAlignmentMarksEnabled } from './printPaper.js';

const proofError = (message, status) => Object.assign(new Error(message), { status });
const maxProofBytes = 8 * 1024 * 1024;
const maxCachedProofs = 4;

export function createPrintProofs(runtime, run, recipes) {
  const completed = new Map();
  let pending = null;
  let cachedRevision;

  function describe(paper, marks, alignmentMarks = 'off') {
    if (typeof paper !== 'string' || !Object.hasOwn(recipes, paper)) throw proofError('Unknown proof paper preset', 404);
    if (marks !== 'on' && marks !== 'off') throw proofError('Choose whether to include Cameo registration marks', 400);
    if (alignmentMarks !== 'on' && alignmentMarks !== 'off') throw proofError('Choose whether to include Dahle alignment marks', 400);
    const recipe = recipes[paper];
    const dahleAlignmentMarks = dahleAlignmentMarksEnabled(recipe.printPreset, alignmentMarks === 'on');
    const version = runtime.getStatus();
    if (!version.revision || !version.adapterHash) throw proofError('The PDF generator is still getting ready', 503);
    const dahle = recipe.printPreset === DAHLE_A4_PRESET;
    const settings = { recipeId: recipe.id, paper: recipe.paperSize, preset: recipe.printPreset ?? null,
      template: recipe.template, registrationMarks: !dahle && marks === 'on', crop: recipe.crop ?? null,
      bleed: dahle ? { mode: 'trim', millimeters: recipe.bleedMm } : { mode: 'layout-gutters' },
      trim: [63, 88], cardsPerSheet: recipe.cardsPerSheet, revision: version.revision, adapterHash: version.adapterHash,
      ...(dahleAlignmentMarks ? { dahleAlignmentMarks } : {}) };
    return { ...settings, key: createHash('sha256').update(JSON.stringify(settings)).digest('hex') };
  }

  async function render(captured, proof) {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'clc-paper-proof-'));
    try {
      const input = path.join(directory, 'proof.json');
      await fs.writeFile(input, JSON.stringify({ directory, paperSize: proof.paper, printPreset: proof.preset ?? undefined,
        registrationMarks: proof.registrationMarks, proofRecipe: proof.recipeId,
        proofRevision: `${proof.revision.slice(0, 12)}/${proof.adapterHash.slice(0, 8)}`,
        source: path.join(captured.directory, 'source'), ...(proof.dahleAlignmentMarks ? { dahleAlignmentMarks: true } : {}) }));
      await run(path.join(captured.directory, 'venv/bin/python'), [path.join(captured.directory, 'adapter.py'), 'proof', input],
        { timeout: 110_000, env: { MPLCONFIGDIR: path.join(directory, 'matplotlib') } });
      const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
      if ((result.dahleAlignmentMarks ?? false) !== (proof.dahleAlignmentMarks === true)) {
        throw new Error('The active PDF generator did not confirm the requested Dahle alignment marks for this proof');
      }
      const file = path.join(directory, 'sheet.pdf');
      const { size } = await fs.stat(file);
      if (!size || size > maxProofBytes) throw new Error('Proof PDF exceeded its one-sheet size limit');
      return await fs.readFile(file);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  return {
    describe,
    async download(paper, marks, key, alignmentMarks) {
      const current = describe(paper, marks, alignmentMarks);
      if (key !== current.key) throw proofError('This proof recipe changed. Refresh the proof details.', 409);
      const revision = `${current.revision}:${current.adapterHash}`;
      if (cachedRevision !== revision) {
        completed.clear();
        cachedRevision = revision;
      }
      if (completed.has(key)) return { proof: current, pdf: completed.get(key) };
      if (pending?.key === key) return { proof: current, pdf: await pending.pdf };
      if (pending) throw proofError('Another paper proof is being prepared. Try again shortly.', 429);
      const captured = runtime.capture();
      const pdf = render(captured, current).then(bytes => {
        if (cachedRevision === revision) {
          if (completed.size >= maxCachedProofs) completed.delete(completed.keys().next().value);
          completed.set(key, bytes);
        }
        return bytes;
      }).finally(() => {
        captured.release?.();
        pending = null;
      });
      pending = { key, pdf };
      return { proof: current, pdf: await pdf };
    },
    async waitForPending() {
      await pending?.pdf.catch(() => {});
    },
  };
}
