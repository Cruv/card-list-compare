import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPrintGenerator } from './printGenerator.js';

function fixture() {
  const version = { revision: 'a'.repeat(40), adapterHash: 'b'.repeat(64) };
  const release = vi.fn();
  const runtime = { getStatus: () => version, capture: () => ({ ...version, directory: '/fixture', release }) };
  const bytes = Buffer.from('%PDF-1.4\n%%EOF\n');
  const run = vi.fn(async (_python, [_adapter, action, input]) => {
    expect(action).toBe('proof');
    const request = JSON.parse(await fs.readFile(input, 'utf8'));
    await fs.writeFile(path.join(request.directory, 'sheet.pdf'), bytes);
  });
  return { generator: createPrintGenerator({ runtime, run }), version, run, release, bytes };
}

describe('exact paper proof recipe', () => {
  it('describes all paper layouts and scopes confirmation to precise settings and revision', () => {
    const { generator, version } = fixture();
    const choices = ['letter', 'a4', 'crowned-a4', 'crowned-a4-portrait-six', 'crowned-a4-landscape', 'dahle-a4-punch'];
    const proofs = choices.map(paper => generator.describeProof(paper, 'on'));
    expect(new Set(proofs.map(proof => proof.key)).size).toBe(6);
    expect(proofs.map(proof => proof.cardsPerSheet)).toEqual([7, 7, 9, 6, 8, 9]);
    expect(proofs[3]).toMatchObject({ paper: 'a4', preset: choices[3], crop: '1mm', trim: [63, 88], bleed: { mode: 'layout-gutters' } });
    expect(proofs[5]).toMatchObject({ paper: 'a4', preset: choices[5], crop: null, registrationMarks: false, bleed: { mode: 'trim', millimeters: 1 } });
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
});
