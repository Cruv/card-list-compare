import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, truncateSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { printCardKey } from '../../src/lib/printSelection.js';

const services = vi.hoisted(() => ({ fetchCardImageUrls: vi.fn(), preparePrintImages: vi.fn(), generatePrintPdfs: vi.fn(), getPrintGeneratorStatus: vi.fn(() => ({ available: true, revision: 'fixture' })), prunePrintGenerator: vi.fn(async () => {}) }));
vi.mock('../lib/scryfallImages.js', () => ({ fetchCardImageUrls: services.fetchCardImageUrls }));
vi.mock('../lib/printQueueImages.js', () => ({ preparePrintImages: services.preparePrintImages }));
vi.mock('../lib/printGenerator.js', () => ({ generatePrintPdfs: services.generatePrintPdfs, getPrintGeneratorStatus: services.getPrintGeneratorStatus, prunePrintGenerator: services.prunePrintGenerator }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, res, next) => {
  const match = req.headers.authorization?.match(/^Bearer user-(\d+)$/);
  if (!match) return res.status(401).json({ error: 'Authentication required' });
  req.user = { userId: Number(match[1]) }; next();
} }));
let dir, db, queue, planModule, server, url, stopQueue;
const stationToken = 'station-fixture-credential-012345678901234567890123456';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

beforeEach(async () => {
  vi.clearAllMocks(); vi.resetModules();
  services.fetchCardImageUrls.mockImplementation(async cards => cards.map(card => ({ ...card,
    scryfallId: `fixture-${card.displayName}`, oracleId: `oracle-${card.displayName}`, layout: card.displayName.includes('Malakir') ? 'modal_dfc' : 'normal',
    isDFC: card.displayName.includes('Malakir'), faceNames: card.displayName.includes('Malakir') ? ['Malakir Rebirth', 'Malakir Mire'] : [card.displayName],
    imageUrls: { front: 'https://cards.scryfall.io/front.png', ...(card.displayName.includes('Malakir') ? { back: 'https://cards.scryfall.io/back.png' } : {}) }, lookupFailures: [],
  })));
  services.getPrintGeneratorStatus.mockReturnValue({ available: true, revision: 'fixture' });
  dir = mkdtempSync(join(tmpdir(), 'clc-print-routes-'));
  vi.stubEnv('DB_PATH', join(dir, 'db.sqlite'));
  vi.stubEnv('PRINT_JOBS_DIR', join(dir, 'jobs'));
  vi.stubEnv('PRINT_STATION_TOKEN', stationToken);
  vi.stubEnv('PRINT_ALLOWED_USER_IDS', '');
  vi.stubEnv('PRINT_STORAGE_MAX_MB', '10240');
  // Explicitly await the worker in tests; no background preparation races.
  const originalSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
    if (ms === 10 && callback.toString().includes('processNextPrintJob')) return { unref() {} };
    return originalSetTimeout(callback, ms, ...args);
  });
  db = await import('../db.js'); await db.initDb();
  queue = await import('../lib/printQueue.js'); planModule = await import('../lib/printQueuePlan.js');
  db.run("INSERT INTO users (username, password_hash, is_admin) VALUES ('printer', 'unused', 1)");
  db.run("INSERT INTO users (username, password_hash) VALUES ('other', 'unused')");
  for (const id of [1, 2]) {
    db.run('INSERT INTO tracked_owners (user_id, archidekt_username) VALUES (?, ?)', [id, `owner-${id}`]);
    db.run('INSERT INTO tracked_decks (user_id, tracked_owner_id, archidekt_deck_id, deck_name) VALUES (?, ?, ?, ?)', [id, id, id, `Deck ${id}`]);
    db.run("INSERT INTO deck_snapshots (tracked_deck_id, deck_text, created_at) VALUES (?, '1 Lightning Bolt (M10) [146]', '2026-01-01 00:00:00')", [id]);
  }
  services.preparePrintImages.mockImplementation(async plan => plan.cards.flatMap(card => Array.from({ length: card.quantity }, (_, index) => ({
    id: `${card.displayName}-${index}`, displayName: card.displayName,
    front: { path: join(dir, 'front.png'), sha256: hash('front'), fileName: 'images/front.png' },
    ...(card.displayName.includes('Malakir') ? { back: { path: join(dir, 'back.png'), sha256: hash('back'), fileName: 'images/back.png' } } : {}),
  }))));
  services.generatePrintPdfs.mockImplementation(async ({ cards, outputDir }) => {
    mkdirSync(outputDir, { recursive: true });
    const artifacts = [];
    for (const [id, kind, selected] of [['fronts', 'ordinary', cards.filter(card => !card.backPath)], ['double-faced', 'dfc', cards.filter(card => card.backPath)]]) {
      if (!selected.length) continue;
      const bytes = Buffer.from(`%PDF-1.4\nFixture ${id}\n%%EOF\n`), path = join(outputDir, `${id}.pdf`);
      writeFileSync(path, bytes);
      const sheets = Math.ceil(selected.length / 7);
      artifacts.push({ id, kind, path, sha256: hash(bytes), size: bytes.length, pageCount: sheets * (kind === 'dfc' ? 2 : 1), sheetCount: sheets, cardCount: selected.length, slotMap: [] });
    }
    return { revision: 'immutable-generator-revision', runtimeVersion: 'immutable-runtime-version', recipe: { id: 'household-letter-v6' }, artifacts, slots: [], images: [] };
  });
  const app = express(); app.use(express.json());
  const printRoutes = await import('./print.js');
  app.use('/api/decks', printRoutes.default);
  app.use('/api/print-lists', printRoutes.standalonePrintRouter);
  app.use('/api/print-station', (await import('./print-station.js')).default);
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  stopQueue?.(); stopQueue = null;
  server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
  vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true });
});
function request(path, { method = 'GET', body, token = 'user-1' } = {}) {
  return fetch(url + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
function preview(options = {}, user = 1, deck = user) { return planModule.buildPrintPlan(user, deck, options); }
async function create(options = {}, user = 1, deck = user) {
  const plan = await preview(options, user, deck);
  return queue.createPrintJob(user, deck, { ...options, idempotencyKey: crypto.randomUUID(), expectedPlanHash: plan.planHash });
}
async function ready(options = {}) { const { job } = await create(options); await queue.processNextPrintJob(); const result = queue.getOwnedPrintJob(1, 1, job.id); if (result.state === 'failed') throw new Error(result.error); return result; }
function station(path, method = 'GET', body) { return request(`/api/print-station${path}`, { method, body, token: stationToken }); }
function report(job, state, extras = {}) { return queue.reportPrintJob(job.id, { claimToken: job.claimToken, eventId: crypto.randomUUID(), state, ...extras }); }
function ordinary(job) { return { artifactId: 'fronts', phase: 'fronts', ...job }; }

async function packetPdfs({ cards, outputDir, batchLabel }) {
  mkdirSync(outputDir, { recursive: true });
  const fronts = cards.filter(card => !card.backPath), dfcs = cards.filter(card => card.backPath);
  const groups = fronts.length ? [{ id: 'fronts', kind: 'ordinary', cardCount: fronts.length, sheetCount: Math.ceil(fronts.length / 7), pageCount: Math.ceil(fronts.length / 7) }] : [];
  const packetCount = Math.ceil(dfcs.length / 7);
  for (let index = 1; index <= packetCount; index++) groups.push({
    id: `double-faced-${String(index).padStart(3, '0')}`, kind: 'dfc', pageCount: 2, sheetCount: 1,
    cardCount: Math.min(7, dfcs.length - (index - 1) * 7), packetIndex: index, packetCount,
    label: `${batchLabel} DFC ${index}/${packetCount}`,
  });
  return { revision: 'fixture', runtimeVersion: 'fixture', recipe: { id: 'household-letter-v6' }, slots: [], images: [],
    artifacts: groups.map(group => {
      const bytes = Buffer.from(`%PDF-1.4\n${group.id}\n%%EOF\n`), path = join(outputDir, `${group.id}.pdf`);
      writeFileSync(path, bytes);
      return { ...group, path, size: bytes.length, sha256: hash(bytes), slotMap: [] };
    }) };
}

describe('standalone print lists', () => {
  it('reviews, freezes and generates the edited order without creating a deck or snapshot', async () => {
    const body = { mode: 'adhoc', listName: 'Saturday extras', cardText: '3 Sol Ring\n30 Island\n8 Malakir Rebirth // Malakir Mire',
      excludedCards: [printCardKey({ displayName: 'Sol Ring' })], additionalCardText: '2 Sol Ring\n1 Counterspell' };
    expect((await request('/api/print-lists/plan', { method: 'POST', body, token: null })).status).toBe(401);
    const before = { decks: db.get('SELECT COUNT(*) AS count FROM tracked_decks').count, snapshots: db.get('SELECT COUNT(*) AS count FROM deck_snapshots').count };
    const response = await request('/api/print-lists/plan', { method: 'POST', body });
    expect(response.status).toBe(200);
    const { plan } = await response.json();
    expect(plan).toMatchObject({ mode: 'adhoc', deckId: null, deckName: 'Saturday extras', source: null, target: null,
      totalCopies: 11, ordinaryCopies: 3, doubleFacedCopies: 8, excludeBasicLands: true });
    expect(plan.list).toEqual({ name: 'Saturday extras', textHash: hash(body.cardText) });
    expect(plan.additionalCardText).toBeUndefined();
    const createBody = { ...body, expectedPlanHash: plan.planHash, idempotencyKey: crypto.randomUUID() };
    const created = await request('/api/print-lists/jobs', { method: 'POST', body: createBody });
    expect(created.status).toBe(202);
    const { job } = await created.json();
    expect((await request('/api/print-lists/jobs', { method: 'POST', body: createBody })).status).toBe(200);
    expect((await request('/api/print-lists/jobs', { method: 'POST', body: { ...createBody, idempotencyKey: crypto.randomUUID(), additionalCardText: '7 Sol Ring' } })).status).toBe(409);
    services.generatePrintPdfs.mockImplementationOnce(packetPdfs);
    await queue.processNextPrintJob();
    const ready = queue.getOwnedPrintJob(1, null, job.id);
    expect(ready).toMatchObject({ state: 'ready', mode: 'adhoc', deckId: null, totalCopies: 11 });
    expect(ready.artifacts.map(item => item.id)).toEqual(['fronts', 'double-faced-001', 'double-faced-002']);
    expect(ready.artifacts[1]).toMatchObject({ label: `CLC ${job.id.slice(0,8)} DFC 1/2`, frontPages: [1], backPages: [2], cardCount: 7 });
    expect(ready.artifacts[2].cardCount).toBe(1);
    const manifest = await (await request(`/api/print-lists/jobs/${job.id}/manifest`)).json();
    expect(manifest.plan.list.text).toBe(body.cardText);
    expect(manifest.plan.additionalCardText).toBe(body.additionalCardText);
    expect(manifest.copies).toHaveLength(11);
    expect(manifest.copies.filter(card => card.displayName === 'Sol Ring')).toHaveLength(2);
    expect(manifest.copies.some(card => card.displayName === 'Island')).toBe(false);
    const artifact = ready.artifacts[0];
    expect(artifact.downloadUrl).toBe(`/api/print-lists/jobs/${job.id}/artifacts/fronts`);
    const download = await request(artifact.downloadUrl);
    expect(download.status).toBe(200);
    expect(hash(Buffer.from(await download.arrayBuffer()))).toBe(artifact.sha256);
    expect((await (await request('/api/print-lists/jobs')).json()).jobs.map(item => item.id)).toEqual([job.id]);
    expect({ decks: db.get('SELECT COUNT(*) AS count FROM tracked_decks').count, snapshots: db.get('SELECT COUNT(*) AS count FROM deck_snapshots').count }).toEqual(before);
  });
  it('isolates standalone owner access and enforces the same household printing authorization', async () => {
    const { job } = await create({ mode: 'adhoc', cardText: '1 Sol Ring' }, 2, null);
    await queue.processNextPrintJob();
    for (const suffix of ['', '/manifest', '/artifacts/fronts']) {
      expect((await request(`/api/print-lists/jobs/${job.id}${suffix}`)).status).toBe(404);
      expect((await request(`/api/decks/2/print-jobs/${job.id}${suffix}`, { token: 'user-2' })).status).toBe(404);
    }
    expect((await (await request('/api/print-lists/jobs')).json()).jobs).toEqual([]);
    expect((await request(`/api/print-lists/jobs/${job.id}/queue`, { method: 'POST', token: 'user-2' })).status).toBe(403);
    expect((await request(`/api/print-lists/jobs/${job.id}/cancel`, { method: 'POST' })).status).toBe(404);
    const canceled = await request(`/api/print-lists/jobs/${job.id}/cancel`, { method: 'POST', token: 'user-2' });
    expect((await canceled.json()).job.state).toBe('canceled');
    const expired = await request(`/api/print-lists/jobs/${job.id}/artifacts`, { method: 'DELETE', token: 'user-2' });
    expect((await expired.json()).job.state).toBe('expired');
    const tracked = await ready();
    expect((await request(`/api/print-lists/jobs/${tracked.id}`)).status).toBe(404);
  });
  it('uses the existing exact-sheet refeed state machine and generic station download path', async () => {
    services.generatePrintPdfs.mockImplementationOnce(packetPdfs);
    const { job } = await create({ mode: 'adhoc', cardText: '1 Malakir Rebirth // Malakir Mire', queueOnReady: true }, 1, null);
    await queue.processNextPrintJob();
    const claimed = queue.claimPrintJob();
    expect(claimed).toMatchObject({ id: job.id, mode: 'adhoc', deckId: null, deckName: 'Print list' });
    expect(claimed.artifacts[0].downloadUrl).toBe(`/api/print-station/jobs/${job.id}/artifacts/double-faced-001`);
    const front = { artifactId: 'double-faced-001', phase: 'fronts' }, back = { artifactId: 'double-faced-001', phase: 'backs' };
    report(claimed, 'submitting', front); report(claimed, 'submitted', { ...front, spoolerId: 'fixture-1' });
    report(claimed, 'completed', { ...front, spoolerId: 'fixture-1' });
    expect(queue.getOwnedPrintJob(1, null, job.id).state).toBe('awaiting_refeed');
    expect(() => report(claimed, 'submitting', back)).toThrow();
    report(claimed, 'refeed', back);
    report(claimed, 'submitting', back); report(claimed, 'submitted', { ...back, spoolerId: 'fixture-2' });
    report(claimed, 'completed', { ...back, spoolerId: 'fixture-2' });
    expect(queue.getOwnedPrintJob(1, null, job.id).state).toBe('completed');
  });
});

 describe('immutable PDF jobs and owner access', () => {
  it('publishes exact packet labels and local front/back page ranges to owner and station', async () => {
    db.run("UPDATE deck_snapshots SET deck_text = '1 Lightning Bolt (M10) [146]\n8 Malakir Rebirth // Malakir Mire (ZNR) [111]' WHERE tracked_deck_id = 1");
    services.generatePrintPdfs.mockImplementationOnce(packetPdfs);
    const job = await ready({ queueOnReady: true });
    expect(job.artifacts.map(item => item.id)).toEqual(['fronts', 'double-faced-001', 'double-faced-002']);
    expect(job.artifacts[1]).toMatchObject({ label: `CLC ${job.id.slice(0, 8)} DFC 1/2`, packetIndex: 1, packetCount: 2, cardCount: 7, frontPages: [1], backPages: [2] });
    expect(job.artifacts[2]).toMatchObject({ sheetCount: 1, cardCount: 1, pageCount: 2 });
    const claimed = queue.claimPrintJob();
    expect(claimed.artifacts[1].label).toBe(job.artifacts[1].label);
    expect((await station(`/jobs/${job.id}/artifacts/double-faced-002`)).status).toBe(200);
    expect(claimed.steps.map(step => [step.artifactId, step.phase])).toEqual([
      ['fronts', 'fronts'], ['double-faced-001', 'fronts'], ['double-faced-001', 'backs'], ['double-faced-002', 'fronts'], ['double-faced-002', 'backs'],
    ]);
  });
  it.each([{ packetIndex: 2 }, { packetCount: 99 }, { label: 'Wrong printed sheet' }, { sheetCount: 2 }, { cardCount: 8 }])('refuses malformed generated packet metadata %j before queueing', async changes => {
    db.run("UPDATE deck_snapshots SET deck_text = '8 Malakir Rebirth // Malakir Mire (ZNR) [111]' WHERE tracked_deck_id = 1");
    services.generatePrintPdfs.mockImplementationOnce(async input => {
      const result = await packetPdfs(input); Object.assign(result.artifacts[0], changes); return result;
    });
    const { job } = await create({ queueOnReady: true }); await queue.processNextPrintJob();
    expect(queue.getOwnedPrintJob(1, 1, job.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('invalid double-sided packet') });
    expect(queue.claimPrintJob()).toBeNull();
    expect(existsSync(join(dir, 'jobs', job.id))).toBe(false);
  });
  it('automatically retains an unqueued prepared PDF as an unconfirmed ManaSync plan',async () => {
    const bridge = await import('../lib/manasyncBridge.js'); bridge.initBridgeSchema();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
    services.preparePrintImages.mockImplementation(async (plan,directory) => {
      mkdirSync(join(directory,'images'),{recursive:true});
      const fileName = `images/${hash(png)}.png`, path = join(directory,fileName);
      writeFileSync(path,png);
      return [{id:'first-copy',displayName:'Lightning Bolt',setCode:'m10',collectorNumber:'146',front:{path,fileName,
        sha256:hash(png),size:png.length,format:'png',source:'saved-mpc',identifier:'saved-front-selection',face:'front'}}];
    });
    const job = await ready();
    await vi.waitFor(() => expect(bridge.listQueue(1)).toHaveLength(1));
    expect(bridge.listQueue(1)[0]).toMatchObject({printJobId:job.id,quantity:1,confirmed:0,operations:[],pendingProxy:{status:'disconnected'}});
    expect(queue.getOwnedPrintJob(1,1,job.id).state).toBe('ready');
  });
  it('keeps a ready PDF downloadable when automatic artwork staging needs attention',async () => {
    const bridge = await import('../lib/manasyncBridge.js'); bridge.initBridgeSchema();
    const job = await ready(); // Deliberately incomplete fixture image metadata fails bridge validation.
    await vi.waitFor(() => expect(queue.getOwnedPrintJob(1,1,job.id).proxyStagingError).toContain('invalid source artwork'));
    expect(queue.getOwnedPrintJob(1,1,job.id).state).toBe('ready');
    expect((await request(job.artifacts[0].downloadUrl)).status).toBe(200);
    expect(bridge.listQueue(1)).toEqual([]);
  });
  it('requires authentication and keeps job/artifact reads within the owner and deck', async () => {
    expect((await request('/api/decks/1/print-plan', { method: 'POST', body: {}, token: null })).status).toBe(401);
    const job = await ready();
    expect((await request(`/api/decks/1/print-jobs/${job.id}`, { token: 'user-2' })).status).toBe(404);
    expect((await request(`/api/decks/2/print-jobs/${job.id}`)).status).toBe(404);
    const download = await request(job.artifacts[0].downloadUrl);
    expect(download.status).toBe(200);
    expect(download.headers.get('x-content-sha256')).toBe(job.artifacts[0].sha256);
    expect(hash(Buffer.from(await download.arrayBuffer()))).toBe(job.artifacts[0].sha256);
    expect((await station(`/jobs/${job.id}/artifacts/fronts`)).status).toBe(404); // not claimed
  });
  it('freezes preview text/art, rejects stale plans, and deduplicates request retries', async () => {
    const plan = await preview(), key = crypto.randomUUID();
    const body = { idempotencyKey: key, expectedPlanHash: plan.planHash };
    const created = await (await request('/api/decks/1/print-jobs', { method: 'POST', body })).json();
    expect(created.job.state).toBe('preparing');
    db.run("UPDATE deck_snapshots SET deck_text = '9 Counterspell' WHERE tracked_deck_id = 1");
    const repeated = await request('/api/decks/1/print-jobs', { method: 'POST', body });
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).job.id).toBe(created.job.id);
    expect((await request('/api/decks/1/print-jobs', { method: 'POST', body: { ...body, idempotencyKey: crypto.randomUUID() } })).status).toBe(409);
    db.run('DELETE FROM deck_snapshots WHERE tracked_deck_id = 1');
    await queue.processNextPrintJob();
    const manifest = queue.ownedPrintManifest(1, 1, created.job.id);
    expect(manifest.plan.target.text).toContain('Lightning Bolt');
    expect(manifest.plan.totalCopies).toBe(1);
    expect(manifest.generatorRevision).toBe('immutable-generator-revision');
    expect(db.get('SELECT COUNT(*) AS count FROM print_jobs').count).toBe(1);
  });
  it('requires a new request key for a different queue intent and prevents unauthorized physical printing', async () => {
    const plan = await preview({}, 2), key = crypto.randomUUID();
    await expect(queue.createPrintJob(2, 2, { expectedPlanHash: plan.planHash, idempotencyKey: key, queueOnReady: true })).rejects.toThrow('restricted');
    const created = await queue.createPrintJob(2, 2, { expectedPlanHash: plan.planHash, idempotencyKey: key });
    expect(created.job.state).toBe('preparing');
    await expect(queue.createPrintJob(2, 2, { expectedPlanHash: plan.planHash, idempotencyKey: key, queueOnReady: true })).rejects.toThrow('different print request');
  });
  it('rejects saved-art changes after preview', async () => {
    db.run('UPDATE tracked_decks SET mpc_art_overrides = ? WHERE id = 1', [JSON.stringify([['Lightning Bolt', { identifier: 'first-art-0123456789' }]])]);
    const plan = await preview({ artSource: 'saved-mpc' });
    db.run('UPDATE tracked_decks SET mpc_art_overrides = ? WHERE id = 1', [JSON.stringify([['Lightning Bolt', { identifier: 'second-art-0123456789' }]])]);
    await expect(queue.createPrintJob(1, 1, { artSource: 'saved-mpc', idempotencyKey: crypto.randomUUID(), expectedPlanHash: plan.planHash })).rejects.toThrow('changed after preview');
  });
  it('returns missing DFC back art in preview and refuses job creation before any download', async () => {
    db.run("UPDATE deck_snapshots SET deck_text = '2 Malakir Rebirth // Malakir Mire (ZNR) [111]' WHERE tracked_deck_id = 1");
    db.run('UPDATE tracked_decks SET mpc_art_overrides = ? WHERE id = 1', [JSON.stringify([['Malakir Rebirth', { identifier: 'selected-front-01234' }]])]);
    const response = await request('/api/decks/1/print-plan', { method: 'POST', body: { artSource: 'saved-mpc' } });
    expect(response.status).toBe(200);
    const { plan } = await response.json();
    expect(plan).toMatchObject({ readyToGenerate: false, doubleFacedCopies: 2, missingArtwork: [expect.objectContaining({ face: 'back', name: 'Malakir Mire' })] });
    expect(plan.resolvedCards[0].faces[0].thumbnailUrl).toBe('/api/mpc/thumbnail/selected-front-01234');
    const created = await request('/api/decks/1/print-jobs', { method: 'POST', body: { artSource: 'saved-mpc', expectedPlanHash: plan.planHash, idempotencyKey: crypto.randomUUID() } });
    expect(created.status).toBe(400);
    expect((await created.json()).error).toContain('Malakir Mire');
    expect(db.get('SELECT COUNT(*) AS count FROM print_jobs').count).toBe(0);
    expect(services.preparePrintImages).not.toHaveBeenCalled();
  });
  it('refuses a changed resolved Scryfall printing even when the snapshot text is identical', async () => {
    const plan = await preview();
    const resolve = services.fetchCardImageUrls.getMockImplementation();
    services.fetchCardImageUrls.mockImplementation(async cards => (await resolve(cards)).map(card => ({ ...card, scryfallId: 'different-printing' })));
    await expect(queue.createPrintJob(1, 1, { expectedPlanHash: plan.planHash, idempotencyKey: crypto.randomUUID() })).rejects.toThrow('changed after preview');
    expect(db.get('SELECT COUNT(*) AS count FROM print_jobs').count).toBe(0);
  });
  it('deduplicates concurrent creates after asynchronous artwork resolution', async () => {
    const plan = await preview();
    const resolve = services.fetchCardImageUrls.getMockImplementation();
    const pending = [];
    services.fetchCardImageUrls.mockImplementation(cards => new Promise(release => pending.push(async () => release(await resolve(cards)))));
    const input = { expectedPlanHash: plan.planHash, idempotencyKey: crypto.randomUUID() };
    const first = queue.createPrintJob(1, 1, input), second = queue.createPrintJob(1, 1, input);
    expect(pending).toHaveLength(2);
    await Promise.all(pending.map(release => release()));
    const results = await Promise.all([first, second]);
    expect(results[0].job.id).toBe(results[1].job.id);
    expect(results.map(result => result.isExisting).sort()).toEqual([false, true]);
    expect(db.get('SELECT COUNT(*) AS count FROM print_jobs').count).toBe(1);
  });
  it('does not publish or queue a preparation canceled while images are downloading', async () => {
    let release;
    services.preparePrintImages.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const { job } = await create({ queueOnReady: true });
    const worker = queue.processNextPrintJob();
    queue.cancelPrintJob(1, 1, job.id);
    release([]); await worker;
    expect(queue.getOwnedPrintJob(1, 1, job.id).state).toBe('canceled');
    expect(services.generatePrintPdfs).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'jobs', job.id))).toBe(false);
  });
  it('waits for generator initialization before downloading any images', async () => {
    services.getPrintGeneratorStatus.mockReturnValue({ available: false, updating: true });
    const { job } = await create(); await queue.processNextPrintJob();
    expect(queue.getOwnedPrintJob(1, 1, job.id).state).toBe('preparing');
    expect(services.preparePrintImages).not.toHaveBeenCalled();
    services.getPrintGeneratorStatus.mockReturnValue({ available: true, updating: false });
    await queue.processNextPrintJob();
    expect(queue.getOwnedPrintJob(1, 1, job.id).state).toBe('ready');
  });
  it('rejects tampered PDF bytes, path traversal, and oversized artifacts', async () => {
    const job = await ready();
    const row = db.get('SELECT * FROM print_jobs WHERE id = ?', [job.id]), manifest = JSON.parse(row.manifest_json);
    const artifact = manifest.artifacts[0], path = join(dir, 'jobs', job.id, artifact.fileName);
    writeFileSync(path, '%PDF-tampered');
    expect(() => queue.ownedPrintArtifact(1, 1, job.id, 'fronts')).toThrow('checksum mismatch');
    truncateSync(path, 1024 * 1024 * 1024 + 1);
    expect(() => queue.ownedPrintArtifact(1, 1, job.id, 'fronts')).toThrow('checksum mismatch');
    artifact.fileName = '../outside.pdf';
    const text = JSON.stringify(manifest);
    db.run('UPDATE print_jobs SET manifest_json = ?, manifest_sha256 = ? WHERE id = ?', [text, hash(text), job.id]);
    expect(() => queue.ownedPrintArtifact(1, 1, job.id, 'fronts')).toThrow('missing');
  });
});

describe('station submission, manual refeed, and ambiguity', () => {
  async function readyLargePacketJob() {
    db.run("UPDATE deck_snapshots SET deck_text = '1 Lightning Bolt (M10) [146]\n50 Malakir Rebirth // Malakir Mire (ZNR) [111]' WHERE tracked_deck_id = 1");
    services.generatePrintPdfs.mockImplementationOnce(packetPdfs);
    const job = await ready({ queueOnReady: true });
    expect(job.artifacts).toHaveLength(9);
    return job;
  }
  it('keeps a nine-artifact FIFO job unclaimed for an old client, then claims it for an upgraded client', async () => {
    const job = await readyLargePacketJob();
    const rowBefore = db.get('SELECT * FROM print_jobs WHERE id = ?', [job.id]);
    const manifest = JSON.parse(rowBefore.manifest_json);
    const path = join(dir, 'jobs', job.id, manifest.artifacts[0].fileName);
    const bytes = readFileSync(path);
    // A compatibility error must be returned before expensive PDF verification.
    writeFileSync(path, '%PDF-tampered');
    const oldClient = await station('/claim', 'POST', {});
    expect(oldClient.status).toBe(409);
    expect(await oldClient.json()).toMatchObject({ error: expect.stringContaining('Upgrade the Mac print companion') });
    expect(db.get('SELECT * FROM print_jobs WHERE id = ?', [job.id])).toEqual(rowBefore);
    expect(rowBefore).toMatchObject({ state: 'queued', station_id: null, claim_nonce: null });
    expect(db.get('SELECT COUNT(*) AS count FROM print_job_events').count).toBe(0);
    writeFileSync(path, bytes);
    const upgraded = await station('/claim', 'POST', { maxArtifacts: 37 });
    expect(upgraded.status).toBe(200);
    const claimed = (await upgraded.json()).job;
    expect(claimed).toMatchObject({ id: job.id, state: 'claimed' });
    expect(claimed.artifacts).toHaveLength(9);
    expect(claimed.steps.every(step => step.state === 'pending')).toBe(true);
    expect(db.get('SELECT claim_nonce FROM print_jobs WHERE id = ?', [job.id]).claim_nonce).toBeTruthy();
  });
  it.each([null, 0, 38, 8.5, '37', true, [], {}])('rejects an invalid artifact capability %j without claiming work', async maxArtifacts => {
    const job = await ready({ queueOnReady: true });
    const before = db.get('SELECT * FROM print_jobs WHERE id = ?', [job.id]);
    const response = await station('/claim', 'POST', { maxArtifacts });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('integer between 1 and 37') });
    expect(db.get('SELECT * FROM print_jobs WHERE id = ?', [job.id])).toEqual(before);
  });
  it('preserves an active physical claim when an older or paused client cannot handle its artifacts', async () => {
    const job = await readyLargePacketJob();
    const claimed = queue.claimPrintJob(); // Internal callers retain current capacity.
    report(claimed, 'submitting', ordinary());
    report(claimed, 'submitted', ordinary({ spoolerId: 'EPSON-42' }));
    const before = db.get('SELECT * FROM print_jobs WHERE id = ?', [job.id]);
    for (const paused of [0, 1]) {
      db.run("UPDATE print_station_controls SET paused = ? WHERE station_id = 'household'", [paused]);
      const oldClient = await station('/claim', 'POST', {});
      expect(oldClient.status).toBe(409);
      expect(db.get('SELECT * FROM print_jobs WHERE id = ?', [job.id])).toEqual(before);
      const upgraded = await station('/claim', 'POST', { maxArtifacts: 37 });
      expect(upgraded.status).toBe(200);
      expect((await upgraded.json()).job).toMatchObject({ id: job.id, state: 'submitted', claimToken: claimed.claimToken });
    }
    expect(db.get('SELECT * FROM print_jobs WHERE id = ?', [job.id])).toEqual(before);
  });
  it('uses the legacy capacity when an old claim request has no JSON body', async () => {
    await readyLargePacketJob();
    const oldClient = await station('/claim', 'POST');
    expect(oldClient.status).toBe(409);
    expect(await oldClient.json()).toMatchObject({ error: expect.stringContaining('supports 8') });
  });
  it('requires the scoped station credential and revalidates authorization before claiming', async () => {
    expect((await request('/api/print-station/claim', { method: 'POST', body: {}, token: 'user-1' })).status).toBe(401);
    const job = await ready({ queueOnReady: true });
    db.run('UPDATE users SET suspended = 1 WHERE id = 1');
    expect(queue.claimPrintJob()).toBeNull();
    expect(queue.getOwnedPrintJob(1, 1, job.id).state).toBe('ready');
  });
  it('keeps one FIFO claim, records intent before ack, and deduplicates reports atomically', async () => {
    const first = await ready({ queueOnReady: true });
    const second = await ready({ queueOnReady: true });
    const job = queue.claimPrintJob();
    expect(job.id).toBe(first.id);
    expect(queue.claimPrintJob().id).toBe(first.id);
    const event = { claimToken: job.claimToken, eventId: crypto.randomUUID(), state: 'submitting', artifactId: 'fronts', phase: 'fronts' };
    expect(queue.reportPrintJob(job.id, event).replayed).toBe(false);
    expect(queue.reportPrintJob(job.id, event).replayed).toBe(true);
    expect(() => queue.reportPrintJob(job.id, { ...event, state: 'completed' })).toThrow('already used');
    expect(() => report(job, 'failed', {})).toThrow('may have happened');
    report(job, 'submitted', ordinary({ spoolerId: 'Epson-42' }));
    report(job, 'completed', ordinary({ spoolerId: 'Epson-42' }));
    expect(queue.getOwnedPrintJob(1, 1, job.id).state).toBe('completed');
    expect(queue.claimPrintJob().id).toBe(second.id);
    expect(db.all('SELECT event_json FROM print_job_events').every(row => !row.event_json.includes(job.claimToken))).toBe(true);
  });
  it('holds DFC backs until explicit operator refeed and prevents other jobs interleaving', async () => {
    db.run("UPDATE deck_snapshots SET deck_text = '1 Malakir Rebirth // Malakir Mire (ZNR) [111]' WHERE tracked_deck_id = 1");
    const prepared = await ready({ queueOnReady: true });
    const job = queue.claimPrintJob();
    expect(job.artifacts[0]).toMatchObject({ kind: 'dfc', frontPages: [1], backPages: [2] });
    const front = { artifactId: 'double-faced', phase: 'fronts' }, back = { artifactId: 'double-faced', phase: 'backs' };
    expect(() => report(job, 'submitting', back)).toThrow('not eligible');
    report(job, 'submitting', front); report(job, 'submitted', { ...front, spoolerId: 'Epson-1' });
    report(job, 'completed', { ...front, spoolerId: 'Epson-1' });
    expect(queue.getOwnedPrintJob(1, 1, prepared.id).state).toBe('awaiting_refeed');
    expect(queue.claimPrintJob().id).toBe(job.id);
    expect(() => report(job, 'submitting', back)).toThrow();
    report(job, 'refeed', back); report(job, 'submitting', back);
    report(job, 'submitted', { ...back, spoolerId: 'Epson-2' }); report(job, 'completed', { ...back, spoolerId: 'Epson-2' });
    expect(queue.getOwnedPrintJob(1, 1, job.id).state).toBe('completed');
  });
  it('binds refeed reports to the exact pending back pass and never reuses a prior batch confirmation', async () => {
    db.run("UPDATE deck_snapshots SET deck_text = '8 Malakir Rebirth // Malakir Mire (ZNR) [111]' WHERE tracked_deck_id = 1");
    services.generatePrintPdfs.mockImplementationOnce(async ({ outputDir }) => {
      mkdirSync(outputDir, { recursive: true });
      const artifacts = ['fronts', 'double-faced'].map((id, index) => {
        const bytes = Buffer.from(`%PDF-1.4\nFixture ${id}\n%%EOF\n`), path = join(outputDir, `${id}.pdf`);
        writeFileSync(path, bytes);
        return { id, kind: 'dfc', path, sha256: hash(bytes), size: bytes.length, pageCount: 2, sheetCount: 1, cardCount: index ? 1 : 7, slotMap: [] };
      });
      return { revision: 'fixture', runtimeVersion: 'fixture', recipe: { id: 'household-letter-v6' }, artifacts, slots: [], images: [] };
    });
    await ready({ queueOnReady: true }); const job = queue.claimPrintJob();
    const firstFront = { artifactId: 'fronts', phase: 'fronts' }, firstBack = { artifactId: 'fronts', phase: 'backs' };
    const secondFront = { artifactId: 'double-faced', phase: 'fronts' }, secondBack = { artifactId: 'double-faced', phase: 'backs' };
    const finish = (pass, spoolerId) => {
      report(job, 'submitting', pass); report(job, 'submitted', { ...pass, spoolerId }); report(job, 'completed', { ...pass, spoolerId });
    };
    const sendRefeed = extras => station(`/jobs/${job.id}/report`, 'POST', {
      claimToken: job.claimToken, eventId: crypto.randomUUID(), state: 'refeed', ...extras,
    });
    expect((await sendRefeed(firstBack)).status).toBe(409); // fronts have not printed
    finish(firstFront, 'Epson-1');
    const before = db.get('SELECT state, steps_json FROM print_jobs WHERE id=?', [job.id]);
    for (const wrong of [{}, { artifactId: 'fronts' }, { phase: 'backs' }, firstFront, secondBack]) {
      expect((await sendRefeed(wrong)).status).toBe(409);
      expect(db.get('SELECT state, steps_json FROM print_jobs WHERE id=?', [job.id])).toEqual(before);
    }
    const original = { claimToken: job.claimToken, eventId: crypto.randomUUID(), state: 'refeed', ...firstBack };
    expect(queue.reportPrintJob(job.id, original).replayed).toBe(false);
    finish(firstBack, 'Epson-2'); finish(secondFront, 'Epson-3');
    const held = db.get('SELECT state, steps_json FROM print_jobs WHERE id=?', [job.id]);
    expect(held.state).toBe('awaiting_refeed');
    expect(queue.reportPrintJob(job.id, original).replayed).toBe(true);
    expect((await sendRefeed(firstBack)).status).toBe(409);
    expect(db.get('SELECT state, steps_json FROM print_jobs WHERE id=?', [job.id])).toEqual(held);
    expect((await sendRefeed(secondBack)).status).toBe(200);
    finish(secondBack, 'Epson-4');
    expect(queue.getOwnedPrintJob(1, 1, job.id).state).toBe('completed');
  });
  it('rejects refeed when the matching front completion is absent from a malformed recovered step list', async () => {
    db.run("UPDATE deck_snapshots SET deck_text = '1 Malakir Rebirth // Malakir Mire (ZNR) [111]' WHERE tracked_deck_id = 1");
    await ready({ queueOnReady: true }); const job = queue.claimPrintJob();
    const steps = job.steps.filter(step => step.phase === 'backs');
    db.run("UPDATE print_jobs SET state='awaiting_refeed', steps_json=? WHERE id=?", [JSON.stringify(steps), job.id]);
    expect(() => report(job, 'refeed', { artifactId: 'double-faced', phase: 'backs' })).toThrow('completed fronts');
    expect(queue.getOwnedPrintJob(1, 1, job.id).steps[0].refeedConfirmed).toBe(false);
  });
  it('turns restart after submission intent into uncertainty and requires reconciliation before retry', async () => {
    await ready({ queueOnReady: true }); const job = queue.claimPrintJob();
    report(job, 'submitting', ordinary());
    stopQueue = queue.initPrintQueue();
    expect(queue.claimPrintJob().state).toBe('uncertain');
    expect(() => report(job, 'submitting', ordinary())).toThrow('not eligible');
    expect(() => queue.cancelPrintJob(1, 1, job.id)).toThrow('spooler submission may exist');
    report(job, 'reconciled', ordinary({ resolution: 'submitted', spoolerId: 'Epson-42', detail: 'Found the matching immutable title in the spooler' }));
    report(job, 'completed', ordinary({ spoolerId: 'Epson-42' }));
    expect(queue.getOwnedPrintJob(1, 1, job.id).state).toBe('completed');
  });
  it('releases a pending claim after a printing grant is revoked, without physical submission', async () => {
    await ready({ queueOnReady: true }); const job = queue.claimPrintJob();
    db.run('UPDATE users SET suspended = 1 WHERE id = 1');
    expect(() => report(job, 'submitting', ordinary())).toThrow('authorization was revoked');
    expect(queue.claimPrintJob()).toBeNull();
    expect(queue.getOwnedPrintJob(1, 1, job.id).state).toBe('ready');
  });
  it('can explicitly abandon unknown output after an operator clears the paper, without reprinting', async () => {
    await ready({ queueOnReady: true }); const job = queue.claimPrintJob();
    report(job, 'submitting', ordinary()); report(job, 'uncertain', ordinary());
    expect(() => report(job, 'reconciled', ordinary({ resolution: 'abandoned', detail: 'Inspected printer' }))).toThrow();
    report(job, 'reconciled', ordinary({ resolution: 'abandoned', detail: 'Inspected output, stopped the spooler job and cleared the feeder', paperCleared: true }));
    expect(queue.getOwnedPrintJob(1, 1, job.id)).toMatchObject({ state: 'failed', steps: [expect.objectContaining({ state: 'failed', abandonedFrom: 'uncertain' })] });
    expect(queue.claimPrintJob()).toBeNull();
  });
  it('keeps claim identity stable when the station authentication credential rotates', async () => {
    await ready({ queueOnReady: true }); const claimed = queue.claimPrintJob();
    const replacement = 'rotated-station-credential-012345678901234567890123456';
    vi.stubEnv('PRINT_STATION_TOKEN', replacement);
    expect(() => queue.requireStationToken(stationToken)).toThrow('Invalid station credential');
    expect(() => queue.requireStationToken(replacement)).not.toThrow();
    expect(queue.claimPrintJob().claimToken).toBe(claimed.claimToken);
    expect(report(claimed, 'heartbeat').job.claimToken).toBe(claimed.claimToken);
  });
  it('holds a canceled spooler pass on the server until partial paper is explicitly cleared', async () => {
    await ready({ queueOnReady: true }); const job = queue.claimPrintJob();
    report(job, 'submitting', ordinary()); report(job, 'submitted', ordinary({ spoolerId: 'Epson-1' }));
    const failure = report(job, 'failed', ordinary({ spoolerId: 'Epson-1', detail: 'CUPS reports canceled' })).job;
    expect(failure).toMatchObject({ state: 'uncertain', steps: [expect.objectContaining({ state: 'uncertain', spoolerOutcome: 'failed' })] });
    expect(queue.claimPrintJob().id).toBe(job.id);
    report(job, 'reconciled', ordinary({ resolution: 'abandoned', detail: 'Inspected partial pages and cleared the printer', paperCleared: true }));
    expect(queue.claimPrintJob()).toBeNull();
  });
  it('requires a live lease before submission but can renew an expired claim safely', async () => {
    await ready({ queueOnReady: true }); const job = queue.claimPrintJob();
    db.run("UPDATE print_jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [job.id]);
    expect(() => report(job, 'submitting', ordinary())).toThrow('lease expired');
    report(job, 'heartbeat'); expect(report(job, 'submitting', ordinary()).job.state).toBe('submitting');
  });
});

describe('print storage, deletion, and durable transactions', () => {
  it('expires ready artifacts after seven days while retaining manifests and active jobs', async () => {
    const old = await ready(), active = await ready({ queueOnReady: true });
    db.run("UPDATE print_jobs SET expires_at = '2000-01-01T00:00:00.000Z'");
    queue.cleanupPrintArtifacts();
    expect(queue.getOwnedPrintJob(1, 1, old.id).state).toBe('expired');
    expect(queue.ownedPrintManifest(1, 1, old.id).jobId).toBe(old.id);
    expect(existsSync(join(dir, 'jobs', old.id))).toBe(false);
    expect(queue.getOwnedPrintJob(1, 1, active.id).state).toBe('queued');
    expect(existsSync(join(dir, 'jobs', active.id))).toBe(true);
  });
  it('refreshes retention after a long queued job finishes and retains its exact generator runtime', async () => {
    await ready({ queueOnReady: true }); const job = queue.claimPrintJob();
    db.run("UPDATE print_jobs SET created_at = '2000-01-01T00:00:00.000Z', expires_at = '2000-01-08T00:00:00.000Z'");
    report(job, 'submitting', ordinary()); report(job, 'submitted', ordinary({ spoolerId: 'Epson-1' }));
    const completed = report(job, 'completed', ordinary({ spoolerId: 'Epson-1' })).job;
    expect(Date.parse(completed.expiresAt)).toBeGreaterThan(Date.now() + 6 * 86400000);
    queue.cleanupPrintArtifacts(); await Promise.resolve();
    expect(queue.getOwnedPrintJob(1, 1, job.id).state).toBe('completed');
    expect(services.prunePrintGenerator).toHaveBeenLastCalledWith({ retainVersions: ['immutable-runtime-version'] });
  });
  it('enforces total storage quota before a worker or image download begins', async () => {
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    const large = join(dir, 'jobs', 'sparse-test'); writeFileSync(large, ''); truncateSync(large, 9 * 1024 * 1024 * 1024);
    await expect(create()).rejects.toThrow('5 GiB working allowance');
    expect(services.preparePrintImages).not.toHaveBeenCalled();
  });
  it('waits to prune generator runtimes during an update, then retains live manifest versions', async () => {
    await ready(); services.prunePrintGenerator.mockClear();
    services.getPrintGeneratorStatus.mockReturnValue({ available: true, updating: true });
    queue.cleanupPrintArtifacts(); await Promise.resolve();
    expect(services.prunePrintGenerator).not.toHaveBeenCalled();
    services.getPrintGeneratorStatus.mockReturnValue({ available: true, updating: false });
    queue.cleanupPrintArtifacts(); await Promise.resolve();
    expect(services.prunePrintGenerator).toHaveBeenCalledWith({ retainVersions: ['immutable-runtime-version'] });
  });
  it('gives the generator only the output budget remaining after immutable source staging', async () => {
    const prepare = services.preparePrintImages.getMockImplementation();
    services.preparePrintImages.mockImplementation(async (plan, jobDirectory) => {
      mkdirSync(join(jobDirectory, 'images'), { recursive: true });
      const path = join(jobDirectory, 'images', 'source.png'); writeFileSync(path, ''); truncateSync(path, 1100 * 1024 * 1024);
      return prepare(plan);
    });
    await ready();
    expect(services.generatePrintPdfs).toHaveBeenCalledWith(expect.objectContaining({ maxOutputBytes: queue.MAX_PRINT_JOB_BYTES - 1101 * 1024 * 1024 }));
  });
  it('blocks account deletion during unresolved submission then purges safe private history', async () => {
    await ready({ queueOnReady: true }); const job = queue.claimPrintJob();
    report(job, 'submitting', ordinary());
    expect(() => queue.purgeUserPrintJobs(1)).toThrow('Reconcile active print');
    report(job, 'reconciled', ordinary({ resolution: 'completed', spoolerId: 'Epson-1', detail: 'Verified completed spooler job' }));
    queue.purgeUserPrintJobs(1);
    expect(db.all('SELECT * FROM print_jobs')).toEqual([]);
    expect(db.all('SELECT * FROM print_job_events')).toEqual([]);
    expect(existsSync(join(dir, 'jobs', job.id))).toBe(false);
  });
  it('restores in-memory state if atomic database persistence fails', () => {
    const before = readFileSync(join(dir, 'db.sqlite'));
    mkdirSync(join(dir, 'db.sqlite.tmp'));
    expect(() => db.runTransaction([{ sql: "UPDATE users SET username = 'must-rollback' WHERE id = 1" }])).toThrow();
    expect(db.get('SELECT username FROM users WHERE id = 1').username).toBe('printer');
    expect(readFileSync(join(dir, 'db.sqlite'))).toEqual(before);
  });
  it('rolls back a failed event transaction in memory and on disk', () => {
    const before = readFileSync(join(dir, 'db.sqlite'));
    expect(() => db.runTransaction([
      { sql: "UPDATE users SET username = 'must-rollback' WHERE id = 1" },
      { sql: 'INSERT INTO missing_table VALUES (1)' },
    ])).toThrow();
    expect(db.get('SELECT username FROM users WHERE id = 1').username).toBe('printer');
    expect(readFileSync(join(dir, 'db.sqlite'))).toEqual(before);
  });
});
