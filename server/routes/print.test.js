import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, truncateSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { printCardKey } from '../../src/lib/printSelection.js';

const services = vi.hoisted(() => ({ fetchCardImageUrls: vi.fn(), preparePrintImages: vi.fn(), generatePrintPdfs: vi.fn(), getPrintGeneratorStatus: vi.fn(() => ({ available: true, revision: 'fixture' })), prunePrintGenerator: vi.fn(async () => {}) }));
vi.mock('../lib/printPdfHash.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, hashPrintPdf: vi.fn(actual.hashPrintPdf) };
});
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
    front: { path: join(dir, 'front.png'), sha256: hash('front'), fileName: 'images/front.png', source: 'scryfall' },
    ...(card.displayName.includes('Malakir') ? { back: { path: join(dir, 'back.png'), sha256: hash('back'), fileName: 'images/back.png', source: 'scryfall' } } : {}),
  }))));
  services.generatePrintPdfs.mockImplementation(async input => {
    const { cards, outputDir, paperSize, sheetPacking } = input;
    const recipe = paperSize === 'a4' ? { id: 'household-a4-v5', paperSize } : { id: 'household-letter-v6' };
    if (sheetPacking) return { ...await packetPdfs(input), recipe };
    mkdirSync(outputDir, { recursive: true });
    const artifacts = [];
    for (const [id, kind, selected] of [['fronts', 'ordinary', cards.filter(card => !card.backPath)], ['double-faced', 'dfc', cards.filter(card => card.backPath)]]) {
      if (!selected.length) continue;
      const bytes = Buffer.from(`%PDF-1.4\nFixture ${id}\n%%EOF\n`), path = join(outputDir, `${id}.pdf`);
      writeFileSync(path, bytes);
      const sheets = Math.ceil(selected.length / 7);
      artifacts.push({ id, kind, path, sha256: hash(bytes), size: bytes.length, pageCount: sheets * (kind === 'dfc' ? 2 : 1), sheetCount: sheets, cardCount: selected.length, slotMap: [] });
    }
    return { revision: 'immutable-generator-revision', runtimeVersion: 'immutable-runtime-version', recipe, artifacts, slots: [], images: [] };
  });
  const app = express(); app.use(express.json());
  const printRoutes = await import('./print.js');
  app.use('/api/decks', printRoutes.default);
  app.use('/api/print-lists', printRoutes.standalonePrintRouter);
  app.use('/api/print-batches', printRoutes.printBatchesRouter);
  app.use('/api/print-downloads', printRoutes.printDownloadsRouter);
  app.use('/api/print-station', (await import('./print-station.js')).default);
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  stopQueue?.(); stopQueue = null;
  server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
  vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true });
});
function request(path, { method = 'GET', body, token = 'user-1', headers = {} } = {}) {
  return fetch(url + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
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

async function holdVerifiedPdf() {
  const { hashPrintPdf } = await import('../lib/printPdfHash.js');
  const realHash = hashPrintPdf.getMockImplementation();
  const verified = Promise.withResolvers(), resume = Promise.withResolvers();
  hashPrintPdf.mockImplementationOnce(async (...args) => {
    const result = await realHash(...args);
    verified.resolve();
    await resume.promise;
    return result;
  });
  return { verified: verified.promise, release: resume.resolve };
}

describe('private browser PDF downloads', () => {
  async function issue(artifactUrl, token, filename = 'Fixture [fronts].pdf') {
    return request(`${artifactUrl}/download`, { method: 'POST', token, body: { filename } });
  }

  it.each(['deck', 'standalone'])('streams exact bytes once to the owner with a scoped cookie (%s)', async scope => {
    let job;
    if (scope === 'deck') job = await ready();
    else {
      const result = await create({ mode: 'adhoc', cardText: '1 Lightning Bolt' }, 1, null);
      await queue.processNextPrintJob();
      job = queue.getOwnedPrintJob(1, null, result.job.id);
    }
    const [{ downloadUrl, size, sha256 }] = job.artifacts;
    expect((await issue(downloadUrl, 'user-2')).status).toBe(404);
    expect((await issue(downloadUrl, '')).status).toBe(401);
    const ticket = await issue(downloadUrl, 'user-1');
    expect(ticket.status).toBe(200);
    const { url: grantedUrl } = await ticket.json();
    expect(grantedUrl).toMatch(/^\/api\/print-downloads\/[a-f0-9-]+$/);
    const setCookie = ticket.headers.get('set-cookie');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Max-Age=60');
    expect(setCookie).toContain(`Path=${grantedUrl}`);
    expect(ticket.headers.get('cache-control')).toContain('no-store');
    expect((await request(grantedUrl, { token: 'user-2' })).status).toBe(404);
    const navigation = { token: '', headers: { cookie: setCookie.split(';')[0] } };
    expect((await request(grantedUrl, { ...navigation, method: 'HEAD' })).status).toBe(405);
    const downloaded = await request(grantedUrl, navigation);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-disposition')).toBe('attachment; filename="Fixture _fronts_.pdf"');
    expect(downloaded.headers.get('content-length')).toBe(String(size));
    expect(downloaded.headers.get('cache-control')).toContain('no-store');
    expect(downloaded.headers.get('x-content-sha256')).toBe(sha256);
    expect(hash(Buffer.from(await downloaded.arrayBuffer()))).toBe(sha256);
    expect((await request(grantedUrl, navigation)).status).toBe(404);
  });

  it('rejects expired grants and artifacts corrupted or removed after issuance', async () => {
    const job = await ready();
    const [{ downloadUrl }] = job.artifacts;
    const ticket = await request(`${downloadUrl}/download`, { method: 'POST', body: { reportStatus: true } });
    const { url: grantedUrl, reportStatus } = await ticket.json();
    expect(reportStatus).toBe(true);
    const expired = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    expect((await request(grantedUrl, { token: '', headers: { cookie: ticket.headers.get('set-cookie').split(';')[0] } })).status).toBe(404);
    expired.mockRestore();
    expect(await (await request(`${grantedUrl}/status`)).json()).toEqual({
      state: 'failed', error: 'PDF download expired. Start it again from the batch.',
    });

    const nextTicket = await issue(downloadUrl, 'user-1');
    const next = await nextTicket.json();
    const artifact = await queue.ownedPrintArtifact(1, 1, job.id, 'fronts');
    const altered = readFileSync(artifact.path);
    altered[9] ^= 1;
    writeFileSync(artifact.path, altered);
    expect((await request(next.url, { token: '', headers: { cookie: nextTicket.headers.get('set-cookie').split(';')[0] } })).status).toBe(409);

    const lastTicket = await issue(downloadUrl, 'user-1');
    const last = await lastTicket.json();
    queue.expireOwnedPrintArtifacts(1, 1, job.id);
    expect((await request(last.url, { token: '', headers: { cookie: lastTicket.headers.get('set-cookie').split(';')[0] } })).status).toBe(410);
    expect((await issue(downloadUrl, 'user-1')).status).toBe(410);
  });

  it.each(['available', 'missing', 'changed', 'expired'])('reports the actual attachment result for an %s PDF', async state => {
    const job = await ready();
    const [{ downloadUrl, sha256 }] = job.artifacts;
    const artifact = await queue.ownedPrintArtifact(1, 1, job.id, 'fronts');
    const ticket = await request(`${downloadUrl}/download`, { method: 'POST', body: { reportStatus: true } });
    expect(ticket.status).toBe(200);
    const { url: grantedUrl } = await ticket.json();
    const receiptUrl = `${grantedUrl}/status`;
    const navigation = { token: '', headers: { cookie: ticket.headers.get('set-cookie').split(';')[0] } };
    expect((await request(receiptUrl, navigation)).status).toBe(401);
    expect((await request(receiptUrl, { token: 'user-2' })).status).toBe(404);
    expect(await (await request(receiptUrl)).json()).toEqual({ state: 'pending' });

    if (state === 'missing') unlinkSync(artifact.path);
    if (state === 'changed') {
      const bytes = readFileSync(artifact.path);
      bytes[9] ^= 1;
      writeFileSync(artifact.path, bytes);
    }
    if (state === 'expired') queue.expireOwnedPrintArtifacts(1, 1, job.id);
    const attachment = await request(grantedUrl, navigation);
    expect(attachment.status).toBe({ available: 200, missing: 410, changed: 409, expired: 410 }[state]);
    expect(attachment.headers.get('cache-control')).toContain('no-store');
    const bytes = Buffer.from(await attachment.arrayBuffer());
    expect((await request(grantedUrl, navigation)).status).toBe(404);
    const receipt = await request(receiptUrl);
    expect(receipt.headers.get('cache-control')).toBe('private, no-store');
    const result = await receipt.json();
    if (state === 'available') {
      expect(result).toEqual({ state: 'started' });
      expect(hash(bytes)).toBe(sha256);
    } else {
      expect(result).toEqual({ state: 'failed', error: expect.stringMatching(state === 'changed' ? /changed.*Refresh batches/ : /missing or expired.*Refresh batches/) });
    }
  });
});

describe('saving print artwork to the current deck', () => {
  const path = '/api/decks/1/print-art';
  const selectedId = 'd4bf245e-c849-4bcd-a243-1ce92f82fce5';
  const oldKey = printCardKey({ displayName: 'Lightning Bolt', setCode: 'm10', collectorNumber: '146' });
  const newKey = printCardKey({ displayName: 'Lightning Bolt', setCode: 'plst', collectorNumber: 'M10-146' });
  const lookup = (cards, printingDetails = {}) => cards.map(card => ({
    ...card, oracleId: 'lightning-bolt-oracle', scryfallId: card.requestedScryfallId || 'fixture-original',
    layout: 'normal', lookupFailures: [], printingDetails: { setCode: 'plst', collectorNumber: 'M10-146', paper: true, language: 'en', ...printingDetails },
  }));
  function reviewed() {
    const row = db.get('SELECT id, deck_text FROM deck_snapshots WHERE tracked_deck_id = 1 ORDER BY created_at DESC, id DESC LIMIT 1');
    return { targetSnapshotId: row.id, targetTextHash: hash(row.deck_text), selectionKey: oldKey, scryfallId: selectedId, includeSideboard: false };
  }
  const submit = (body, token) => request(path, { method: 'POST', body, token });

  it('saves the exact printing as a new version while preserving the physical marker, source base, and existing job', async () => {
    const original = '2 Lightning Bolt (M10) [146] *F*\n1 Lightning Bolt (A25) [141]\n\n# Sideboard\n1 Lightning Bolt (M10) [146]';
    db.run('UPDATE deck_snapshots SET deck_text = ? WHERE id = 1', [original]);
    db.run('UPDATE tracked_decks SET paper_snapshot_id = 1 WHERE id = 1');
    db.run('INSERT INTO deck_source_sync (deck_id, revision, base_text, base_raw_text) VALUES (1, 2, ?, ?)', [original, original]);
    const { job } = await create();
    const frozenBatch = db.get('SELECT * FROM print_jobs WHERE id = ?', [job.id]);
    services.fetchCardImageUrls.mockImplementationOnce(async cards => lookup(cards));
    const response = await submit(reviewed());
    expect(response.status).toBe(201);
    const saved = await response.json();
    expect(saved).toMatchObject({ snapshot: { nickname: 'Print artwork' }, selectionKey: newKey, changed: true });
    expect(db.get('SELECT deck_text FROM deck_snapshots WHERE id = ?', [saved.snapshot.id]).deck_text).toBe(
      '2 Lightning Bolt (plst) [M10-146] *F*\n1 Lightning Bolt (A25) [141]\n\n# Sideboard\n1 Lightning Bolt (M10) [146]',
    );
    expect(db.get('SELECT deck_text FROM deck_snapshots WHERE id = 1').deck_text).toBe(original);
    expect(db.get('SELECT paper_snapshot_id FROM tracked_decks WHERE id = 1').paper_snapshot_id).toBe(1);
    expect(db.get('SELECT base_text, revision FROM deck_source_sync WHERE deck_id = 1')).toEqual({ base_text: original, revision: 2 });
    expect(db.get('SELECT * FROM print_jobs WHERE id = ?', [job.id])).toEqual(frozenBatch);
    expect((await preview()).cards).toEqual(expect.arrayContaining([expect.objectContaining({ setCode: 'plst', collectorNumber: 'M10-146', quantity: 2 })]));
  });

  it('checks ownership and exact current version before starting the lookup', async () => {
    const body = reviewed();
    expect((await submit(body, 'user-2')).status).toBe(404);
    expect((await submit(body, null)).status).toBe(401);
    expect((await submit({ ...body, targetTextHash: '0'.repeat(64) })).status).toBe(409);
    expect((await submit({ ...body, selectionKey: printCardKey({ name: 'Sol Ring' }) })).status).toBe(409);
    db.run('INSERT INTO deck_snapshots (tracked_deck_id, deck_text) VALUES (1, ?)', ['1 Sol Ring']);
    expect((await submit(body)).status).toBe(409);
    expect(services.fetchCardImageUrls).not.toHaveBeenCalled();
  });

  it('rechecks the current version after the lookup to avoid overwriting a racing edit', async () => {
    const body = reviewed();
    services.fetchCardImageUrls.mockImplementationOnce(async cards => {
      db.run('INSERT INTO deck_snapshots (tracked_deck_id, deck_text) VALUES (1, ?)', ['1 Sol Ring']);
      return lookup(cards);
    });
    const response = await submit(body);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/review the latest/i);
    expect(db.all('SELECT deck_text FROM deck_snapshots WHERE tracked_deck_id = 1 ORDER BY id').map(row => row.deck_text))
      .toEqual(['1 Lightning Bolt (M10) [146]', '1 Sol Ring']);
  });

  it.each([
    { oracleId: 'different-oracle' },
    { scryfallId: 'fixture-other' },
    { printingDetails: { paper: false, language: 'en', setCode: 'plst', collectorNumber: 'M10-146' } },
    { printingDetails: { paper: true, language: 'ja', setCode: 'plst', collectorNumber: 'M10-146' } },
    { printingDetails: { paper: true, language: 'en', setCode: 'plst', collectorNumber: '146!' } },
  ])('rejects a selected printing that fails validation (%j)', async invalid => {
    services.fetchCardImageUrls.mockImplementationOnce(async cards => {
      const [oldPrinting, newPrinting] = lookup(cards);
      return [oldPrinting, { ...newPrinting, ...invalid }];
    });
    expect((await submit(reviewed())).status).toBe(422);
    expect(db.all('SELECT id FROM deck_snapshots WHERE tracked_deck_id = 1')).toEqual([{ id: 1 }]);
  });

  it('preserves a supported promo collector mark when saving the exact printing', async () => {
    services.fetchCardImageUrls.mockImplementationOnce(async cards => lookup(cards, { collectorNumber: '146★' }));
    const response = await submit(reviewed());
    expect(response.status).toBe(201);
    const { snapshot, selectionKey } = await response.json();
    expect(selectionKey).toBe(printCardKey({ name: 'Lightning Bolt', setCode: 'plst', collectorNumber: '146★' }));
    expect(db.get('SELECT deck_text FROM deck_snapshots WHERE id = ?', [snapshot.id]).deck_text).toBe('1 Lightning Bolt (plst) [146★]');
    expect((await preview()).cards).toEqual([expect.objectContaining({ setCode: 'plst', collectorNumber: '146★' })]);
  });

  it('keeps the existing version when the selected printing is already present', async () => {
    services.fetchCardImageUrls.mockImplementationOnce(async cards => lookup(cards, { setCode: 'm10', collectorNumber: '146' }));
    const response = await submit(reviewed());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ snapshot: { id: 1 }, selectionKey: oldKey, changed: false });
    expect(db.all('SELECT id FROM deck_snapshots WHERE tracked_deck_id = 1')).toEqual([{ id: 1 }]);
  });

  it('pins the selected printing even if a foil-only row already resolves to it by name', async () => {
    db.run('UPDATE deck_snapshots SET deck_text = ? WHERE id = 1', ['1 Lightning Bolt *F*']);
    services.fetchCardImageUrls.mockImplementationOnce(async cards => lookup(cards).map(card => ({ ...card, scryfallId: selectedId })));
    const response = await submit({ ...reviewed(), selectionKey: printCardKey({ name: 'Lightning Bolt' }) });
    expect(response.status).toBe(201);
    const { snapshot, selectionKey } = await response.json();
    expect(selectionKey).toBe(newKey);
    expect(db.get('SELECT deck_text FROM deck_snapshots WHERE id = ?', [snapshot.id]).deck_text).toBe('1 Lightning Bolt (plst) [M10-146] *F*');
  });

  const alternateKey = printCardKey({ name: 'Lightning Bolt', setCode: 'a25', collectorNumber: '141' });
  const alternateId = 'f0cf245e-c849-4bcd-a243-1ce92f82fce5';
  const thirdId = 'a3bf245e-c849-4bcd-a243-1ce92f82fce5';
  const originalBulkText = '2 Lightning Bolt (M10) [146] *F*\n1 Lightning Bolt (A25) [141]\n3 Lightning Bolt (PLST) [M10-146]';
  function reviewedBulk() {
    db.run('UPDATE deck_snapshots SET deck_text = ? WHERE id = 1', [originalBulkText]);
    const { selectionKey, scryfallId, ...review } = reviewed();
    return { ...review, choices: [
      { selectionKey, scryfallId },
      { selectionKey: alternateKey, scryfallId: alternateId },
      { selectionKey: newKey, scryfallId: thirdId },
    ] };
  }
  function lookupBulk(cards) {
    const destinations = new Map([
      [selectedId, { setCode: 'a25', collectorNumber: '141' }],
      [alternateId, { setCode: 'plst', collectorNumber: 'M10-146' }],
      [thirdId, { setCode: 'm10', collectorNumber: '146' }],
    ]);
    return cards.flatMap(card => lookup([card], destinations.get(card.requestedScryfallId)));
  }

  it('saves three cyclic artwork choices in one deck version using their original row keys', async () => {
    const body = reviewedBulk();
    services.fetchCardImageUrls.mockImplementationOnce(async cards => lookupBulk(cards));
    const response = await submit(body);
    expect(response.status).toBe(201);
    const saved = await response.json();
    expect(saved).toMatchObject({ changed: true, choices: [
      { previousSelectionKey: oldKey, selectionKey: alternateKey, scryfallId: selectedId },
      { previousSelectionKey: alternateKey, selectionKey: newKey, scryfallId: alternateId },
      { previousSelectionKey: newKey, selectionKey: oldKey, scryfallId: thirdId },
    ] });
    expect(services.fetchCardImageUrls).toHaveBeenCalledTimes(1);
    expect(db.all('SELECT deck_text FROM deck_snapshots WHERE tracked_deck_id = 1 ORDER BY id').map(row => row.deck_text))
      .toEqual([originalBulkText, '2 Lightning Bolt (a25) [141] *F*\n1 Lightning Bolt (plst) [M10-146]\n3 Lightning Bolt (m10) [146]']);
    expect((await submit(body)).status).toBe(409);
    expect(db.get('SELECT count(*) AS count FROM deck_snapshots WHERE tracked_deck_id = 1').count).toBe(2);
  });

  it('rejects duplicate or absent choices before contacting Scryfall', async () => {
    const body = reviewedBulk();
    expect((await submit({ ...body, choices: [] })).status).toBe(400);
    expect((await submit({ ...body, choices: Array(251).fill(body.choices[0]) })).status).toBe(400);
    expect((await submit({ ...body, choices: [...body.choices, body.choices[0]] })).status).toBe(400);
    expect((await submit({ ...body, choices: [...body.choices, { selectionKey: printCardKey({ name: 'Sol Ring' }), scryfallId: selectedId }] })).status).toBe(409);
    expect(services.fetchCardImageUrls).not.toHaveBeenCalled();
    expect(db.get('SELECT count(*) AS count FROM deck_snapshots WHERE tracked_deck_id = 1').count).toBe(1);
  });

  it('writes no bulk artwork when one choice fails verification or another edit publishes a newer version', async () => {
    const body = reviewedBulk();
    services.fetchCardImageUrls.mockImplementationOnce(async cards => lookupBulk(cards).map(card =>
      card.requestedScryfallId === alternateId ? { ...card, oracleId: 'different-oracle' } : card));
    expect((await submit(body)).status).toBe(422);
    expect(db.all('SELECT deck_text FROM deck_snapshots WHERE tracked_deck_id = 1').map(row => row.deck_text)).toEqual([originalBulkText]);

    services.fetchCardImageUrls.mockImplementationOnce(async cards => {
      db.run('INSERT INTO deck_snapshots (tracked_deck_id, deck_text) VALUES (1, ?)', ['1 Sol Ring']);
      return lookupBulk(cards);
    });
    expect((await submit(body)).status).toBe(409);
    expect(db.all('SELECT deck_text FROM deck_snapshots WHERE tracked_deck_id = 1 ORDER BY id').map(row => row.deck_text))
      .toEqual([originalBulkText, '1 Sol Ring']);
  });
});

async function seedSavedA4Batch(printPreset) {
  const { planHash: _letterHash, ...letterPlan } = await preview({ mode: 'full' });
  const paper = { paperSize: 'a4', ...(printPreset ? { printPreset } : {}) };
  const plan = { ...letterPlan, ...paper };
  const planHash = hash(JSON.stringify(plan));
  const requestHash = hash(JSON.stringify({ deckId: 1, expectedPlanHash: planHash, queueOnReady: false, ...paper }));
  const id = crypto.randomUUID(), idempotencyKey = crypto.randomUUID(), now = new Date().toISOString();
  db.run(`INSERT INTO print_jobs (id, user_id, tracked_deck_id, request_key, request_hash, plan_json, created_at, updated_at)
    VALUES (?, 1, 1, ?, ?, ?, ?, ?)`, [id, idempotencyKey, requestHash, JSON.stringify({ ...plan, planHash }), now, now]);
  return { id, input: { mode: 'full', ...paper, idempotencyKey, expectedPlanHash: planHash } };
}

describe('batch paper size', () => {
  const a4 = { supportedRecipeIds: ['household-letter-v6', 'household-a4-v5'], loadedPaperSize: 'a4' };
  const heartbeat = { version: '2.58.0', paused: false, queue: 'EPSON', recipeVerified: true, duplexVerified: true,
    recipeFingerprint: 'f'.repeat(64), health: { ok: true, known: true, message: 'Fixture ready' }, deferredBacks: true };

  it('advertises US Letter and the three A4 portrait layouts and keeps Letter reviews valid', async () => {
    const options = { mode: 'full', paperSize: 'a4', printPreset: 'crowned-a4-portrait-six' };
    const response = await request('/api/decks/1/print-plan', { method: 'POST', body: options });
    const { plan, capabilities } = await response.json();
    expect(response.status).toBe(200);
    expect(capabilities.paperSizes).toEqual(['letter']);
    expect(capabilities.printPresets).toEqual(['crowned-a4', 'crowned-a4-portrait-six', 'dahle-a4-punch']);
    expect(plan).toMatchObject({ paperSize: 'a4', recipeId: 'household-crowned-a4-portrait-six-v1' });
    const letter = await preview({ mode: 'full' });
    expect((await preview({ mode: 'full', paperSize: 'letter' })).planHash).toBe(letter.planHash);
    expect(plan.planHash).not.toBe(letter.planHash);
    const input = { ...options, idempotencyKey: crypto.randomUUID(), expectedPlanHash: plan.planHash };
    const submit = body => request('/api/decks/1/print-jobs', { method: 'POST', body });
    expect((await submit({ ...input, paperSize: 'constructor' })).status).toBe(400);
    expect((await submit({ ...input, printPreset: undefined, paperSize: 'letter' })).status).toBe(409);
    expect((await submit({ ...input, queueOnReady: true })).status).toBe(409);
    expect((await submit(input)).status).toBe(202);
  });

  it('generates downloadable Dahle PDF packets and blocks both station queue routes', async () => {
    const paper = { paperSize: 'a4', printPreset: 'dahle-a4-punch' };
    const recipe = { ...paper, id: 'household-dahle-a4-punch-v1' };
    const options = { ...paper, mode: 'adhoc', cardText: '1 Malakir Rebirth', listName: 'Dahle sample' };
    const planPath = '/api/print-lists/plan';
    const jobsPath = '/api/print-lists/jobs';
    const plan = (await (await request(planPath, { method: 'POST', body: options })).json()).plan;
    expect(plan).toMatchObject({ ...paper, recipeId: recipe.id });
    services.generatePrintPdfs.mockImplementationOnce(async input => ({ ...await packetPdfs(input, 9), recipe }));
    const input = { ...options, idempotencyKey: crypto.randomUUID(), expectedPlanHash: plan.planHash };
    const submit = body => request(jobsPath, { method: 'POST', body: { ...input, ...body } });
    const queueOnReady = await submit({ queueOnReady: true });
    expect(queueOnReady.status).toBe(409);
    expect((await queueOnReady.json()).error).toContain('Download the Dahle punch PDF');
    const created = await submit({ registrationMarks: true });
    expect(created.status).toBe(202);
    const { job } = await created.json();
    expect(job).toMatchObject({ ...paper, registrationMarks: false });
    expect((await submit({ registrationMarks: false })).status).toBe(200);

    await queue.processNextPrintJob();
    expect(services.generatePrintPdfs).toHaveBeenLastCalledWith(expect.objectContaining({
      ...paper, registrationMarks: false,
      cards: [expect.objectContaining({ frontSource: 'scryfall', backSource: 'scryfall' })],
    }));
    const readyJob = queue.getOwnedPrintJob(1, null, job.id);
    const [artifact] = readyJob.artifacts;
    expect(readyJob.state).toBe('ready');
    expect(artifact).toMatchObject({ cardCount: 1, pageCount: 2, kind: 'dfc' });
    expect((await request(artifact.downloadUrl)).status).toBe(200);
    const laterQueue = await request(`${jobsPath}/${job.id}/queue`, { method: 'POST' });
    expect(laterQueue.status).toBe(409);
    expect((await laterQueue.json()).error).toContain('Download the Dahle punch PDF');
    expect((await station('/heartbeat', 'POST', {
      ...heartbeat, loadedPaperSize: 'a4', loadedPrintPreset: paper.printPreset, supportedRecipeIds: [recipe.id],
    })).status).toBe(400);
  });

  it.each([undefined, 'crowned-a4-landscape'])('rejects new deck and standalone requests with retired A4 preset %s', async printPreset => {
    const paper = { paperSize: 'a4', printPreset };
    for (const [planPath, jobsPath, source] of [
      ['/api/decks/1/print-plan', '/api/decks/1/print-jobs', { mode: 'full' }],
      ['/api/print-lists/plan', '/api/print-lists/jobs', { mode: 'adhoc', listName: 'List', cardText: '1 Lightning Bolt' }],
    ]) {
      const options = { ...source, ...paper };
      const review = await request(planPath, { method: 'POST', body: options });
      expect(review.status).toBe(400);
      expect((await review.json()).error).toMatch(/Choose an A4 portrait layout/);
      const create = await request(jobsPath, { method: 'POST', body: { ...options, idempotencyKey: crypto.randomUUID(), expectedPlanHash: 'a'.repeat(64) } });
      expect(create.status).toBe(400);
      expect((await create.json()).error).toMatch(/Choose an A4 portrait layout/);
    }
    expect(services.fetchCardImageUrls).not.toHaveBeenCalled();
    expect(db.get('SELECT COUNT(*) AS count FROM print_jobs').count).toBe(0);
  });

  it('resumes a saved standard A4 batch and assigns it only to matching station stock', async () => {
    const letter = await ready({ mode: 'full' });
    const { id, input } = await seedSavedA4Batch();
    const replay = await request('/api/decks/1/print-jobs', { method: 'POST', body: input });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ isExisting: true, job: { id, state: 'preparing', recipeId: 'household-a4-v5' } });
    await queue.processNextPrintJob();
    expect(queue.getOwnedPrintJob(1, 1, id)).toMatchObject({ state: 'ready', paperSize: 'a4', recipeId: 'household-a4-v5' });
    const queueBatch = id => request(`/api/decks/1/print-jobs/${id}/queue`, { method: 'POST' });
    expect((await queueBatch(letter.id)).status).toBe(200);
    expect((await queueBatch(id)).status).toBe(409);
    expect((await station('/heartbeat', 'POST', { ...heartbeat, ...a4 })).status).toBe(200);
    expect((await queueBatch(id)).status).toBe(200);
    expect(await (await station('/claim', 'POST', {})).json()).toEqual({ job: null });
    expect(db.get('SELECT state FROM print_jobs WHERE id=?', [letter.id]).state).toBe('queued');
    const result = await station('/claim', 'POST', { ...a4, deferredBacks: true });
    expect((await result.json()).job).toMatchObject({ id, paperSize: 'a4', recipeId: 'household-a4-v5' });
    expect((await station('/claim', 'POST', {})).status).toBe(409);
  });

  it.each([
    ['crowned-a4', 'household-crowned-a4-v2', 9],
    ['crowned-a4-portrait-six', 'household-crowned-a4-portrait-six-v1', 6],
  ])('keeps %s packets on their selected A4 layout', async (printPreset, id, capacity) => {
    const choice = { mode: 'full', paperSize: 'a4', printPreset };
    const recipe = { id, paperSize: 'a4', printPreset };
    db.run('UPDATE deck_snapshots SET deck_text=? WHERE tracked_deck_id=1', [`${capacity} Malakir Rebirth`]);
    services.generatePrintPdfs.mockImplementationOnce(async input => ({ ...await packetPdfs(input, capacity), recipe }));
    const { job } = await create(choice);
    expect(job).toMatchObject({ paperSize: 'a4', printPreset, recipeId: recipe.id });
    const otherPreset = printPreset === 'crowned-a4' ? 'crowned-a4-portrait-six' : 'crowned-a4';
    expect((await preview(choice)).planHash).not.toBe((await preview({ ...choice, printPreset: otherPreset })).planHash);
    await expect(preview({ ...choice, paperSize: 'letter' })).rejects.toMatchObject({ status: 400 });
    await queue.processNextPrintJob();
    expect(queue.getOwnedPrintJob(1, 1, job.id)).toMatchObject({
      state: 'ready', artifacts: [expect.objectContaining({ cardCount: capacity, pageCount: 2 })],
    });
    const send = () => request(`/api/decks/1/print-jobs/${job.id}/queue`, { method: 'POST' });
    const supported = { ...a4, supportedRecipeIds: [...a4.supportedRecipeIds, recipe.id] };
    await station('/heartbeat', 'POST', { ...heartbeat, ...supported });
    expect((await send()).status).toBe(409);
    const loaded = { ...supported, loadedPrintPreset: printPreset };
    await station('/heartbeat', 'POST', { ...heartbeat, ...loaded });
    expect((await send()).status).toBe(200);
    expect(await (await station('/claim', 'POST', { ...supported, deferredBacks: true })).json()).toEqual({ job: null });
    expect((await (await station('/claim', 'POST', { ...loaded, deferredBacks: true, maxArtifacts: capacity === 6 ? 43 : 37 })).json()).job)
      .toMatchObject({ id: job.id, recipeId: recipe.id, printPreset });
  });

  it.each(['v1', 'v2'])('preserves saved Crowned Landscape %s for mixed packets and both physical passes', async variant => {
    const printPreset = 'crowned-a4-landscape';
    const legacy = 'household-crowned-a4-landscape-v1';
    const centered = 'household-crowned-a4-landscape-v2';
    const recipe = { id: variant === 'v1' ? legacy : centered, paperSize: 'a4', printPreset };
    const stationCapabilities = { ...a4, deferredBacks: true, mixedPrintSheets: true,
      supportedRecipeIds: [...a4.supportedRecipeIds, 'household-crowned-a4-v2', legacy, centered] };
    const portrait = { ...stationCapabilities, loadedPrintPreset: 'crowned-a4' };
    const landscape = { ...stationCapabilities, loadedPrintPreset: printPreset };
    db.run("UPDATE deck_snapshots SET deck_text='7 Lightning Bolt (M10) [146]\n1 Malakir Rebirth' WHERE tracked_deck_id=1");
    services.generatePrintPdfs.mockImplementationOnce(async input => ({ ...await packetPdfs(input, 8), recipe }));
    const { id, input } = await seedSavedA4Batch(printPreset);
    await queue.processNextPrintJob();
    const replay = await request('/api/decks/1/print-jobs', { method: 'POST', body: input });
    expect(replay.status).toBe(200);
    const { job } = await replay.json();
    expect(job).toMatchObject({
      id,
      state: 'ready', printPreset, recipeId: recipe.id, artifacts: [
        expect.objectContaining({ cardCount: 8, doubleFacedCardCount: 1, frontPages: [1], backPages: [2] }),
      ],
    });
    const enqueue = () => request(`/api/decks/1/print-jobs/${job.id}/queue`, { method: 'POST' });
    const claim = body => station('/claim', 'POST', body);
    const beat = body => station('/heartbeat', 'POST', { ...heartbeat, ...body });
    expect((await beat(portrait)).status).toBe(200);
    expect((await enqueue()).status).toBe(409);
    const oldCompanion = { ...landscape, supportedRecipeIds: landscape.supportedRecipeIds.filter(id => id !== centered) };
    expect((await beat(oldCompanion)).status).toBe(200);
    if (variant === 'v2') expect((await enqueue()).status).toBe(409);
    expect((await beat(landscape)).status).toBe(200);
    expect((await enqueue()).status).toBe(200);
    const withProofs = verified => ({ ...landscape, recipeVerified: variant === 'v2' && verified,
      recipeProofs: Object.fromEntries(landscape.supportedRecipeIds.map(id => [id,
        { recipeVerified: id === recipe.id && verified, duplexVerified: id === recipe.id && verified }])) });
    expect((await beat(withProofs(false))).status).toBe(200);
    expect(await (await claim(landscape)).json()).toEqual({ job: null });
    expect((await beat(withProofs(true))).status).toBe(200);
    const claimed = (await (await claim(landscape)).json()).job;
    const artifactId = 'double-faced-001';
    const front = { artifactId, phase: 'fronts' };
    const receipt = { ...front, spoolerId: 'EPSON-landscape-front' };
    expect(claimed).toMatchObject({ id: job.id, printPreset, recipeId: recipe.id });
    await report(claimed, 'submitting', front); await report(claimed, 'submitted', receipt);
    expect((await report(claimed, 'completed', receipt)).job.state).toBe('backs_pending');
    const saved = db.get('SELECT * FROM print_jobs WHERE id = ?', [job.id]);
    await queue.preparePrintBacks(saved, artifactId, 1);
    expect((await beat(portrait)).status).toBe(200);
    expect(await (await claim(portrait)).json()).toEqual({ job: null });
    expect((await beat(withProofs(true))).status).toBe(200);
    expect((await (await claim(landscape)).json()).job).toMatchObject({
      id: job.id, state: 'awaiting_refeed', printPreset, recipeId: recipe.id, backRequest: { artifactId },
    });
  });
});

describe('Cameo registration marks', () => {
  it.each([
    ['/api/decks/1/print-plan', '/api/decks/1/print-jobs', { mode: 'full' }],
    ['/api/print-lists/plan', '/api/print-lists/jobs', { mode: 'adhoc', listName: 'Manual cut', cardText: '1 Lightning Bolt' }],
  ])('freezes the choice on %s jobs after review', async (planPath, jobsPath, options) => {
    const review = await request(planPath, { method: 'POST', body: options });
    expect(review.status).toBe(200);
    const { plan } = await review.json();
    const body = { ...options, expectedPlanHash: plan.planHash, idempotencyKey: crypto.randomUUID() };
    const submit = registrationMarks => request(jobsPath, { method: 'POST', body: { ...body, registrationMarks } });

    expect((await submit('false')).status).toBe(400);
    const created = await submit(false);
    expect(created.status).toBe(202);
    const { job } = await created.json();
    expect(job.registrationMarks).toBe(false);
    expect((await submit(true)).status).toBe(409);
    const replay = await submit(false);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ isExisting: true, job: { id: job.id, registrationMarks: false } });

    await queue.processNextPrintJob();
    expect(services.generatePrintPdfs).toHaveBeenLastCalledWith(expect.objectContaining({ registrationMarks: false }));
    const manifest = await request(`${jobsPath}/${job.id}/manifest`);
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({ plan: { planHash: plan.planHash, registrationMarks: false } });
  });

  it('keeps omitted and explicit true interoperable for idempotent retries', async () => {
    const { planHash } = await preview({ mode: 'full' });
    const body = { mode: 'full', expectedPlanHash: planHash, idempotencyKey: crypto.randomUUID() };
    const { job } = await queue.createPrintJob(1, 1, body);
    expect(job.registrationMarks).toBe(true);
    expect(await queue.createPrintJob(1, 1, { ...body, registrationMarks: true }))
      .toMatchObject({ isExisting: true, job: { id: job.id, registrationMarks: true } });
    await queue.processNextPrintJob();
    expect(services.generatePrintPdfs.mock.lastCall[0]).not.toHaveProperty('registrationMarks');
  });
});

describe('Dahle die-cutter alignment marks', () => {
  const paper = { paperSize: 'a4', printPreset: 'dahle-a4-punch' };
  const recipe = { ...paper, id: 'household-dahle-a4-punch-v1' };
  const input = { ...paper, mode: 'adhoc', listName: 'Die alignment fixture', cardText: '1 Malakir Rebirth' };
  const planPath = '/api/print-lists/plan', jobsPath = '/api/print-lists/jobs';
  const review = options => request(planPath, { method: 'POST', body: { ...input, ...options } });
  const submit = body => request(jobsPath, { method: 'POST', body: { ...input, ...body } });

  it('keeps the unmarked request identity and freezes the opt-in on a separate Dahle PDF-only job', async () => {
    const { plan: unmarked } = await (await review()).json();
    const { plan: explicitOff } = await (await review({ dahleAlignmentMarks: false })).json();
    expect(explicitOff).toEqual(unmarked);
    const { plan: marked } = await (await review({ dahleAlignmentMarks: true })).json();
    expect(marked).toMatchObject({ dahleAlignmentMarks: true, recipeId: unmarked.recipeId });
    expect(marked.planHash).not.toBe(unmarked.planHash);
    const legacy = { idempotencyKey: crypto.randomUUID(), expectedPlanHash: unmarked.planHash };
    const first = await submit(legacy);
    expect(first.status).toBe(202);
    const firstJob = (await first.json()).job;
    expect(firstJob).not.toHaveProperty('dahleAlignmentMarks');
    const legacyDigest = hash(JSON.stringify({ deckId: null, expectedPlanHash: unmarked.planHash, queueOnReady: false,
      ...paper, registrationMarks: false }));
    expect(db.get('SELECT request_hash FROM print_jobs WHERE id = ?', [firstJob.id]).request_hash).toBe(legacyDigest);
    expect((await submit({ ...legacy, dahleAlignmentMarks: false })).status).toBe(200);
    expect((await submit({ ...legacy, dahleAlignmentMarks: true })).status).toBe(409);
    const exact = { idempotencyKey: crypto.randomUUID(), expectedPlanHash: marked.planHash, dahleAlignmentMarks: true };
    expect((await submit({ ...exact, expectedPlanHash: unmarked.planHash })).status).toBe(409);
    expect((await submit({ ...exact, queueOnReady: true })).status).toBe(409);
    const generated = await submit(exact);
    expect(generated.status).toBe(202);
    const { job } = await generated.json();
    expect((await submit(exact)).status).toBe(200);
    services.generatePrintPdfs.mockImplementation(async options => ({ ...await packetPdfs(options, 9), recipe,
      ...(options.dahleAlignmentMarks ? { dahleAlignmentMarks: true } : {}) }));
    await queue.processNextPrintJob();
    await queue.processNextPrintJob();
    expect(services.generatePrintPdfs.mock.calls.some(([options]) => !Object.hasOwn(options, 'dahleAlignmentMarks'))).toBe(true);
    expect(services.generatePrintPdfs.mock.calls.some(([options]) => options.dahleAlignmentMarks === true && options.registrationMarks === false)).toBe(true);
    expect(queue.getOwnedPrintJob(1, null, job.id)).toMatchObject({ state: 'ready', dahleAlignmentMarks: true, registrationMarks: false });
    expect(queue.ownedPrintManifest(1, null, job.id)).toMatchObject({ dahleAlignmentMarks: true, plan: { dahleAlignmentMarks: true } });
    expect(queue.ownedPrintManifest(1, null, firstJob.id)).not.toHaveProperty('dahleAlignmentMarks');
    expect((await request(`${jobsPath}/${job.id}/queue`, { method: 'POST' })).status).toBe(409);
  });

  it('validates the option before planning or creating a batch', async () => {
    expect((await review({ dahleAlignmentMarks: 'true' })).status).toBe(400);
    const crowned = { printPreset: 'crowned-a4', dahleAlignmentMarks: true };
    expect((await review(crowned)).status).toBe(400);
    expect((await submit({ ...crowned, idempotencyKey: crypto.randomUUID(), expectedPlanHash: 'a'.repeat(64) })).status).toBe(400);
    expect(services.fetchCardImageUrls).not.toHaveBeenCalled();
  });
});

async function packetPdfs({ cards, outputDir, batchLabel, sheetPacking }, capacity = 7) {
  mkdirSync(outputDir, { recursive: true });
  const fronts = cards.filter(card => !card.backPath), dfcs = cards.filter(card => card.backPath);
  const packetCount = Math.ceil(dfcs.length / capacity);
  const filler = sheetPacking ? Math.min(fronts.length, packetCount * capacity - dfcs.length) : 0;
  const frontCount = fronts.length - filler, sheets = Math.ceil(frontCount / capacity);
  const ordinary = frontCount ? [{ id: 'fronts', kind: 'ordinary', cardCount: frontCount, sheetCount: sheets, pageCount: sheets }] : [];
  const packets = Array.from({ length: packetCount }, (_, i) => {
    const index = i + 1, backs = Math.min(capacity, dfcs.length - i * capacity);
    return {
      id: `double-faced-${String(index).padStart(3, '0')}`, kind: 'dfc', pageCount: 2, sheetCount: 1,
      cardCount: backs + (index === packetCount ? filler : 0), packetIndex: index, packetCount,
      ...(sheetPacking ? { doubleFacedCardCount: backs } : {}), label: `${batchLabel} DFC ${index}/${packetCount}`,
    };
  });
  const groups = sheetPacking ? [...packets, ...ordinary] : [...ordinary, ...packets];
  return { revision: 'fixture', runtimeVersion: 'fixture', recipe: { id: 'household-letter-v6' }, slots: [], images: [],
    artifacts: groups.map(group => {
      const bytes = Buffer.from(`%PDF-1.4\n${group.id}\n%%EOF\n`), path = join(outputDir, `${group.id}.pdf`);
      writeFileSync(path, bytes);
      return { ...group, path, size: bytes.length, sha256: hash(bytes), slotMap: [] };
    }) };
}

async function readyLegacyPackets(doubleFacedCopies) {
  const { deck_text: originalText } = db.get('SELECT deck_text FROM deck_snapshots WHERE tracked_deck_id = 1');
  db.run('UPDATE deck_snapshots SET deck_text = ? WHERE tracked_deck_id = 1',
    [`1 Lightning Bolt (M10) [146]\n${doubleFacedCopies} Malakir Rebirth // Malakir Mire (ZNR) [111]`]);
  services.generatePrintPdfs.mockImplementationOnce(packetPdfs);
  const { job } = await create({ queueOnReady: true });
  // Simulate a preparation created by the previous server before installing the new version.
  const plan = JSON.parse(db.get('SELECT plan_json FROM print_jobs WHERE id = ?', [job.id]).plan_json);
  delete plan.sheetPacking;
  db.run('UPDATE print_jobs SET plan_json = ? WHERE id = ?', [JSON.stringify(plan), job.id]);
  await queue.processNextPrintJob();
  db.run('UPDATE deck_snapshots SET deck_text = ? WHERE tracked_deck_id = 1', [originalText]);
  const prepared = queue.getOwnedPrintJob(1, 1, job.id);
  expect(prepared).toMatchObject({ state: 'queued' });
  return prepared;
}

describe('durable queued batch announcements', () => {
  const notices = () => db.all('SELECT * FROM print_queue_notifications ORDER BY queued_at, id');
  it('announces successful queue-on-ready preparation once and freezes the batch summary', async () => {
    const plan = await preview(), request = { queueOnReady: true, idempotencyKey: crypto.randomUUID(), expectedPlanHash: plan.planHash };
    const created = await queue.createPrintJob(1, 1, request);
    expect(notices()).toEqual([]); // Preparation is not a physical queue entry yet.
    await queue.processNextPrintJob();
    const notice = notices()[0];
    expect(notices()).toHaveLength(1);
    expect(notice).toMatchObject({ job_id: created.job.id, station_id: 'household', deck_name: 'Deck 1', requester_name: 'printer', total_copies: 1, delivered_at: null, status: null });
    expect(notice.queued_at).toBe(db.get('SELECT queued_at FROM print_jobs WHERE id = ?', [created.job.id]).queued_at);
    db.run("UPDATE users SET username = 'renamed' WHERE id = 1");
    await queue.createPrintJob(1, 1, request); await queue.processNextPrintJob();
    await queue.queuePrintJob(1, 1, created.job.id);
    expect(notices()).toEqual([notice]);
    expect(Object.keys(notice)).not.toContain('plan_json');
  });
  it('does not announce download-only preparation until that exact PDF is explicitly queued', async () => {
    const job = await ready();
    expect(notices()).toEqual([]);
    await queue.queuePrintJob(1, 1, job.id); await queue.queuePrintJob(1, 1, job.id);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ job_id: job.id, total_copies: 1 });
  });
  it('also announces ad hoc batches with their user label and no tracked deck', async () => {
    const options = { mode: 'adhoc', cardText: '2 Lightning Bolt (M10) [146]', listName: 'Weekend extras', queueOnReady: true };
    const plan = await planModule.buildPrintPlan(1, null, options);
    const created = await queue.createPrintJob(1, null, { ...options, idempotencyKey: crypto.randomUUID(), expectedPlanHash: plan.planHash });
    await queue.processNextPrintJob();
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ job_id: created.job.id, deck_name: 'Weekend extras', requester_name: 'printer', total_copies: 2 });
  });
  it('never announces failed preparation or a job that loses queue authorization', async () => {
    services.generatePrintPdfs.mockRejectedValueOnce(new Error('fixture PDF failure'));
    await create({ queueOnReady: true }); await queue.processNextPrintJob();
    const { job } = await create({ queueOnReady: true });
    db.run('UPDATE users SET is_admin = 0 WHERE id = 1'); await queue.processNextPrintJob();
    expect(queue.getOwnedPrintJob(1, 1, job.id).state).toBe('ready');
    expect(notices()).toEqual([]);
  });
  it('atomically rolls back queue acceptance when its outbox cannot be persisted', async () => {
    const job = await ready(), previous = db.get('SELECT * FROM print_jobs WHERE id = ?', [job.id]);
    db.run("CREATE TRIGGER reject_notice BEFORE INSERT ON print_queue_notifications BEGIN SELECT RAISE(ABORT, 'fixture outbox unavailable'); END");
    await expect(queue.queuePrintJob(1, 1, job.id)).rejects.toThrow('fixture outbox unavailable');
    expect(db.get('SELECT * FROM print_jobs WHERE id = ?', [job.id])).toEqual(previous);
    expect(notices()).toEqual([]);
    db.run('DROP TRIGGER reject_notice');
    await queue.queuePrintJob(1, 1, job.id);
    expect(notices()).toHaveLength(1);
  });
  it('normalizes display labels without rewriting immutable plans and falls back for blank labels', async () => {
    const job = await ready();
    const plan = JSON.parse(db.get('SELECT plan_json FROM print_jobs WHERE id = ?', [job.id]).plan_json);
    Object.assign(plan, { deckName: '  Deck\n\twith\u0000 spaces  ', requesterName: '  Household\u0085 user  ' });
    const immutable = JSON.stringify(plan);
    db.run('UPDATE print_jobs SET plan_json = ? WHERE id = ?', [immutable, job.id]);
    await queue.queuePrintJob(1, 1, job.id);
    expect(notices()[0]).toMatchObject({ deck_name: 'Deck with spaces', requester_name: 'Household user' });
    expect(db.get('SELECT plan_json FROM print_jobs WHERE id = ?', [job.id]).plan_json).toBe(immutable);
    const next = await ready();
    const nextPlan = JSON.parse(db.get('SELECT plan_json FROM print_jobs WHERE id = ?', [next.id]).plan_json);
    Object.assign(nextPlan, { deckName: '\u0000\n', requesterName: '\t\r' });
    db.run('UPDATE print_jobs SET plan_json = ? WHERE id = ?', [JSON.stringify(nextPlan), next.id]);
    await queue.queuePrintJob(1, 1, next.id);
    expect(db.get('SELECT deck_name, requester_name FROM print_queue_notifications WHERE job_id = ?', [next.id])).toEqual({ deck_name: 'Card batch', requester_name: 'printer' });
  });
  it('retains one notice across startup and cascades it when its account print jobs are purged', async () => {
    const job = await ready({ queueOnReady: true }), notice = notices()[0];
    stopQueue = queue.initPrintQueue();
    expect(notices()).toEqual([notice]);
    await queue.purgeUserPrintJobs(1);
    expect(db.get('SELECT id FROM print_jobs WHERE id = ?', [job.id])).toBeNull();
    expect(notices()).toEqual([]);
  });
});

describe('global print batch history', () => {
  function seed(userId, state, createdAt, extra = {}) {
    const id = crypto.randomUUID();
    db.run(`INSERT INTO print_jobs(id, user_id, tracked_deck_id, request_key, request_hash, plan_json, state, created_at, updated_at,
      queued_at, queue_requested, progress_json, error) VALUES(?, ?, ?, ?, 'hash', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, extra.deckId ?? null, crypto.randomUUID(), JSON.stringify({ deckName: extra.name || 'Fixture batch', totalCopies: 94,
      list: { text: 'private source' }, comparison: { beforeText: 'private comparison' }, cards: [{ secret: 'private art' }] }), state,
    createdAt, createdAt, ['queued', 'submitted'].includes(state) ? extra.queuedAt || createdAt : null,
    state === 'queued' ? 1 : 0, JSON.stringify({ phase: 'images', downloaded: 2, cached: 2, total: 2, token: 'private-progress-token' }),
    'Bearer private-error-token']);
    return id;
  }

  it('lists only minimal, active owner jobs in the requested deck or print-list scope', async () => {
    const date = '2026-09-01T00:00:00Z';
    const deckJob = seed(1, 'preparing', date, { deckId: 1 });
    const listJob = seed(1, 'ready', date);
    seed(1, 'failed', date, { deckId: 1 });
    seed(2, 'queued', date, { deckId: 1 });
    const result = await request('/api/decks/1/print-jobs/activity');
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    const deck = await result.json();
    expect(deck).toMatchObject({ activeCount: 1, watching: true });
    expect(deck.jobs).toEqual([{ id: deckJob, state: 'preparing', updatedAt: date }]);
    const list = await (await request('/api/print-lists/jobs/activity')).json();
    expect(list).toMatchObject({ activeCount: 1, watching: false });
    expect(list.jobs).toEqual([{ id: listJob, state: 'ready', updatedAt: date }]);
    expect((await request('/api/print-lists/jobs/activity', { token: null })).status).toBe(401);
  });

  it('watches older and terminal rows without exposing other owners or deck scopes', async () => {
    const older = '2026-08-01T00:00:00Z';
    const latest = '2026-09-01T00:00:00Z';
    const deepLink = seed(1, 'submitted', older, { deckId: 1 });
    const goneFromActive = seed(1, 'completed', older, { deckId: 1 });
    const otherUser = seed(2, 'submitted', older, { deckId: 1 });
    const standalone = seed(1, 'submitted', older);
    db.transaction(() => {
      for (let i = 0; i < 50; i++) seed(1, 'ready', latest, { deckId: 1 });
    });
    const response = await request('/api/decks/1/print-jobs/activity?watch=' + [deepLink, goneFromActive, otherUser, standalone].join(','));
    const result = await response.json();
    expect(result.activeCount).toBe(51);
    expect(result.jobs).toHaveLength(50);
    expect(result.jobs).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: deepLink })]));
    expect(result.watchedJobs).toHaveLength(2);
    expect(result.watchedJobs).toEqual(expect.arrayContaining([
      { id: deepLink, state: 'submitted', updatedAt: older }, { id: goneFromActive, state: 'completed', updatedAt: older },
    ]));
    const tooMany = Array.from({ length: 52 }, () => crypto.randomUUID()).join(',');
    expect((await request(`/api/decks/1/print-jobs/activity?watch=${tooMany}`)).status).toBe(400);
    expect((await request('/api/decks/1/print-jobs/activity?watch=invalid')).status).toBe(400);
  });

  it('returns lightweight current stock and online readiness only to authorized queue users', async () => {
    const activity = async token => (await request('/api/print-lists/jobs/activity', { token })).json();
    expect((await activity('user-1')).station).toMatchObject({ online: false, loadedPaperSize: 'letter' });
    const heartbeat = { version: '2.65.0', paused: false, queue: 'EPSON', recipeVerified: true, duplexVerified: true,
      recipeFingerprint: 'f'.repeat(64), health: { ok: true, known: true, message: 'Fixture ready' }, activeJob: null, events: [], receipts: [],
      loadedPaperSize: 'a4', loadedPrintPreset: 'crowned-a4', supportedRecipeIds: ['household-crowned-a4-v2'] };
    expect((await station('/heartbeat', 'POST', heartbeat)).status).toBe(200);
    expect((await activity('user-1')).station).toEqual({ online: true, loadedPaperSize: 'a4', loadedPrintPreset: 'crowned-a4',
      supportedRecipeIds: ['household-crowned-a4-v2'], duplexVerified: true, mixedPrintSheets: false });
    expect((await activity('user-2')).station).toBeNull();
  });

  it('enables active legacy cancellation only from a live native capability and preserves owner authorization', async () => {
    const id = seed(2, 'submitted', new Date().toISOString());
    const steps = [{ artifactId: 'double-faced', phase: 'fronts', state: 'submitted', spoolerId: 'EPSON-legacy' },
      { artifactId: 'double-faced', phase: 'backs', state: 'pending', requiresRefeed: true }];
    db.run("UPDATE print_jobs SET station_id = 'household', steps_json = ? WHERE id = ?", [JSON.stringify(steps), id]);
    const list = async (token = 'user-1', query = '') => (await (await request('/api/print-batches' + query, { token })).json()).jobs[0];
    expect(await list('user-1', '?deferredBacks=true')).toMatchObject({ canCancel: false, canCancelBacks: false });
    const heartbeat = { version: '2.55.0', paused: false, queue: 'EPSON', recipeVerified: true, duplexVerified: true,
      recipeFingerprint: 'f'.repeat(64), health: { ok: true, known: true, message: 'Fixture ready' }, activeJob: null, events: [], receipts: [] };
    expect((await station('/heartbeat', 'POST', { ...heartbeat, deferredBacks: false })).status).toBe(200);
    expect(await list()).toMatchObject({ canCancel: false, canCancelBacks: false });
    expect((await station('/heartbeat', 'POST', { ...heartbeat, deferredBacks: true })).status).toBe(200);
    expect(await list()).toMatchObject({ canCancel: true, canCancelBacks: true, canOpen: false });
    expect(await list('user-2')).toMatchObject({ canCancel: false, canCancelBacks: false, canOpen: true });
    vi.stubEnv('PRINT_ALLOWED_USER_IDS', '2');
    expect(await list('user-2')).toMatchObject({ canCancel: true, canCancelBacks: true });
    const current = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(current + 21_000);
    expect(await list()).toMatchObject({ canCancel: false, canCancelBacks: false });
  });

  it('paginates every owner and source for admins, but always scopes normal users to their own batches', async () => {
    const ids = [];
    for (let n = 0; n < 55; n++) ids.push(seed(n % 2 + 1, 'completed', `2026-09-${String(n % 28 + 1).padStart(2, '0')}T00:00:00Z`, { deckId: n % 3 ? null : n % 2 + 1 }));
    const collected = [];
    let cursor = null;
    do {
      const response = await request(`/api/print-batches?limit=17&order=newest${cursor ? '&cursor=' + cursor : ''}`), body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(body.scope).toBe('all'); expect(body.totalCount).toBe(55);
      collected.push(...body.jobs); cursor = body.nextCursor;
    } while (cursor);
    expect(collected.map(job => job.id)).toEqual(db.all('SELECT id FROM print_jobs ORDER BY created_at DESC, id DESC').map(row => row.id));
    expect(new Set(collected.map(job => job.id)).size).toBe(ids.length);
    const others = collected.filter(job => !job.canOpen);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every(job => job.requesterName === 'other' && !Object.hasOwn(job, 'deckId'))).toBe(true);
    expect(collected.some(job => job.sourceKind === 'list')).toBe(true);
    expect(collected.some(job => job.sourceKind === 'deck')).toBe(true);
    for (const value of ['private source', 'private comparison', 'private art', 'private-progress-token', 'private-error-token', 'downloadUrl', 'manifestSha256']) expect(JSON.stringify(collected)).not.toContain(value);
    expect(collected[0].progress).toEqual({ phase: 'images', completed: 2, total: 2 });
    const own = await (await request('/api/print-batches', { token: 'user-2' })).json();
    expect(own.scope).toBe('mine'); expect(own.totalCount).toBe(27);
    expect(own.jobs.every(job => job.canOpen && !job.canCancel && !Object.hasOwn(job, 'requesterName'))).toBe(true);
    db.run('UPDATE users SET is_admin = 0 WHERE id = 1');
    expect((await (await request('/api/print-batches')).json()).scope).toBe('mine');
    db.run('UPDATE users SET suspended = 1 WHERE id = 2');
    expect((await request('/api/print-batches', { token: 'user-2' })).status).toBe(403);
    expect((await request('/api/print-batches', { token: null })).status).toBe(401);
  });

  it('filters paper-clearance requests durably across native states, owner scope and cursor pages', async () => {
    const firstId = seed(1, 'claimed', '2026-09-01T00:00:00Z');
    const secondId = seed(2, 'submitted', '2026-09-02T00:00:00Z');
    seed(1, 'claimed', '2026-09-03T00:00:00Z');
    seed(1, 'canceled', '2026-09-04T00:00:00Z');
    db.run("UPDATE print_jobs SET cancel_requested = 'all' WHERE id = ?", [firstId]);
    db.run("UPDATE print_jobs SET cancel_requested = 'backs' WHERE id = ?", [secondId]);
    const page = await request('/api/print-batches?state=awaiting_clearance&limit=1');
    expect(page.status).toBe(200);
    const firstPage = await page.json();
    expect(firstPage).toMatchObject({ scope: 'all', totalCount: 2, jobs: [{ id: firstId, state: 'claimed', cancelRequested: 'all' }] });
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await (await request('/api/print-batches?state=awaiting_clearance&limit=1&cursor=' + firstPage.nextCursor)).json();
    expect(secondPage).toMatchObject({ totalCount: 2, nextCursor: null, jobs: [{ id: secondId, state: 'submitted', cancelRequested: 'backs' }] });
    expect((await request('/api/print-batches?state=claimed&cursor=' + firstPage.nextCursor)).status).toBe(400);
    const owner = await (await request('/api/print-batches?state=awaiting_clearance', { token: 'user-2' })).json();
    expect(owner).toMatchObject({ scope: 'mine', totalCount: 1, jobs: [{ id: secondId }] });
    db.run('UPDATE print_jobs SET cancel_requested = NULL WHERE id = ?', [firstId]);
    const cleared = await (await request('/api/print-batches?state=awaiting_clearance')).json();
    expect(cleared.totalCount).toBe(1);
    expect(db.get('SELECT state FROM print_jobs WHERE id = ?', [firstId]).state).toBe('claimed');
  });

  it('keeps active and FIFO queued batches first across cursor pages and binds filter/order to its cursor', async () => {
    const finished = seed(1, 'completed', '2026-09-12T00:00:00Z');
    const ready = seed(2, 'ready', '2026-09-12T00:00:00Z');
    const queuedLater = seed(1, 'queued', '2026-09-02T00:00:00Z', { queuedAt: '2026-09-04T00:00:00Z' });
    const queuedFirst = seed(2, 'queued', '2026-09-03T00:00:00Z');
    const generating = seed(1, 'preparing', '2026-09-01T00:00:00Z');
    const active = seed(2, 'submitted', '2026-09-01T00:00:00Z');
    let cursor = null; const ids = [];
    do {
      const body = await (await request(`/api/print-batches?limit=2${cursor ? '&cursor=' + cursor : ''}`)).json();
      ids.push(...body.jobs.map(job => job.id)); cursor = body.nextCursor;
    } while (cursor);
    expect(ids).toEqual([active, queuedFirst, queuedLater, generating, ready, finished]);
    const first = await (await request('/api/print-batches?limit=1&state=queued')).json();
    expect(first.jobs[0]).toMatchObject({ id: queuedFirst, canCancel: true, canOpen: false });
    expect(first.totalCount).toBe(2);
    expect((await request('/api/print-batches?cursor=' + first.nextCursor)).status).toBe(400);
    expect((await request('/api/print-batches?state=queued&order=newest&cursor=' + first.nextCursor)).status).toBe(400);
    for (const query of ['limit=0', 'limit=101', 'limit=NaN', 'limit=1&limit=2', 'state=bogus', 'order=bad', 'cursor=bad', 'cursor=' + 'a'.repeat(513)]) {
      expect((await request('/api/print-batches?' + query)).status).toBe(400);
    }
  });

  it('matches the scheduler across one-row pages when queued timestamps tie but creation times and IDs differ', async () => {
    const first = 'ffffffff-ffff-4fff-8fff-ffffffffffff', second = '00000000-0000-4000-8000-000000000001', third = '88888888-8888-4888-8888-888888888888';
    for (const [id, createdAt] of [[first, '2026-09-01T00:00:00Z'], [second, '2026-09-02T00:00:00Z'], [third, '2026-09-02T00:00:00Z']]) {
      const generatedId = seed(1, 'queued', createdAt, { queuedAt: '2026-09-10T00:00:00Z' });
      db.run('UPDATE print_jobs SET id = ? WHERE id = ?', [id, generatedId]);
    }
    const schedulerOrder = db.all("SELECT id FROM print_jobs WHERE state = 'queued' ORDER BY queued_at, created_at, id").map(row => row.id);
    expect(schedulerOrder).toEqual([first, second, third]);
    const actual = [];
    let cursor;
    do {
      const result = await request(`/api/print-batches?limit=1&state=queued${cursor ? '&cursor=' + cursor : ''}`);
      expect(result.status).toBe(200);
      const page = await result.json();
      actual.push(...page.jobs.map(job => job.id)); cursor = page.nextCursor;
    } while (cursor);
    expect(actual).toEqual(schedulerOrder);
    expect((await (await request('/api/print-batches?order=newest')).json()).jobs.map(job => job.id)).toEqual([third, second, first]);
  });
});

describe('standalone print lists', () => {
  it('allows new batches behind queued work while limiting simultaneous PDF preparations', async () => {
    const queuedIds = [];
    for (let n = 0; n < 3; n++) { const job = await ready({ queueOnReady: true }); expect(job.state).toBe('queued'); queuedIds.push(job.id); }
    const first = await create({ mode: 'adhoc', cardText: '1 Sol Ring', queueOnReady: true }, 1, null);
    const second = await create({ queueOnReady: true });
    expect(first.job.state).toBe('preparing'); expect(second.job.state).toBe('preparing');
    await expect(create({ queueOnReady: true })).rejects.toMatchObject({ status: 429 });
    expect(db.all("SELECT id FROM print_jobs WHERE state = 'queued'").map(row => row.id).sort()).toEqual(queuedIds.sort());
    expect(db.get("SELECT COUNT(*) n FROM print_jobs WHERE state = 'preparing'").n).toBe(2);
  });
  it('freezes Compare inputs, exposes a redacted source summary, and replays accepted comparison jobs', async () => {
    const body = { mode: 'adhoc', cardText: '3 Sol Ring\n2 Malakir Rebirth // Malakir Mire', listName: 'Comparison changes',
      comparison: { mode: 'changes', beforeText: '2 Sol Ring\n1 Counterspell' } };
    const { plan } = await (await request('/api/print-lists/plan', { method: 'POST', body })).json();
    expect(plan).toMatchObject({ totalCopies: 3, ordinaryCopies: 1, doubleFacedCopies: 2,
      comparison: { mode: 'changes', beforeTextHash: hash(body.comparison.beforeText) } });
    expect(plan.comparison.beforeText).toBeUndefined();
    const createBody = { ...body, idempotencyKey: crypto.randomUUID(), expectedPlanHash: plan.planHash };
    const created = await request('/api/print-lists/jobs', { method: 'POST', body: createBody });
    expect(created.status).toBe(202);
    const { job } = await created.json();
    expect(job.comparison).toEqual(plan.comparison);
    const stale = await request('/api/print-lists/jobs', { method: 'POST', body: { ...createBody, idempotencyKey: crypto.randomUUID(), comparison: { ...body.comparison, beforeText: '1 Sol Ring' } } });
    expect(stale.status).toBe(409);
    await queue.processNextPrintJob();
    const manifest = await (await request(`/api/print-lists/jobs/${job.id}/manifest`)).json();
    expect(manifest.plan.comparison.beforeText).toBe(body.comparison.beforeText);
    expect(manifest.plan.list.text).toBe(body.cardText);
    expect(manifest.copies).toHaveLength(3);
    expect(manifest.copies.filter(card => card.displayName === 'Sol Ring')).toHaveLength(1);
    expect((await (await request('/api/print-lists/jobs')).json()).jobs[0].comparison).toEqual(plan.comparison);
    services.fetchCardImageUrls.mockRejectedValue(new Error('Metadata offline'));
    const repeated = await request('/api/print-lists/jobs', { method: 'POST', body: createBody });
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).job.id).toBe(job.id);
    expect(db.get('SELECT COUNT(*) AS count FROM tracked_decks').count).toBe(2);
    expect(db.get('SELECT COUNT(*) AS count FROM deck_snapshots').count).toBe(2);
  });
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
    expect(ready.artifacts.map(item => item.id)).toEqual(['double-faced-001', 'double-faced-002']);
    expect(ready.artifacts[0]).toMatchObject({ label: `CLC ${job.id.slice(0,8)} DFC 1/2`, frontPages: [1], backPages: [2], cardCount: 7 });
    expect(ready.artifacts[1]).toMatchObject({ cardCount: 4, doubleFacedCardCount: 1 });
    const manifest = await (await request(`/api/print-lists/jobs/${job.id}/manifest`)).json();
    expect(manifest.plan.list.text).toBe(body.cardText);
    expect(manifest.plan.additionalCardText).toBe(body.additionalCardText);
    expect(manifest.copies).toHaveLength(11);
    expect(manifest.copies.filter(card => card.displayName === 'Sol Ring')).toHaveLength(2);
    expect(manifest.copies.some(card => card.displayName === 'Island')).toBe(false);
    const artifact = ready.artifacts[0];
    expect(artifact.downloadUrl).toBe(`/api/print-lists/jobs/${job.id}/artifacts/double-faced-001`);
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
    const claimed = await queue.claimPrintJob();
    expect(claimed).toMatchObject({ id: job.id, mode: 'adhoc', deckId: null, deckName: 'Print list' });
    expect(claimed.artifacts[0].downloadUrl).toBe(`/api/print-station/jobs/${job.id}/artifacts/double-faced-001`);
    const front = { artifactId: 'double-faced-001', phase: 'fronts' }, back = { artifactId: 'double-faced-001', phase: 'backs' };
    await report(claimed, 'submitting', front); await report(claimed, 'submitted', { ...front, spoolerId: 'fixture-1' });
    await report(claimed, 'completed', { ...front, spoolerId: 'fixture-1' });
    expect(queue.getOwnedPrintJob(1, null, job.id).state).toBe('awaiting_refeed');
    await expect(report(claimed, 'submitting', back)).rejects.toThrow();
    await report(claimed, 'refeed', back);
    await report(claimed, 'submitting', back); await report(claimed, 'submitted', { ...back, spoolerId: 'fixture-2' });
    await report(claimed, 'completed', { ...back, spoolerId: 'fixture-2' });
    expect(queue.getOwnedPrintJob(1, null, job.id).state).toBe('completed');
  });
});

 describe('immutable PDF jobs and owner access', () => {
  it('prints mixed packets first and preserves exact labels and page ranges at the station', async () => {
    const other = await ready({ queueOnReady: true });
    db.run("UPDATE deck_snapshots SET deck_text = '8 Lightning Bolt (M10) [146]\n8 Malakir Rebirth // Malakir Mire (ZNR) [111]' WHERE tracked_deck_id = 1");
    services.generatePrintPdfs.mockImplementationOnce(packetPdfs);
    const job = await ready({ queueOnReady: true });
    db.run("UPDATE print_jobs SET queued_at = '2000-01-01' WHERE id = ?", [job.id]);
    const old = { deferredBacks: true, printRecovery: true };
    const capable = { ...old, mixedPrintSheets: true };
    const listed = (await (await request('/api/print-batches?state=queued')).json()).jobs;
    expect(listed.find(item => item.id === job.id)).toMatchObject({ requiresMixedPrintSheets: true });
    expect(listed.find(item => item.id === other.id)).not.toHaveProperty('requiresMixedPrintSheets');
    expect((await station('/claim', 'POST', { ...old, mixedPrintSheets: 'true' })).status).toBe(400);
    expect((await (await station('/claim', 'POST', old)).json()).job.id).toBe(other.id);
    expect(db.get('SELECT state, claim_nonce FROM print_jobs WHERE id = ?', [job.id])).toEqual({ state: 'queued', claim_nonce: null });
    const legacy = await queue.claimPrintJob(old);
    await report(legacy, 'submitting', ordinary()); await report(legacy, 'submitted', ordinary({ spoolerId: 'EPSON-other' }));
    await report(legacy, 'completed', ordinary({ spoolerId: 'EPSON-other' }));
    expect(await (await station('/claim', 'POST', { mixedPrintSheets: true })).json()).toEqual({ job: null });
    expect(job.artifacts.map(item => item.id)).toEqual(['double-faced-001', 'double-faced-002', 'fronts']);
    expect(job.artifacts[0]).toMatchObject({ label: `CLC ${job.id.slice(0, 8)} DFC 1/2`, packetIndex: 1, packetCount: 2, cardCount: 7, frontPages: [1], backPages: [2] });
    expect(job.artifacts[1]).toMatchObject({ sheetCount: 1, cardCount: 7, doubleFacedCardCount: 1, pageCount: 2 });
    expect(job.artifacts[2]).toMatchObject({ sheetCount: 1, cardCount: 2, pageCount: 1 });
    const claimed = (await (await station('/claim', 'POST', capable)).json()).job;
    expect(claimed).toMatchObject({ id: job.id, sheetPacking: 'double-faced-first', workflow: 'deferred-backs-v1' });
    expect((await station('/claim', 'POST', old)).status).toBe(409);
    expect(claimed.artifacts[0].label).toBe(job.artifacts[0].label);
    expect((await station(`/jobs/${job.id}/artifacts/double-faced-002`)).status).toBe(200);
    expect(claimed.steps.map(step => [step.artifactId, step.phase])).toEqual([
      ['double-faced-001', 'fronts'], ['double-faced-002', 'fronts'], ['fronts', 'fronts'], ['double-faced-001', 'backs'], ['double-faced-002', 'backs'],
    ]);
    await expect(report(claimed, 'submitting', ordinary())).rejects.toThrow('not eligible');
    for (const [index, pass] of claimed.steps.filter(step => step.phase === 'fronts').entries()) {
      const step = { artifactId: pass.artifactId, phase: 'fronts' };
      const receipt = { ...step, spoolerId: `EPSON-mixed-${index}` };
      await report(claimed, 'submitting', step); await report(claimed, 'submitted', receipt); await report(claimed, 'completed', receipt);
    }
    const saved = db.get('SELECT * FROM print_jobs WHERE id = ?', [job.id]);
    expect(saved.state).toBe('backs_pending');
    await queue.preparePrintBacks(saved, 'double-faced-002', 1);
    expect(await (await station('/claim', 'POST', old)).json()).toEqual({ job: null });
    expect((await (await station('/claim', 'POST', capable)).json()).job).toMatchObject({
      state: 'awaiting_refeed', backRequest: { artifactId: 'double-faced-002' },
    });
    await expect(report(claimed, 'submitting', { artifactId: 'double-faced-002', phase: 'backs' })).rejects.toThrow();
  });
  it('refuses wrong reverse-face counts before publishing a mixed batch', async () => {
    db.run("UPDATE deck_snapshots SET deck_text = '1 Lightning Bolt\n1 Malakir Rebirth' WHERE tracked_deck_id = 1");
    services.generatePrintPdfs.mockImplementationOnce(async input => {
      const result = await packetPdfs(input);
      result.artifacts[0].doubleFacedCardCount = 2;
      return result;
    });
    const { job } = await create({ queueOnReady: true });
    await queue.processNextPrintJob();
    expect(queue.getOwnedPrintJob(1, 1, job.id)).toMatchObject({
      state: 'failed', artifacts: [], error: 'Generated mixed sheet layout does not match the plan',
    });
  });
  it.each([{ packetIndex: 2 }, { packetCount: 99 }, { label: 'Wrong printed sheet' }, { sheetCount: 2 }, { cardCount: 8 }])('refuses malformed generated packet metadata %j before queueing', async changes => {
    db.run("UPDATE deck_snapshots SET deck_text = '8 Malakir Rebirth // Malakir Mire (ZNR) [111]' WHERE tracked_deck_id = 1");
    services.generatePrintPdfs.mockImplementationOnce(async input => {
      const result = await packetPdfs(input); Object.assign(result.artifacts[0], changes); return result;
    });
    const { job } = await create({ queueOnReady: true }); await queue.processNextPrintJob();
    expect(queue.getOwnedPrintJob(1, 1, job.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('invalid double-sided packet') });
    expect(await queue.claimPrintJob()).toBeNull();
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
    await expect(queue.ownedPrintArtifact(1, 1, job.id, 'fronts')).rejects.toThrow('checksum mismatch');
    truncateSync(path, 1024 * 1024 * 1024 + 1);
    await expect(queue.ownedPrintArtifact(1, 1, job.id, 'fronts')).rejects.toThrow('checksum mismatch');
    artifact.fileName = '../outside.pdf';
    const text = JSON.stringify(manifest);
    db.run('UPDATE print_jobs SET manifest_json = ?, manifest_sha256 = ? WHERE id = ?', [text, hash(text), job.id]);
    await expect(queue.ownedPrintArtifact(1, 1, job.id, 'fronts')).rejects.toThrow('missing');
  });
});

describe('station submission, manual refeed, and ambiguity', () => {
  it('rejects a submission that was canceled during checksum verification', async () => {
    const job = await ready({ queueOnReady: true });
    const claimed = await queue.claimPrintJob();
    const hold = await holdVerifiedPdf();
    const submitting = report(claimed, 'submitting', ordinary());
    try {
      await hold.verified;
      queue.cancelPrintJob(1, 1, job.id);
    } finally { hold.release(); }
    await expect(submitting).rejects.toThrow('no longer active');
    expect(queue.getOwnedPrintJob(1, 1, job.id)).toMatchObject({ state: 'canceled', steps: [expect.objectContaining({ state: 'pending' })] });
    expect(db.all('SELECT * FROM print_job_events WHERE job_id = ?', [job.id])).toEqual([]);
  });

  it('does not queue bytes replaced after their exact checksum was calculated', async () => {
    const job = await ready();
    const path = (await queue.ownedPrintArtifact(1, 1, job.id, 'fronts')).path;
    const hold = await holdVerifiedPdf();
    const queueing = queue.queuePrintJob(1, 1, job.id);
    try {
      await hold.verified;
      const bytes = readFileSync(path);
      bytes[bytes.length - 7] ^= 1;
      writeFileSync(path, bytes);
    } finally { hold.release(); }
    await expect(queueing).rejects.toThrow('changed during verification');
    expect(queue.getOwnedPrintJob(1, 1, job.id).state).toBe('ready');
  });

  it('rechecks a discarded queued job before concurrent claims', async () => {
    const first = await ready({ queueOnReady: true });
    const next = await ready({ queueOnReady: true });
    const hold = await holdVerifiedPdf();
    const claimOne = queue.claimPrintJob(), claimTwo = queue.claimPrintJob();
    try {
      await hold.verified;
      queue.cancelPrintJob(1, 1, first.id);
    } finally { hold.release(); }
    const claims = await Promise.all([claimOne, claimTwo]);
    expect(claims.map(claim => claim.id)).toEqual([next.id, next.id]);
    expect(claims[0].claimToken).toBe(claims[1].claimToken);
    expect(queue.getOwnedPrintJob(1, 1, first.id).state).toBe('canceled');
  });

  it('does not reopen another user’s canceled batch when checking a delayed queue after revocation', async () => {
    vi.stubEnv('PRINT_ALLOWED_USER_IDS', '2');
    const first = await ready({ queueOnReady: true });
    const { job: second } = await create({ queueOnReady: true }, 2, 2);
    await queue.processNextPrintJob();
    const hold = await holdVerifiedPdf();
    const claiming = queue.claimPrintJob();
    try {
      await hold.verified;
      queue.cancelPrintJob(1, 1, first.id);
      queue.cancelPrintJob(2, 2, second.id);
      vi.stubEnv('PRINT_ALLOWED_USER_IDS', '');
    } finally { hold.release(); }
    expect(await claiming).toBeNull();
    expect(queue.getOwnedPrintJob(2, 2, second.id).state).toBe('canceled');
  });

  it('coalesces lease polls without adding events and durably renews before expiration', async () => {
    const job = await ready({ queueOnReady: true });
    const claimed = await queue.claimPrintJob();
    const dbPath = join(dir, 'db.sqlite'), before = readFileSync(dbPath);
    expect((await report(claimed, 'heartbeat')).job.leaseExpiresAt).toBe(claimed.leaseExpiresAt);
    expect((await queue.claimPrintJob()).leaseExpiresAt).toBe(claimed.leaseExpiresAt);
    expect(readFileSync(dbPath)).toEqual(before);

    const soon = new Date(Date.now() + 30_000).toISOString();
    db.run('UPDATE print_jobs SET lease_expires_at = ? WHERE id = ?', [soon, job.id]);
    const renewed = (await report(claimed, 'heartbeat')).job.leaseExpiresAt;
    expect(renewed > soon).toBe(true);
    const reopened = new (db.getDb().constructor)(readFileSync(dbPath));
    try { expect(reopened.exec('SELECT lease_expires_at FROM print_jobs')[0].values).toEqual([[renewed]]); }
    finally { reopened.close(); }
    expect(db.all('SELECT * FROM print_job_events WHERE job_id = ?', [job.id])).toEqual([]);
    await report(claimed, 'submitting', ordinary());
    expect(db.all('SELECT * FROM print_job_events WHERE job_id = ?', [job.id])).toHaveLength(1);
  });

  it.each(['missing', 'checksum mismatch'])('isolates an unclaimed %s PDF and claims the next eligible batch', async failure => {
    const first = await ready({ queueOnReady: true });
    const second = await ready({ queueOnReady: true });
    const path = (await queue.ownedPrintArtifact(1, 1, first.id, 'fronts')).path;
    if (failure === 'missing') rmSync(path);
    else {
      const bytes = readFileSync(path);
      bytes[bytes.length - 7] ^= 1;
      writeFileSync(path, bytes);
    }
    const response = await station('/claim', 'POST');
    expect(response.status).toBe(200);
    expect((await response.json()).job.id).toBe(second.id);
    expect(queue.getOwnedPrintJob(1, 1, first.id)).toMatchObject({ state: 'failed', error: expect.stringContaining(failure) });
    expect(db.get('SELECT claim_nonce FROM print_jobs WHERE id = ?', [first.id]).claim_nonce).toBeNull();
    expect(db.all('SELECT * FROM print_job_events WHERE job_id = ?', [first.id])).toEqual([]);
  });

  it('keeps a claimed batch reserved if its PDF disappears', async () => {
    const first = await ready({ queueOnReady: true });
    const claimed = await queue.claimPrintJob();
    const second = await ready({ queueOnReady: true });
    rmSync((await queue.ownedPrintArtifact(1, 1, first.id, 'fronts')).path);
    expect((await station(`/jobs/${first.id}/artifacts/fronts`)).status).toBe(410);
    expect((await queue.claimPrintJob()).id).toBe(first.id);
    expect(queue.getOwnedPrintJob(1, 1, first.id)).toMatchObject({ state: 'claimed', error: expect.stringContaining('PDF artifact is missing') });
    expect(db.all('SELECT * FROM print_job_events WHERE job_id = ?', [first.id])).toEqual([]);
    queue.cancelPrintJob(1, 1, claimed.id);
    expect((await queue.claimPrintJob()).id).toBe(second.id);
  });
  it('rejects owner cancellation between printed packets while preserving the same unsubmitted-cancel receipt', async () => {
    const waiting = await ready({ queueOnReady: true });
    const claimed = await queue.claimPrintJob();
    expect(claimed.id).toBe(waiting.id);
    const canceled = await request(`/api/decks/1/print-jobs/${claimed.id}/cancel`, { method: 'POST' });
    expect(canceled.status).toBe(200);
    const persisted = db.get('SELECT * FROM print_jobs WHERE id = ?', [claimed.id]);
    expect((await request(`/api/decks/1/print-jobs/${claimed.id}/cancel`, { method: 'POST' })).status).toBe(200);
    expect(db.get('SELECT * FROM print_jobs WHERE id = ?', [claimed.id])).toEqual(persisted);

    await readyLargePacketJob();
    const partial = await queue.claimPrintJob();
    await report(partial, 'submitting', ordinary({}));
    await report(partial, 'submitted', ordinary({ spoolerId: 'Epson-partial' }));
    await report(partial, 'completed', ordinary({ spoolerId: 'Epson-partial' }));
    const before = db.get('SELECT * FROM print_jobs WHERE id = ?', [partial.id]);
    expect(before.state).toBe('claimed');
    expect(JSON.parse(before.steps_json)[0].state).toBe('completed');
    expect((await request(`/api/decks/1/print-jobs/${partial.id}/cancel`, { method: 'POST' })).status).toBe(409);
    expect(db.get('SELECT * FROM print_jobs WHERE id = ?', [partial.id])).toEqual(before);
  });

  async function readyLargePacketJob() {
    const job = await readyLegacyPackets(50);
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
  it.each([null, 0, 44, 8.5, '43', true, [], {}])('rejects an invalid artifact capability %j without claiming work', async maxArtifacts => {
    const job = await ready({ queueOnReady: true });
    const before = db.get('SELECT * FROM print_jobs WHERE id = ?', [job.id]);
    const response = await station('/claim', 'POST', { maxArtifacts });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('integer between 1 and 43') });
    expect(db.get('SELECT * FROM print_jobs WHERE id = ?', [job.id])).toEqual(before);
  });
  it('preserves an active physical claim when an older or paused client cannot handle its artifacts', async () => {
    const job = await readyLargePacketJob();
    const claimed = await queue.claimPrintJob(); // Internal callers retain current capacity.
    await report(claimed, 'submitting', ordinary());
    await report(claimed, 'submitted', ordinary({ spoolerId: 'EPSON-42' }));
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
    expect(await queue.claimPrintJob()).toBeNull();
    expect(queue.getOwnedPrintJob(1, 1, job.id).state).toBe('ready');
  });
  it('keeps one FIFO claim, records intent before ack, and deduplicates reports atomically', async () => {
    const first = await ready({ queueOnReady: true });
    const second = await ready({ queueOnReady: true });
    const job = await queue.claimPrintJob();
    expect(job.id).toBe(first.id);
    expect((await queue.claimPrintJob()).id).toBe(first.id);
    const event = { claimToken: job.claimToken, eventId: crypto.randomUUID(), state: 'submitting', artifactId: 'fronts', phase: 'fronts' };
    expect((await queue.reportPrintJob(job.id, event)).replayed).toBe(false);
    expect((await queue.reportPrintJob(job.id, event)).replayed).toBe(true);
    await expect(queue.reportPrintJob(job.id, { ...event, state: 'completed' })).rejects.toThrow('already used');
    await expect(report(job, 'failed', {})).rejects.toThrow('may have happened');
    await report(job, 'submitted', ordinary({ spoolerId: 'Epson-42' }));
    await report(job, 'completed', ordinary({ spoolerId: 'Epson-42' }));
    expect(queue.getOwnedPrintJob(1, 1, job.id).state).toBe('completed');
    expect((await queue.claimPrintJob()).id).toBe(second.id);
    expect(db.all('SELECT event_json FROM print_job_events').every(row => !row.event_json.includes(job.claimToken))).toBe(true);
  });
  it('holds DFC backs until explicit operator refeed and prevents other jobs interleaving', async () => {
    db.run("UPDATE deck_snapshots SET deck_text = '1 Malakir Rebirth // Malakir Mire (ZNR) [111]' WHERE tracked_deck_id = 1");
    const prepared = await ready({ queueOnReady: true });
    const job = await queue.claimPrintJob();
    expect(job.artifacts[0]).toMatchObject({ kind: 'dfc', frontPages: [1], backPages: [2] });
    const front = { artifactId: 'double-faced', phase: 'fronts' }, back = { artifactId: 'double-faced', phase: 'backs' };
    await expect(report(job, 'submitting', back)).rejects.toThrow('not eligible');
    await report(job, 'submitting', front); await report(job, 'submitted', { ...front, spoolerId: 'Epson-1' });
    await report(job, 'completed', { ...front, spoolerId: 'Epson-1' });
    expect(queue.getOwnedPrintJob(1, 1, prepared.id).state).toBe('awaiting_refeed');
    expect((await queue.claimPrintJob()).id).toBe(job.id);
    await expect(report(job, 'submitting', back)).rejects.toThrow();
    await report(job, 'refeed', back); await report(job, 'submitting', back);
    await report(job, 'submitted', { ...back, spoolerId: 'Epson-2' }); await report(job, 'completed', { ...back, spoolerId: 'Epson-2' });
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
    await ready({ queueOnReady: true }); const job = await queue.claimPrintJob();
    const firstFront = { artifactId: 'fronts', phase: 'fronts' }, firstBack = { artifactId: 'fronts', phase: 'backs' };
    const secondFront = { artifactId: 'double-faced', phase: 'fronts' }, secondBack = { artifactId: 'double-faced', phase: 'backs' };
    const finish = async (pass, spoolerId) => {
      await report(job, 'submitting', pass); await report(job, 'submitted', { ...pass, spoolerId }); await report(job, 'completed', { ...pass, spoolerId });
    };
    const sendRefeed = extras => station(`/jobs/${job.id}/report`, 'POST', {
      claimToken: job.claimToken, eventId: crypto.randomUUID(), state: 'refeed', ...extras,
    });
    expect((await sendRefeed(firstBack)).status).toBe(409); // fronts have not printed
    await finish(firstFront, 'Epson-1');
    const before = db.get('SELECT state, steps_json FROM print_jobs WHERE id=?', [job.id]);
    for (const wrong of [{}, { artifactId: 'fronts' }, { phase: 'backs' }, firstFront, secondBack]) {
      expect((await sendRefeed(wrong)).status).toBe(409);
      expect(db.get('SELECT state, steps_json FROM print_jobs WHERE id=?', [job.id])).toEqual(before);
    }
    const original = { claimToken: job.claimToken, eventId: crypto.randomUUID(), state: 'refeed', ...firstBack };
    expect((await queue.reportPrintJob(job.id, original)).replayed).toBe(false);
    await finish(firstBack, 'Epson-2'); await finish(secondFront, 'Epson-3');
    const held = db.get('SELECT state, steps_json FROM print_jobs WHERE id=?', [job.id]);
    expect(held.state).toBe('awaiting_refeed');
    expect((await queue.reportPrintJob(job.id, original)).replayed).toBe(true);
    expect((await sendRefeed(firstBack)).status).toBe(409);
    expect(db.get('SELECT state, steps_json FROM print_jobs WHERE id=?', [job.id])).toEqual(held);
    expect((await sendRefeed(secondBack)).status).toBe(200);
    await finish(secondBack, 'Epson-4');
    expect(queue.getOwnedPrintJob(1, 1, job.id).state).toBe('completed');
  });
  it('rejects refeed when the matching front completion is absent from a malformed recovered step list', async () => {
    db.run("UPDATE deck_snapshots SET deck_text = '1 Malakir Rebirth // Malakir Mire (ZNR) [111]' WHERE tracked_deck_id = 1");
    await ready({ queueOnReady: true }); const job = await queue.claimPrintJob();
    const steps = job.steps.filter(step => step.phase === 'backs');
    db.run("UPDATE print_jobs SET state='awaiting_refeed', steps_json=? WHERE id=?", [JSON.stringify(steps), job.id]);
    await expect(report(job, 'refeed', { artifactId: 'double-faced', phase: 'backs' })).rejects.toThrow('completed fronts');
    expect(queue.getOwnedPrintJob(1, 1, job.id).steps[0].refeedConfirmed).toBe(false);
  });
  it('turns restart after submission intent into uncertainty and requires reconciliation before retry', async () => {
    await ready({ queueOnReady: true }); const job = await queue.claimPrintJob();
    await report(job, 'submitting', ordinary());
    stopQueue = queue.initPrintQueue();
    expect((await queue.claimPrintJob()).state).toBe('uncertain');
    await expect(report(job, 'submitting', ordinary())).rejects.toThrow('not eligible');
    expect(() => queue.cancelPrintJob(1, 1, job.id)).toThrow('spooler submission may exist');
    await report(job, 'reconciled', ordinary({ resolution: 'submitted', spoolerId: 'Epson-42', detail: 'Found the matching immutable title in the spooler' }));
    await report(job, 'completed', ordinary({ spoolerId: 'Epson-42' }));
    expect(queue.getOwnedPrintJob(1, 1, job.id).state).toBe('completed');
  });
  it('releases a pending claim after a printing grant is revoked, without physical submission', async () => {
    await ready({ queueOnReady: true }); const job = await queue.claimPrintJob();
    db.run('UPDATE users SET suspended = 1 WHERE id = 1');
    await expect(report(job, 'submitting', ordinary())).rejects.toThrow('authorization was revoked');
    expect(await queue.claimPrintJob()).toBeNull();
    expect(queue.getOwnedPrintJob(1, 1, job.id).state).toBe('ready');
  });
  it('can explicitly abandon unknown output after an operator clears the paper, without reprinting', async () => {
    await ready({ queueOnReady: true }); const job = await queue.claimPrintJob();
    await report(job, 'submitting', ordinary()); await report(job, 'uncertain', ordinary());
    await expect(report(job, 'reconciled', ordinary({ resolution: 'abandoned', detail: 'Inspected printer' }))).rejects.toThrow();
    await report(job, 'reconciled', ordinary({ resolution: 'abandoned', detail: 'Inspected output, stopped the spooler job and cleared the feeder', paperCleared: true }));
    expect(queue.getOwnedPrintJob(1, 1, job.id)).toMatchObject({ state: 'failed', steps: [expect.objectContaining({ state: 'failed', abandonedFrom: 'uncertain' })] });
    expect(await queue.claimPrintJob()).toBeNull();
  });
  it('keeps claim identity stable when the station authentication credential rotates', async () => {
    await ready({ queueOnReady: true }); const claimed = await queue.claimPrintJob();
    const replacement = 'rotated-station-credential-012345678901234567890123456';
    vi.stubEnv('PRINT_STATION_TOKEN', replacement);
    expect(() => queue.requireStationToken(stationToken)).toThrow('Invalid station credential');
    expect(() => queue.requireStationToken(replacement)).not.toThrow();
    expect((await queue.claimPrintJob()).claimToken).toBe(claimed.claimToken);
    expect((await report(claimed, 'heartbeat')).job.claimToken).toBe(claimed.claimToken);
  });
  it('holds a canceled spooler pass on the server until partial paper is explicitly cleared', async () => {
    await ready({ queueOnReady: true }); const job = await queue.claimPrintJob();
    await report(job, 'submitting', ordinary()); await report(job, 'submitted', ordinary({ spoolerId: 'Epson-1' }));
    const failure = (await report(job, 'failed', ordinary({ spoolerId: 'Epson-1', detail: 'CUPS reports canceled' }))).job;
    expect(failure).toMatchObject({ state: 'uncertain', steps: [expect.objectContaining({ state: 'uncertain', spoolerOutcome: 'failed' })] });
    expect((await queue.claimPrintJob()).id).toBe(job.id);
    await report(job, 'reconciled', ordinary({ resolution: 'abandoned', detail: 'Inspected partial pages and cleared the printer', paperCleared: true }));
    expect(await queue.claimPrintJob()).toBeNull();
  });
  it('requires a live lease before submission but can renew an expired claim safely', async () => {
    await ready({ queueOnReady: true }); const job = await queue.claimPrintJob();
    db.run("UPDATE print_jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [job.id]);
    await expect(report(job, 'submitting', ordinary())).rejects.toThrow('lease expired');
    await report(job, 'heartbeat'); expect((await report(job, 'submitting', ordinary())).job.state).toBe('submitting');
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
    await ready({ queueOnReady: true }); const job = await queue.claimPrintJob();
    db.run("UPDATE print_jobs SET created_at = '2000-01-01T00:00:00.000Z', expires_at = '2000-01-08T00:00:00.000Z'");
    await report(job, 'submitting', ordinary()); await report(job, 'submitted', ordinary({ spoolerId: 'Epson-1' }));
    const completed = (await report(job, 'completed', ordinary({ spoolerId: 'Epson-1' }))).job;
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
    await ready({ queueOnReady: true }); const job = await queue.claimPrintJob();
    await report(job, 'submitting', ordinary());
    expect(() => queue.purgeUserPrintJobs(1)).toThrow('Reconcile active print');
    await report(job, 'reconciled', ordinary({ resolution: 'completed', spoolerId: 'Epson-1', detail: 'Verified completed spooler job' }));
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

describe('deferred back-side scheduling', () => {
  const front = artifactId => ({ artifactId, phase: 'fronts' });
  const back = artifactId => ({ artifactId, phase: 'backs' });
  const row = job => db.get('SELECT * FROM print_jobs WHERE id = ?', [job.id]);
  const cleared = job => { const saved = row(job); return { paperCleared: true, clearanceId: saved.cancel_requested ? `cancel:${saved.cancel_request_id}` : `back:${JSON.parse(saved.back_request_json).id}` }; };
  async function finish(job, pass, spoolerId) {
    await report(job, 'submitting', pass); await report(job, 'submitted', { ...pass, spoolerId });
    return (await report(job, 'completed', { ...pass, spoolerId })).job;
  }
  async function packets() {
    const readyJob = await readyLegacyPackets(8);
    const original = row(readyJob);
    const job = await queue.claimPrintJob({ deferredBacks: true });
    return { job, original };
  }
  async function finishFronts(job) {
    for (const [index, pass] of job.steps.filter(step => step.phase === 'fronts').entries()) await finish(job, front(pass.artifactId), `EPSON-front-${index}`);
    return queue.getOwnedPrintJob(1, 1, job.id);
  }
  it('prints every front first, parks saved backs without a queue blocker and preserves immutable identity', async () => {
    const { job, original } = await packets();
    expect(job.workflow).toBe('deferred-backs-v1');
    expect(job.steps.map(step => step.phase)).toEqual(['fronts', 'fronts', 'fronts', 'backs', 'backs']);
    expect(row(job).manifest_json).toBe(original.manifest_json);
    expect(row(job).manifest_sha256).toBe(original.manifest_sha256);
    await finish(job, front('fronts'), 'EPSON-ordinary');
    await finish(job, front('double-faced-001'), 'EPSON-dfc-1');
    expect(row(job).state).toBe('claimed');
    await finish(job, front('double-faced-002'), 'EPSON-dfc-2');
    expect(row(job)).toMatchObject({ state: 'backs_pending', expires_at: null });
    expect(await queue.claimPrintJob({ deferredBacks: true })).toBeNull();
    const next = await ready({ queueOnReady: true });
    expect((await queue.claimPrintJob({ deferredBacks: true })).id).toBe(next.id);
    expect(row(job).claim_nonce).toBeTruthy();
    expect(queue.formatPrintJob(row(job), true).claimToken).toBe(job.claimToken);
  });
  it('keeps deferred PDFs, pass receipts and saved request through restart and retention cleanup', async () => {
    const { job } = await packets(); await finishFronts(job);
    await queue.preparePrintBacks(row(job), 'double-faced-002', 1);
    db.run("UPDATE print_jobs SET expires_at = '2000-01-01T00:00:00Z', updated_at = '2000-01-01T00:00:00Z' WHERE id = ?", [job.id]);
    const before = row(job);
    stopQueue = queue.initPrintQueue();
    expect(row(job)).toEqual(before);
    expect((await queue.verifiedPrintArtifact(row(job), 'double-faced-002')).path).toBeTruthy();
    expect(() => queue.expireOwnedPrintArtifacts(1, 1, job.id)).toThrow('must be kept');
  });
  it('reserves a selected later packet before refeed and requires blank-paper reset after backs', async () => {
    const { job } = await packets(); await finishFronts(job);
    const originalNotice = db.all('SELECT * FROM print_queue_notifications');
    await queue.preparePrintBacks(row(job), 'double-faced-002', 1);
    const parked = row(job);
    await queue.preparePrintBacks(row(job), 'double-faced-002', 1);
    expect(row(job)).toEqual(parked); // retry is not a new physical request
    expect(db.all('SELECT * FROM print_queue_notifications')).toEqual(originalNotice);
    await expect(queue.preparePrintBacks(row(job), 'double-faced-001', 1)).rejects.toThrow('already requested');
    const reserved = await queue.claimPrintJob({ deferredBacks: true });
    expect(reserved).toMatchObject({ id: job.id, state: 'awaiting_refeed', claimToken: job.claimToken });
    await expect(report(job, 'refeed', back('double-faced-001'))).rejects.toThrow('exact back pass');
    await report(job, 'refeed', back('double-faced-002'));
    expect(() => queue.purgeUserPrintJobs(1)).toThrow('Reconcile active print submissions');
    const reset = await finish(job, back('double-faced-002'), 'EPSON-late-back');
    expect(reset.state).toBe('awaiting_paper_reset');
    expect((await queue.claimPrintJob({ deferredBacks: true })).id).toBe(job.id);
    await expect(report(job, 'paper_ready')).rejects.toThrow('blank paper');
    expect((await report(job, 'paper_ready', cleared(job))).job).toMatchObject({ state: 'backs_pending', backRequest: null });
    expect(await queue.claimPrintJob({ deferredBacks: true })).toBeNull();
    await expect(queue.preparePrintBacks(row(job), 'double-faced-002', 1)).rejects.toThrow('unfinished');
    await queue.preparePrintBacks(row(job), 'double-faced-001', 1); await queue.claimPrintJob({ deferredBacks: true });
    await report(job, 'refeed', back('double-faced-001'));
    await finish(job, back('double-faced-001'), 'EPSON-final-back');
    expect(row(job).state).toBe('awaiting_paper_reset');
    expect((await report(job, 'paper_ready', cleared(job))).job.state).toBe('completed');
  });
  it('waits behind the current physical job before reserving old paper ahead of ordinary queued work', async () => {
    const { job } = await packets(); await finishFronts(job);
    const second = await ready({ queueOnReady: true }), third = await ready({ queueOnReady: true });
    const active = await queue.claimPrintJob({ deferredBacks: true });
    expect(active.id).toBe(second.id);
    await queue.preparePrintBacks(row(job), 'double-faced-001', 1);
    expect((await queue.claimPrintJob({ deferredBacks: true })).id).toBe(second.id);
    await finishFronts(active);
    expect((await queue.claimPrintJob({ deferredBacks: true })).id).toBe(job.id);
    expect(row(third).state).toBe('queued');
  });
  it('blocks an old native client from resuming the new workflow without mutating its saved request', async () => {
    const { job } = await packets(); await finishFronts(job);
    await queue.preparePrintBacks(row(job), 'double-faced-001', 1);
    const before = row(job);
    await expect(queue.claimPrintJob()).rejects.toThrow('deferred back-side');
    expect(row(job)).toEqual(before);
    const invalid = await station('/claim', 'POST', { deferredBacks: 'true' });
    expect(invalid.status).toBe(400);
  });
  it('does not reorder or upgrade an already active legacy physical batch', async () => {
    const prepared = await ready({ queueOnReady: true }); const legacy = await queue.claimPrintJob();
    await report(legacy, 'submitting', front('fronts')); await report(legacy, 'submitted', { ...front('fronts'), spoolerId: 'EPSON-legacy' });
    const before = row(prepared);
    expect((await queue.claimPrintJob({ deferredBacks: true })).workflow).toBeNull();
    expect(row(prepared)).toEqual(before);
  });
  it('cancels only pending backs while ordinary fronts are running and keeps the acknowledged spooler state', async () => {
    const { job } = await packets();
    await report(job, 'submitting', front('fronts')); await report(job, 'submitted', { ...front('fronts'), spoolerId: 'EPSON-live' });
    const result = queue.requestPrintCancellation(row(job), 'backs');
    expect(result).toMatchObject({ state: 'submitted', cancelRequested: null, backsCanceled: 2 });
    expect(result.steps[0]).toMatchObject({ state: 'submitted', spoolerId: 'EPSON-live' });
    await report(job, 'completed', { ...front('fronts'), spoolerId: 'EPSON-live' });
    await finish(job, front('double-faced-001'), 'EPSON-remaining-front-1');
    const last = await finish(job, front('double-faced-002'), 'EPSON-remaining-front-2');
    expect(last).toMatchObject({ state: 'canceled', backsCanceled: 2, frontsCompleted: true });
    expect(await queue.claimPrintJob({ deferredBacks: true })).toBeNull();
  });
  it('cancels parked backs immediately but protects a reserved sheet until native paper clearance', async () => {
    const { job } = await packets(); await finishFronts(job);
    await queue.preparePrintBacks(row(job), 'double-faced-001', 1); await queue.claimPrintJob({ deferredBacks: true });
    const requested = queue.requestPrintCancellation(row(job), 'backs');
    expect(requested).toMatchObject({ state: 'awaiting_refeed', cancelRequested: 'backs' });
    await expect(report(job, 'refeed', back('double-faced-001'))).rejects.toThrow('cancellation');
    await expect(report(job, 'canceled')).rejects.toThrow('paper clearance');
    const canceled = (await report(job, 'canceled', cleared(job))).job;
    expect(canceled).toMatchObject({ state: 'canceled', cancelRequested: null, backRequest: null, backsCanceled: 2, frontsCompleted: true });
    expect(canceled.steps.filter(step => step.phase === 'fronts').every(step => step.state === 'completed')).toBe(true);
  });
  it('keeps requested saved backs and completed front receipts when the packet PDF is missing', async () => {
    const { job } = await packets(); await finishFronts(job);
    await queue.preparePrintBacks(row(job), 'double-faced-001', 1);
    const requested = row(job), next = await ready({ queueOnReady: true });
    rmSync((await queue.ownedPrintArtifact(1, 1, job.id, 'double-faced-001')).path);
    await expect(queue.claimPrintJob({ deferredBacks: true })).rejects.toThrow('PDF artifact is missing');
    expect(row(job)).toMatchObject({ state: 'backs_pending', back_request_json: requested.back_request_json,
      steps_json: requested.steps_json, claim_nonce: requested.claim_nonce,
      error: expect.stringContaining('Resolve or cancel this exact batch') });
    expect(row(next).state).toBe('queued');
    queue.requestPrintCancellation(row(job), 'backs');
    expect((await queue.claimPrintJob({ deferredBacks: true })).id).toBe(next.id);
    expect(JSON.parse(row(job).steps_json).filter(step => step.phase === 'fronts')).toEqual(
      JSON.parse(requested.steps_json).filter(step => step.phase === 'fronts'));
  });
  it('retains active cancellation across a racing final front completion until native acknowledgement', async () => {
    const { job } = await packets();
    await finish(job, front('fronts'), 'EPSON-ordinary'); await finish(job, front('double-faced-001'), 'EPSON-first');
    await report(job, 'submitting', front('double-faced-002')); await report(job, 'submitted', { ...front('double-faced-002'), spoolerId: 'EPSON-last' });
    queue.requestPrintCancellation(row(job), 'all');
    expect((await report(job, 'completed', { ...front('double-faced-002'), spoolerId: 'EPSON-last' })).job).toMatchObject({ state: 'claimed', cancelRequested: 'all' });
    expect(() => queue.purgeUserPrintJobs(1)).toThrow('Reconcile active print submissions');
    expect((await queue.claimPrintJob({ deferredBacks: true })).id).toBe(job.id);
    expect((await report(job, 'canceled', cleared(job))).job.state).toBe('canceled');
  });
  it('freezes requester name for generated page identification', async () => {
    const { job } = await create({ queueOnReady: false });
    db.run("UPDATE users SET username = 'renamed-later' WHERE id = 1");
    await queue.processNextPrintJob();
    expect(JSON.parse(row(job).plan_json).requesterName).toBe('printer');
    expect(services.generatePrintPdfs).toHaveBeenLastCalledWith(expect.objectContaining({ requesterName: 'printer', batchName: 'Deck 1' }));
  });
});
