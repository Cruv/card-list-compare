import express from 'express';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ describe: vi.fn(), download: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, res, next) => {
  if (req.headers.authorization !== 'Bearer fixture-session') return res.sendStatus(401);
  next();
} }));
vi.mock('../lib/printGenerator.js', () => ({ describePrintProof: mock.describe, downloadPrintProof: mock.download }));

import router from './print-proofs.js';

it.each([
  ['no-marks', undefined], ['die-alignment', 'dahleAlignmentMarks'], ['dahle-cut-guides', 'dahleCutGuides'],
])('requires a session and the exact reviewed Dahle recipe for %s', async (suffix, guide) => {
  vi.clearAllMocks();
  const proof = { key: 'proof-key', recipeId: 'household-dahle-a4-punch-v1', registrationMarks: false, revision: '0123456789abcde',
    ...(guide ? { [guide]: true } : {}) };
  const alignment = guide === 'dahleAlignmentMarks' ? 'on' : undefined;
  const cutGuides = guide === 'dahleCutGuides' ? 'on' : undefined;
  const query = guide ? `&${guide}=on` : '';
  const pdf = Buffer.from('%PDF-1.4\n%%EOF');
  mock.describe.mockReturnValue(proof);
  mock.download.mockImplementation(async (_paper, _marks, key, requestedAlignment, requestedCutGuides) => {
    if (key !== proof.key || requestedAlignment !== alignment || requestedCutGuides !== cutGuides) {
      throw Object.assign(new Error('This proof recipe changed. Refresh the proof details.'), { status: 409 });
    }
    return { proof, pdf };
  });
  const app = express();
  app.use('/api/print-proofs', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const route = `http://127.0.0.1:${server.address().port}/api/print-proofs/dahle-a4-punch`;
  const options = { headers: { Authorization: 'Bearer fixture-session' } };
  try {
    expect((await fetch(route)).status).toBe(401);
    expect((await fetch(`${route}/pdf?key=${proof.key}`)).status).toBe(401);
    expect(mock.describe).not.toHaveBeenCalled();
    expect(mock.download).not.toHaveBeenCalled();
    const described = await fetch(`${route}?marks=off${query}`, options);
    expect(await described.json()).toEqual({ proof });
    expect(mock.describe).toHaveBeenCalledWith('dahle-a4-punch', 'off', alignment, cutGuides);
    expect((await fetch(`${route}/pdf?key=older`, options)).status).toBe(409);
    const downloaded = await fetch(`${route}/pdf?marks=off&key=${proof.key}${query}`, options);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-disposition')).toBe(`attachment; filename="household-dahle-a4-punch-v1-${suffix}-0123456789ab-proof.pdf"`);
    expect(downloaded.headers.get('cache-control')).toContain('private, no-store');
    expect(downloaded.headers.get('x-clc-proof-key')).toBe(proof.key);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(pdf);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
