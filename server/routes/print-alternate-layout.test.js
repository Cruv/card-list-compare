import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import express from 'express';

const fixtures = vi.hoisted(() => ({ render: vi.fn(), liveArtwork: vi.fn(), lookup: vi.fn(), recover: vi.fn() }));
vi.mock('../lib/printGenerator.js', async original => ({ ...await original(), generatePrintPdfs: fixtures.render,
  getPrintGeneratorStatus: () => ({ available: true }), prunePrintGenerator: async () => {} }));
vi.mock('../lib/printQueueImages.js', async original => ({ ...await original(), preparePrintImages: fixtures.liveArtwork }));
vi.mock('../lib/scryfallImages.js', async original => ({ ...await original(), fetchCardImageUrls: fixtures.lookup,
  fetchFrozenScryfallImage: fixtures.recover }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, res, next) => {
  const match = req.headers.authorization?.match(/^Bearer owner-(\d+)$/);
  if (!match) return res.status(401).json({ error: 'Authentication required' });
  req.user = { userId: Number(match[1]) };
  next();
} }));

const stationToken = 'disposable-print-station-credential-1234';
const letter = { paperSize: 'letter' };
const crowned = { paperSize: 'a4', printPreset: 'crowned-a4-portrait-six', registrationMarks: false };
const dahle = { paperSize: 'a4', printPreset: 'dahle-a4-punch', registrationMarks: true };
const digest = value => createHash('sha256').update(value).digest('hex');
let directory, db, queue, listener, origin;

function png(color) {
  const chunk = (type, content) => {
    const bytes = Buffer.alloc(12 + content.length);
    bytes.writeUInt32BE(content.length);
    bytes.write(type, 4);
    content.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4);
    return bytes;
  };
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, color, 25, 80]))), chunk('IEND', Buffer.alloc(0))]);
}

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  directory = mkdtempSync(join(tmpdir(), 'clc-alternate-layout-http-'));
  vi.stubEnv('DB_PATH', join(directory, 'fixture.sqlite'));
  vi.stubEnv('PRINT_JOBS_DIR', join(directory, 'jobs'));
  vi.stubEnv('PRINT_STATION_TOKEN', stationToken);
  const originalTimer = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
    if (ms === 10 && callback.toString().includes('processNextPrintJob')) return { unref() {} };
    return originalTimer(callback, ms, ...args);
  });
  db = await import('../db.js');
  await db.initDb();
  db.run("INSERT INTO users (username, password_hash, is_admin) VALUES ('fixture-owner', 'unused', 1), ('fixture-other', 'unused', 0)");
  db.run("INSERT INTO tracked_owners (user_id, archidekt_username) VALUES (1, 'fixture-owner'), (2, 'fixture-other')");
  db.run("INSERT INTO tracked_decks (user_id, tracked_owner_id, archidekt_deck_id, deck_name) VALUES (1, 1, 1, 'Live fixture deck'), (2, 2, 2, 'Other deck')");
  queue = await import('../lib/printQueue.js');
  const generator = await import('../lib/printGenerator.js');
  fixtures.liveArtwork.mockRejectedValue(new Error('Alternate jobs must not use the current artwork path'));
  fixtures.lookup.mockResolvedValue([]);
  fixtures.recover.mockRejectedValue(new Error('Synthetic provider has no more bytes'));
  fixtures.render.mockImplementation(async input => {
    const recipe = input.printPreset === dahle.printPreset ? generator.DAHLE_A4_RECIPE
      : input.printPreset === crowned.printPreset ? generator.CROWNED_A4_PORTRAIT_SIX_RECIPE : generator.PRINT_RECIPE;
    const groups = generator.planPrintSheets(input.cards, recipe, input.sheetPacking);
    mkdirSync(input.outputDir, { recursive: true });
    const image = file => ({ sha256: digest(readFileSync(file)) });
    return { revision: 'fixture', recipe, slots: groups.flatMap(group => group.slotMap),
      ...(input.dahleAlignmentMarks ? { dahleAlignmentMarks: true } : {}),
      ...(input.dahleCutGuides ? { dahleCutGuides: true } : {}),
      images: input.cards.map(card => ({ id: card.id, front: image(card.frontPath), ...(card.backPath ? { back: image(card.backPath) } : {}) })),
      artifacts: groups.map(group => {
      const bytes = Buffer.from(`%PDF-1.4\n${input.batchLabel} ${group.id}\n%%EOF`);
      const path = join(input.outputDir, `${group.id}.pdf`);
      writeFileSync(path, bytes);
      const sheetCount = group.chunks.length;
      const { packetIndex, packetCount, doubleFacedCardCount } = group;
      return { id: group.id, kind: group.kind, path, size: bytes.length, sha256: digest(bytes), sheetCount,
        pageCount: sheetCount * (group.kind === 'dfc' ? 2 : 1), cardCount: group.cards.length,
        ...(packetIndex ? { packetIndex, packetCount, doubleFacedCardCount, label: `${input.batchLabel} DFC ${packetIndex}/${packetCount}` } : {}) };
    }) };
  });
  const routes = await import('./print.js');
  const app = express().use(express.json());
  app.use('/api/decks', routes.default);
  app.use('/api/print-lists', routes.standalonePrintRouter);
  app.use('/api/print-station', (await import('./print-station.js')).default);
  listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  origin = `http://127.0.0.1:${listener.address().port}`;
});

afterEach(async () => {
  listener?.closeAllConnections();
  if (listener) await new Promise(resolve => listener.close(resolve));
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const rowFor = id => db.get('SELECT * FROM print_jobs WHERE id = ?', [id]);
const eventsFor = id => db.all('SELECT * FROM print_job_events WHERE job_id = ?', [id]);
function post(path, body, authorization = 'Bearer owner-1') {
  return fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) }, body: JSON.stringify(body) });
}

function frozenBatch({ deckId = 1, state = 'backs_pending' } = {}) {
  const id = randomUUID(), jobPath = join(directory, 'jobs', id);
  mkdirSync(join(jobPath, 'images'), { recursive: true });
  const face = (kind, color) => {
    const bytes = png(color), sha256 = digest(bytes), fileName = `images/${sha256}.png`;
    writeFileSync(join(jobPath, fileName), bytes);
    return { face: kind, source: 'scryfall', identifier: 'fixture-artwork', fileName, sha256, format: 'png', size: bytes.length };
  };
  const single = { displayName: 'Lightning Bolt', setCode: 'm10', collectorNumber: '146', scryfallId: 'legacy-print-one', front: face('front', 20) };
  const double = { displayName: 'Malakir Rebirth', setCode: 'znr', collectorNumber: '111', scryfallId: 'legacy-print-two', front: face('front', 40), back: face('back', 50) };
  const copies = [...Array.from({ length: 8 }, () => single), double].map((copy, index) => ({ ...copy, id: `copy-${index}` }));
  const cards = [{ displayName: single.displayName, setCode: single.setCode, collectorNumber: single.collectorNumber, quantity: 8 },
    { displayName: double.displayName, setCode: double.setCode, collectorNumber: double.collectorNumber, quantity: 1 }];
  const plan = { version: 2, deckName: 'Frozen fixture cards', mode: deckId ? 'full' : 'adhoc', totalCopies: 9,
    ordinaryCopies: 8, doubleFacedCopies: 1, artSource: 'scryfall', sheetPacking: 'double-faced-first', cards,
    resolvedCards: cards.map((card, index) => ({ ...card, scryfallId: index ? double.scryfallId : single.scryfallId, isDFC: !!index })),
    source: null, target: deckId ? { id: 1, textHash: digest('original frozen cards'), text: 'Original frozen cards', createdAt: '2026-11-01T12:00:00.000Z' } : null,
    ...(deckId === null ? { list: { name: 'Frozen fixture cards', text: 'Original frozen cards', textHash: digest('original frozen cards') } } : {}) };
  const originalPdf = Buffer.from('%PDF-1.4\nImmutable original receipt\n%%EOF');
  writeFileSync(join(jobPath, 'original.pdf'), originalPdf);
  const artifact = { id: 'double-faced-001', kind: 'dfc', pageCount: 2, sheetCount: 1, cardCount: 7,
    fileName: 'original.pdf', size: originalPdf.length, sha256: digest(originalPdf) };
  const manifest = { version: 1, jobId: id, requesterId: 1, plan, copies, artifacts: [artifact], recipe: { id: 'household-letter-v6' } };
  const json = JSON.stringify(manifest), manifestHash = digest(json);
  writeFileSync(join(jobPath, 'manifest.json'), json);
  const at = '2026-11-01T12:00:00.000Z', steps = [{ artifactId: artifact.id, phase: 'fronts', state: 'completed', spoolerId: 'EPSON-42', completedAt: at },
    { artifactId: artifact.id, phase: 'backs', state: 'pending', requiresRefeed: true, refeedConfirmed: false }];
  const backRequest = { id: randomUUID(), artifactId: artifact.id, requestedAt: at };
  db.run(`INSERT INTO print_jobs (id,user_id,tracked_deck_id,request_key,request_hash,plan_json,state,created_at,updated_at,
    manifest_json,manifest_sha256,steps_json,workflow,claim_nonce,station_id,back_request_json,expires_at)
    VALUES (?,1,?,?,?,?,?,?,?,?,?,?,'deferred-backs-v1','original-claim','household',?,?)`,
  [id, deckId, randomUUID(), 'original', JSON.stringify(plan), state, at, at, json, manifestHash,
    JSON.stringify(steps), JSON.stringify(backRequest), state === 'ready' || state === 'expired' ? at : null]);
  db.run(`INSERT INTO print_job_events (job_id,event_id,request_hash,event_json,created_at) VALUES (?,?,?,?,?)`,
    [id, randomUUID(), 'original-intent', JSON.stringify({ state: 'completed', artifactId: artifact.id, spoolerId: 'EPSON-42' }), at]);
  return { id, jobPath, manifest, manifestHash, originalPdf, back: double.back,
    api: `${deckId === null ? '/api/print-lists/jobs' : `/api/decks/${deckId}/print-jobs`}/${id}/alternate-layout` };
}

async function review(batch, layout) {
  const response = await post(`${batch.api}/preview`, layout);
  const result = await response.json();
  expect(response.status, result.error).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  return result;
}

describe('alternate layout from immutable print receipts', () => {
  it('reviews the exact tracked copies and creates one PDF-only batch before an explicit supported queue request', async () => {
    const original = frozenBatch();
    const before = rowFor(original.id), events = eventsFor(original.id);
    db.run("INSERT INTO deck_snapshots(tracked_deck_id, deck_text) VALUES (1,'1 Counterspell (ICE) [64]')");
    const read = await review(original, crowned);
    expect(read).toMatchObject({ sourceJobId: original.id, sourceManifestSha256: original.manifestHash, artworkFailures: [],
      layout: { frontSheets: 2, backSheets: 1 }, plan: { totalCopies: 9, ordinaryCopies: 8, doubleFacedCopies: 1,
        target: { textHash: original.manifest.plan.target.textHash }, cards: original.manifest.plan.cards, readyToGenerate: true, registrationMarks: false } });
    expect(JSON.stringify(read)).not.toContain('1 Counterspell');
    const input = { ...crowned, idempotencyKey: randomUUID(), expectedPlanHash: read.plan.planHash };
    expect((await post(original.api, { ...input, registrationMarks: true })).status).toBe(409);
    expect((await post(original.api, { ...input, queueOnReady: true })).status).toBe(400);
    const retries = await Promise.all([post(original.api, input), post(original.api, input)]);
    expect(retries.map(response => response.status).sort()).toEqual([200, 202]);
    const results = await Promise.all(retries.map(response => response.json()));
    const job = results[0].job;
    expect(job).toMatchObject({ state: 'preparing', queueOnReady: false, ...crowned,
      alternateLayoutOf: { id: original.id, manifestSha256: original.manifestHash } });
    expect(results[1].job.id).toBe(job.id);
    expect(job.id).not.toBe(original.id);
    expect(await queue.claimPrintJob()).toBeNull();
    await queue.processNextPrintJob();
    const prepared = queue.getOwnedPrintJob(1, 1, job.id);
    expect(prepared).toMatchObject({ state: 'ready', queueOnReady: false });
    const newManifest = queue.ownedPrintManifest(1, 1, job.id);
    expect(newManifest.copies).toEqual(original.manifest.copies);
    expect(newManifest.alternateLayoutOf).toEqual(job.alternateLayoutOf);
    expect(db.all('SELECT * FROM print_queue_notifications WHERE job_id = ?', [job.id])).toEqual([]);
    expect(eventsFor(job.id)).toEqual([]);
    expect(fixtures.liveArtwork).not.toHaveBeenCalled();
    expect(fixtures.lookup).not.toHaveBeenCalled();
    expect(fixtures.recover).not.toHaveBeenCalled();
    const heartbeat = { version: '2.65.0', paused: false, queue: 'EPSON', recipeVerified: true, duplexVerified: true,
      recipeFingerprint: 'f'.repeat(64), health: { ok: true, known: true, message: 'Fixture only' }, deferredBacks: true,
      loadedPaperSize: 'a4', loadedPrintPreset: crowned.printPreset, supportedRecipeIds: [prepared.recipeId] };
    expect((await post('/api/print-station/heartbeat', heartbeat, `Bearer ${stationToken}`)).status).toBe(200);
    const queued = await post(`/api/decks/1/print-jobs/${job.id}/queue`, {});
    expect(queued.status).toBe(200);
    expect(await queued.json()).toMatchObject({ job: { id: job.id, state: 'queued' } });
    expect(rowFor(original.id)).toEqual(before);
    expect(eventsFor(original.id)).toEqual(events);
    expect(readFileSync(join(original.jobPath, 'original.pdf'))).toEqual(original.originalPdf);
    expect(readFileSync(join(original.jobPath, 'manifest.json'), 'utf8')).toBe(before.manifest_json);
  });

  it('rebuilds an expired standalone source from byte-identical retained artwork and keeps Dahle PDF-only', async () => {
    const original = frozenBatch({ deckId: null, state: 'expired' });
    const before = rowFor(original.id);
    const retained = join(directory, 'manasync-artwork', '1');
    mkdirSync(retained, { recursive: true });
    for (const copy of original.manifest.copies) for (const face of [copy.front, copy.back].filter(Boolean)) {
      writeFileSync(join(retained, `${face.sha256}.png`), readFileSync(join(original.jobPath, face.fileName)));
    }
    rmSync(original.jobPath, { recursive: true });
    const read = await review(original, dahle);
    expect(read).toMatchObject({ layout: { frontSheets: 1, backSheets: 1 }, artworkFailures: [], plan: { registrationMarks: false } });
    const response = await post(original.api, { ...dahle, expectedPlanHash: read.plan.planHash, idempotencyKey: randomUUID() });
    expect(response.status).toBe(202);
    const { job } = await response.json();
    await queue.processNextPrintJob();
    const ready = queue.getOwnedPrintJob(1, null, job.id);
    expect(ready).toMatchObject({ state: 'ready', printPreset: dahle.printPreset, registrationMarks: false });
    expect(queue.ownedPrintManifest(1, null, job.id).copies).toEqual(original.manifest.copies);
    expect((await fetch(origin + ready.artifacts[0].downloadUrl, { headers: { Authorization: 'Bearer owner-1' } })).status).toBe(200);
    expect((await post(`/api/print-lists/jobs/${job.id}/queue`, {})).status).toBe(409);
    expect(rowFor(original.id)).toEqual(before);
    expect(existsSync(original.jobPath)).toBe(false);
    expect(fixtures.recover).not.toHaveBeenCalled();

    const nestedApi = `/api/print-lists/jobs/${job.id}/alternate-layout`;
    const nested = await review({ api: nestedApi }, letter);
    const child = await post(nestedApi, { ...letter, expectedPlanHash: nested.plan.planHash, idempotencyKey: randomUUID() });
    expect(await child.json()).toMatchObject({ job: { alternateLayoutOf: { id: job.id, manifestSha256: ready.manifestSha256 }, confirmationJobId: original.id } });
  });

  it('preserves the source and fails generation if a verified paired face disappears after the review', async () => {
    const original = frozenBatch({ state: 'ready' });
    const before = rowFor(original.id);
    const read = await review(original, letter);
    const input = { ...letter, expectedPlanHash: read.plan.planHash, idempotencyKey: randomUUID() };
    const response = await post(original.api, input);
    expect(response.status).toBe(202);
    const { job } = await response.json();
    rmSync(join(original.jobPath, original.back.fileName));
    await queue.processNextPrintJob();
    expect(queue.getOwnedPrintJob(1, 1, job.id)).toMatchObject({ state: 'failed', artifacts: [],
      error: expect.stringContaining('Malakir Rebirth, back: Exact artwork could not be recovered') });
    expect(fixtures.render).not.toHaveBeenCalled();
    const blocked = await review(original, letter);
    expect(blocked.plan.readyToGenerate).toBe(false);
    expect(blocked.plan).not.toHaveProperty('planHash');
    expect(blocked.artworkFailures).toEqual([expect.objectContaining({ displayName: 'Malakir Rebirth', face: 'back' })]);
    expect(blocked.plan.resolvedCards[1].faces).toMatchObject([{ face: 'front', status: 'ready' }, { face: 'back', status: 'error' }]);
    const retry = await post(original.api, input);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ job: { id: job.id, state: 'failed' }, isExisting: true });
    expect(rowFor(original.id)).toEqual(before);
    expect(existsSync(join(original.jobPath, 'original.pdf'))).toBe(true);
  });

  it.each(['dahleAlignmentMarks', 'dahleCutGuides'])('binds %s to a Dahle alternate and keeps it out of the next unmarked layout', async guide => {
    const original = frozenBatch();
    const before = rowFor(original.id);
    const off = await review(original, dahle);
    const explicitOff = await review(original, { ...dahle, [guide]: false });
    expect(explicitOff.plan.planHash).toBe(off.plan.planHash);
    expect(explicitOff.plan).not.toHaveProperty(guide);
    const on = { ...dahle, [guide]: true };
    const marked = await review(original, on);
    expect(marked.plan).toMatchObject({ [guide]: true, recipeId: off.plan.recipeId });
    expect(marked.plan.planHash).not.toBe(off.plan.planHash);
    const create = { idempotencyKey: randomUUID(), expectedPlanHash: marked.plan.planHash };
    expect((await post(original.api, { ...dahle, ...create })).status).toBe(409);
    const response = await post(original.api, { ...on, ...create });
    expect(response.status).toBe(202);
    const { job } = await response.json();
    expect((await post(original.api, { ...on, ...create })).status).toBe(200);
    expect((await post(`${original.api}/preview`, { ...letter, [guide]: true })).status).toBe(400);
    expect((await post(`${original.api}/preview`, { ...dahle, dahleAlignmentMarks: true, dahleCutGuides: true })).status).toBe(400);
    await queue.processNextPrintJob();
    expect(queue.getOwnedPrintJob(1, 1, job.id)).toMatchObject({ state: 'ready', [guide]: true, registrationMarks: false });
    expect(queue.ownedPrintManifest(1, 1, job.id).copies).toEqual(original.manifest.copies);
    expect(rowFor(original.id)).toEqual(before);
    const next = await review({ api: `/api/decks/1/print-jobs/${job.id}/alternate-layout` }, letter);
    expect(next.plan).not.toHaveProperty(guide);
  });

  it('fails the alternate batch if the generator reads different valid artwork bytes after staging', async () => {
    const original = frozenBatch();
    const before = rowFor(original.id);
    const render = fixtures.render.getMockImplementation();
    fixtures.render.mockImplementationOnce(input => {
      writeFileSync(input.cards.find(card => card.backPath).backPath, png(177));
      return render(input);
    });
    const read = await review(original, crowned);
    const response = await post(original.api, { ...crowned, idempotencyKey: randomUUID(), expectedPlanHash: read.plan.planHash });
    expect(response.status).toBe(202);
    const { job } = await response.json();
    await queue.processNextPrintJob();
    expect(queue.getOwnedPrintJob(1, 1, job.id)).toMatchObject({ state: 'failed', artifacts: [],
      error: 'Cannot regenerate PDFs. Malakir Rebirth, back: the staged artwork changed during PDF generation' });
    expect(rowFor(original.id)).toEqual(before);
    expect(digest(readFileSync(join(original.jobPath, original.back.fileName)))).toBe(original.back.sha256);
  });

  it('fails an accepted alternate layout if the saved target recipe is no longer current', async () => {
    const original = frozenBatch();
    const before = rowFor(original.id);
    const read = await review(original, crowned);
    const response = await post(original.api, { ...crowned, idempotencyKey: randomUUID(), expectedPlanHash: read.plan.planHash });
    expect(response.status).toBe(202);
    const { job } = await response.json();
    const row = rowFor(job.id), previous = { ...JSON.parse(row.plan_json), targetRecipeId: 'superseded-recipe' };
    db.run('UPDATE print_jobs SET plan_json = ? WHERE id = ?', [JSON.stringify(previous), job.id]);
    await queue.processNextPrintJob();
    expect(queue.getOwnedPrintJob(1, 1, job.id)).toMatchObject({ state: 'failed', artifacts: [],
      error: 'The selected paper recipe changed. Open the source batch and review the layout again.' });
    expect(fixtures.render).not.toHaveBeenCalled();
    expect(rowFor(original.id)).toEqual(before);
  });

  it('uses exact saved variants in a legacy review and marks only the unavailable copy group', async () => {
    const original = frozenBatch();
    const missingBytes = png(88), sha256 = digest(missingBytes);
    const manifest = original.manifest;
    delete manifest.plan.resolvedCards;
    manifest.copies[1].front = { ...manifest.copies[1].front, sha256, size: missingBytes.length, fileName: `images/${sha256}.png` };
    const json = JSON.stringify(manifest);
    db.run('UPDATE print_jobs SET manifest_json = ?, manifest_sha256 = ? WHERE id = ?', [json, digest(json), original.id]);
    const result = await review(original, letter);
    expect(result.plan.readyToGenerate).toBe(false);
    expect(result.plan.resolvedCards.filter(card => card.displayName === 'Lightning Bolt')).toMatchObject([
      { quantity: 7, setCode: 'm10', collectorNumber: '146', faces: [{ face: 'front', status: 'ready' }] },
      { quantity: 1, setCode: 'm10', collectorNumber: '146', faces: [{ face: 'front', status: 'error' }] },
    ]);
  });

  it('replays a saved request for a retired layout while rejecting newly requested copies', async () => {
    const original = frozenBatch();
    const id = randomUUID(), idempotencyKey = randomUUID(), expectedPlanHash = digest('previous review'), timestamp = new Date().toISOString();
    const request = { paperSize: 'a4', registrationMarks: false, idempotencyKey, expectedPlanHash };
    const savedPlan = { ...original.manifest.plan, paperSize: 'a4', registrationMarks: false, sourceManifestSha256: original.manifestHash };
    const requestHash = digest(JSON.stringify({ type: 'alternate-layout', deckId: 1, sourceJobId: original.id,
      expectedPlanHash, paperSize: 'a4', registrationMarks: false }));
    db.run(`INSERT INTO print_jobs (id,user_id,tracked_deck_id,request_key,request_hash,plan_json,created_at,updated_at,source_job_id)
      VALUES (?,1,1,?,?,?,?,?,?)`, [id, idempotencyKey, requestHash, JSON.stringify(savedPlan), timestamp, timestamp, original.id]);
    const replay = await post(original.api, request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ job: { id, paperSize: 'a4', alternateLayoutOf: { id: original.id } }, isExisting: true });
    expect((await post(original.api, { ...request, idempotencyKey: randomUUID() })).status).toBe(400);
  });

  it('enforces authentication, exact deck and owner scope, and a complete immutable source', async () => {
    const original = frozenBatch();
    const foreign = 'Bearer owner-2';
    expect((await post(`${original.api}/preview`, letter, null)).status).toBe(401);
    expect((await post(`${original.api}/preview`, letter, foreign)).status).toBe(404);
    expect((await post(original.api, { ...letter, expectedPlanHash: 'f'.repeat(64), idempotencyKey: randomUUID() }, foreign)).status).toBe(404);
    expect((await post(`${original.api.replace('/decks/1/', '/decks/2/')}/preview`, letter)).status).toBe(404);
    expect((await post(`/api/print-lists/jobs/${original.id}/alternate-layout/preview`, letter)).status).toBe(404);
    expect((await post(`${original.api}/preview`, { paperSize: 'a4' })).status).toBe(400);
    db.run('UPDATE print_jobs SET manifest_json = NULL WHERE id = ?', [original.id]);
    const unavailable = await post(`${original.api}/preview`, letter);
    expect(unavailable.status).toBe(409);
    expect((await unavailable.json()).error).toContain('no saved artwork manifest');
  });
});
