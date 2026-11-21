import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPrintGenerator } from './printGenerator.js';

function fixture() {
  const version = { revision: 'a'.repeat(40), adapterHash: 'b'.repeat(64) };
  const release = vi.fn();
  const runtime = { getStatus: () => version, capture: () => ({ ...version, directory: '/fixture', release }) };
  const bytes = Buffer.from('%PDF-1.4\n%%EOF\n');
  const requests = [];
  const run = vi.fn(async (_python, [_adapter, action, input]) => {
    expect(action).toBe('proof');
    const request = JSON.parse(await fs.readFile(input, 'utf8'));
    requests.push(request);
    await fs.writeFile(path.join(request.directory, 'sheet.pdf'), bytes);
    await fs.writeFile(path.join(request.directory, 'result.json'), JSON.stringify({
      ...(request.dahleAlignmentMarks ? { dahleAlignmentMarks: true } : {}), ...(request.dahleCutGuides ? { dahleCutGuides: true } : {}) }));
  });
  return { generator: createPrintGenerator({ runtime, run }), version, run, release, bytes, requests };
}

describe('exact paper proof recipe', () => {
  it('describes all paper layouts and scopes confirmation to precise settings and revision', () => {
    const { generator, version } = fixture();
    const choices = ['letter', 'a4', 'crowned-a4', 'crowned-a4-portrait-six', 'crowned-a4-landscape', 'dahle-a4-punch', 'dahle-letter-punch'];
    const proofs = choices.map(paper => generator.describeProof(paper, 'on'));
    expect(new Set(proofs.map(proof => proof.key)).size).toBe(choices.length);
    expect(proofs.map(proof => proof.cardsPerSheet)).toEqual([7, 7, 9, 6, 8, 9, 9]);
    expect(proofs[3]).toMatchObject({ paper: 'a4', preset: choices[3], crop: '1mm', trim: [63, 88], bleed: { mode: 'layout-gutters' } });
    expect(proofs[5]).toMatchObject({ paper: 'a4', preset: choices[5], crop: null, registrationMarks: false, bleed: { mode: 'trim', millimeters: 1.5 } });
    expect(proofs[6]).toMatchObject({ recipeId: 'household-dahle-letter-punch-v1', paper: 'letter', preset: choices[6],
      crop: null, registrationMarks: false, trim: [63, 88], bleed: { mode: 'trim', millimeters: 1.5 } });
    expect(generator.describeProof(choices[5], 'off').key).toBe(proofs[5].key);
    expect(generator.describeProof(choices[3], 'off').key).not.toBe(proofs[3].key);
    version.adapterHash = 'c'.repeat(64);
    expect(generator.describeProof(choices[3], 'on').key).not.toBe(proofs[3].key);
    expect(() => generator.describeProof('__proto__', 'on')).toThrow('Unknown proof paper');
    expect(() => generator.describeProof('letter', 'arbitrary')).toThrow('registration marks');
  });

  it('coalesces one-sheet renders and refuses an old proof after runtime changes', async () => {
    const { generator, version, run, release, bytes } = fixture();
    const proof = generator.describeProof('letter', 'on');
    const current = generator.downloadProof('letter', 'on', proof.key);
    const repeat = generator.downloadProof('letter', 'on', proof.key);
    const other = generator.describeProof('a4', 'off');
    await expect(generator.downloadProof('a4', 'off', other.key)).rejects.toMatchObject({ status: 429 });
    for (const result of await Promise.all([current, repeat])) expect(result).toEqual({ proof, pdf: bytes });
    await expect(generator.downloadProof('letter', 'on', proof.key)).resolves.toEqual({ proof, pdf: bytes });
    expect(run).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    version.revision = 'e'.repeat(40);
    await expect(generator.downloadProof('letter', 'on', proof.key)).rejects.toMatchObject({ status: 409 });
    const changed = generator.describeProof('letter', 'on');
    await expect(generator.downloadProof('letter', 'on', changed.key)).resolves.toEqual({ proof: changed, pdf: bytes });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('binds Dahle proof keys to the optional alignment marks and checks the PDF worker applied them', async () => {
    const { generator, requests, bytes, run } = fixture();
    const dahle = 'dahle-a4-punch';
    const legacy = generator.describeProof(dahle, 'on');
    expect(legacy).not.toHaveProperty('dahleAlignmentMarks');
    expect(generator.describeProof(dahle, 'off', 'off')).toEqual(legacy);
    const marked = generator.describeProof(dahle, 'off', 'on');
    expect(marked).toMatchObject({ recipeId: legacy.recipeId, registrationMarks: false, dahleAlignmentMarks: true });
    expect(marked.key).not.toBe(legacy.key);
    expect(() => generator.describeProof('letter', 'off', 'on')).toThrow('require a Dahle layout');
    expect(() => generator.describeProof(dahle, 'off', 'true')).toThrow('whether to include Dahle alignment marks');
    await expect(generator.downloadProof(dahle, 'on', legacy.key, 'on')).rejects.toMatchObject({ status: 409 });
    await expect(generator.downloadProof(dahle, 'on', marked.key)).rejects.toMatchObject({ status: 409 });
    const simulateIgnoringMarks = run.getMockImplementation();
    run.mockImplementationOnce(async (...args) => {
      await simulateIgnoringMarks(...args);
      await fs.writeFile(path.join(requests.at(-1).directory, 'result.json'), '{}');
    });
    await expect(generator.downloadProof(dahle, 'off', marked.key, 'on')).rejects.toThrow('did not confirm the requested Dahle alignment marks');
    await expect(generator.downloadProof(dahle, 'off', marked.key, 'on')).resolves.toEqual({ proof: marked, pdf: bytes });
    await expect(generator.downloadProof(dahle, 'off', legacy.key)).resolves.toEqual({ proof: legacy, pdf: bytes });
    expect(requests.at(-2)).toMatchObject({ registrationMarks: false, dahleAlignmentMarks: true });
    expect(requests.at(-1)).not.toHaveProperty('dahleAlignmentMarks');
  });

  it('refuses an unmarked proof when the worker reports adding alignment marks', async () => {
    const { generator, run, requests, bytes } = fixture();
    const dahle = 'dahle-a4-punch';
    const unmarked = generator.describeProof(dahle, 'off');
    const render = run.getMockImplementation();
    run.mockImplementationOnce(async (...args) => {
      await render(...args);
      await fs.writeFile(path.join(requests.at(-1).directory, 'result.json'), '{"dahleAlignmentMarks":true}');
    });
    await expect(generator.downloadProof(dahle, 'off', unmarked.key)).rejects.toThrow('did not confirm the requested Dahle alignment marks');
    await expect(generator.downloadProof(dahle, 'off', unmarked.key)).resolves.toEqual({ proof: unmarked, pdf: bytes });
  });

  it('binds Dahle guides to distinct proofs and rejects keys for the previous bleed', async () => {
    const { generator, run, requests, bytes } = fixture();
    const dahle = 'dahle-a4-punch';
    const plain = generator.describeProof(dahle, 'off');
    const legacy = generator.describeProof(dahle, 'off', 'on');
    const guided = generator.describeProof(dahle, 'off', undefined, 'on');
    await expect(generator.downloadProof(dahle, 'off', '10ed2f45fb620d9a486e1b320f96d50177595a22dc5de2b64af2ca14831aea4c'))
      .rejects.toMatchObject({ status: 409 });
    await expect(generator.downloadProof(dahle, 'off', 'c80b1c57a938f7a3590aefbf7bb3c79ece827fb490cd37149559bed00995c2f5', 'on'))
      .rejects.toMatchObject({ status: 409 });
    expect(generator.describeProof(dahle, 'off', 'on', 'off')).toEqual(legacy);
    expect(generator.describeProof(dahle, 'off', 'off', 'off')).toEqual(plain);
    expect(guided).toMatchObject({ recipeId: legacy.recipeId, registrationMarks: false, dahleCutGuides: true });
    expect(guided).not.toHaveProperty('dahleAlignmentMarks');
    expect(new Set([plain.key, legacy.key, guided.key]).size).toBe(3);
    expect(() => generator.describeProof('letter', 'off', 'off', 'on')).toThrow('require a Dahle layout');
    expect(() => generator.describeProof(dahle, 'off', 'on', 'on')).toThrow('Choose one Dahle guide style');
    expect(() => generator.describeProof(dahle, 'off', 'off', 'true')).toThrow('whether to include Dahle cut guides');
    await expect(generator.downloadProof(dahle, 'off', legacy.key, undefined, 'on')).rejects.toMatchObject({ status: 409 });
    await expect(generator.downloadProof(dahle, 'off', guided.key, 'on')).rejects.toMatchObject({ status: 409 });
    const render = run.getMockImplementation();
    run.mockImplementationOnce(async (...args) => {
      await render(...args);
      await fs.writeFile(path.join(requests.at(-1).directory, 'result.json'), '{"dahleCornerGuides":true}');
    });
    await expect(generator.downloadProof(dahle, 'off', guided.key, 'off', 'on')).rejects.toThrow('did not confirm the requested Dahle cut guides');
    await expect(generator.downloadProof(dahle, 'off', guided.key, 'off', 'on')).resolves.toEqual({ proof: guided, pdf: bytes });
    expect(requests.at(-1)).toMatchObject({ registrationMarks: false, dahleCutGuides: true });
    expect(requests.at(-1)).not.toHaveProperty('dahleAlignmentMarks');
    await expect(generator.downloadProof(dahle, 'off', legacy.key, 'on')).resolves.toEqual({ proof: legacy, pdf: bytes });
  });

  it('keeps guided Letter Dahle proof downloads separate from A4 and plain Letter', async () => {
    const { generator, requests, bytes } = fixture();
    const preset = 'dahle-letter-punch';
    const guided = generator.describeProof(preset, 'off', 'off', 'on');
    const unmarked = generator.describeProof(preset, 'off');
    const a4 = generator.describeProof('dahle-a4-punch', 'off', 'off', 'on');
    const standardLetter = generator.describeProof('letter', 'off');
    for (const proof of [unmarked, a4, standardLetter]) {
      await expect(generator.downloadProof(preset, 'off', proof.key, 'off', 'on')).rejects.toMatchObject({ status: 409 });
    }
    expect(requests).toEqual([]);
    await expect(generator.downloadProof(preset, 'off', guided.key, 'off', 'on')).resolves.toEqual({ proof: guided, pdf: bytes });
    expect(requests[0]).toMatchObject({ paperSize: 'letter', printPreset: preset, proofRecipe: 'household-dahle-letter-punch-v1',
      registrationMarks: false, dahleCutGuides: true });
  });
});
