import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

vi.mock('./archidekt.js', () => ({ fetchDeck: vi.fn() }));
vi.mock('./enrichDeckText.js', () => ({ enrichDeckText: vi.fn(async text => text) }));
vi.mock('./priceCalculator.js', () => ({ computeDeckPrices: vi.fn(async () => null) }));
vi.mock('../middleware/rateLimit.js', () => ({ archidektLimiter: (_req, _res, next) => next() }));

let directory, db, source, snapshots, proposals, fetchDeck, enrich, session, sourceRouter, deckRouter;
const baseText = '1 Sol Ring (CMM) [396]';
const localText = `${baseText}\n1 Island (DMU) [265]`;
const changedText = `2 Sol Ring (CMM) [396]`;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'clc-source-sync-'));
  process.env.DB_PATH = join(directory, 'test.db');
  process.env.JWT_SECRET = 'test-only-source-sync-secret';
  vi.resetModules();
  db = await import('../db.js'); await db.initDb();
  (await import('./integrationSchema.js')).initIntegrationSchema();
  source = await import('./sourceSync.js');
  snapshots = await import('./structuredSnapshots.js');
  proposals = await import('./deckProposals.js');
  fetchDeck = (await import('./archidekt.js')).fetchDeck; fetchDeck.mockReset();
  enrich = (await import('./enrichDeckText.js')).enrichDeckText; enrich.mockReset().mockImplementation(async text => text);
  for (const id of [1, 2]) {
    db.run('INSERT INTO users (id,username,password_hash) VALUES (?,?,?)', [id, `user${id}`, 'test']);
    db.run('INSERT INTO tracked_owners (id,user_id,archidekt_username) VALUES (?,?,?)', [id, id, `owner${id}`]);
    db.run('INSERT INTO tracked_decks (id,user_id,tracked_owner_id,archidekt_deck_id,deck_name) VALUES (?,?,?,?,?)', [id, id, id, id, `Deck ${id}`]);
  }
  const auth = await import('../middleware/auth.js');
  session = [null, ...[1, 2].map(id => auth.createToken({ id, username: `user${id}` }))];
  sourceRouter = (await import('../routes/sourceSync.js')).default;
  deckRouter = (await import('../routes/decks.js')).default;
});
afterEach(() => {
  delete process.env.DB_PATH; delete process.env.JWT_SECRET;
  rmSync(directory, { recursive: true, force: true });
});
const observe = (text = baseText, overrides = {}) => source.observeSource(1, 1, { rawText: text, text, name: 'Archidekt deck', ...overrides });
const state = () => source.sourceSyncState(1, 1);
const count = () => db.get('SELECT COUNT(*) AS count FROM deck_snapshots WHERE tracked_deck_id = 1').count;
function addSnapshot(text) {
  return String(db.run('INSERT INTO deck_snapshots (tracked_deck_id,deck_text) VALUES (1,?)', [text]).lastInsertRowid);
}
function acceptProposal(text = localText) {
  const current = snapshots.latestSnapshot(1);
  const { receipt } = proposals.submitProposal(1, '1', { operationId: randomUUID(), baseSnapshotId: String(current.id),
    baseText: current.deck_text, baseTextHash: snapshots.textHash(current.deck_text), proposedText: text });
  return proposals.reviewProposal(1, '1', receipt.proposalId, { operationId: randomUUID(), action: 'accept',
    expectedProposalRevision: receipt.proposalRevision, expectedLatestSnapshotId: receipt.currentLatestSnapshotId,
    expectedLatestTextHash: receipt.currentLatestTextHash });
}
function review(action = 'keep', extra = {}) {
  const current = state();
  return { operationId: randomUUID(), expectedRevision: current.revision, expectedCurrentSnapshotId: current.currentSnapshotId,
    expectedCurrentTextHash: current.currentTextHash, action, ...extra };
}
function upstream(quantity = 1, overrides = {}) {
  return { name: 'Archidekt deck', cards: [{ quantity, card: { oracleCard: { name: 'Sol Ring' },
    edition: { editioncode: 'CMM' }, collectorNumber: '396' }, categories: [], ...overrides }] };
}
function request(router, method, url, token, body) {
  return new Promise((resolve, reject) => {
    const req = { method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, body };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
      json(value) { resolve({ status: this.statusCode, body: value }); return this; } };
    router.handle(req, res, error => error ? reject(error) : resolve({ status: 404 }));
  });
}

it('preserves an accepted ManaSync edit when Archidekt is unchanged, then stages a changed source', () => {
  expect(observe()).toMatchObject({ changed: true, pendingReview: false, sourceSync: { status: 'synced', revision: 1 } });
  const paperId = state().currentSnapshotId;
  db.run('UPDATE tracked_decks SET paper_snapshot_id = ? WHERE id = 1', [paperId]);
  const accepted = acceptProposal();
  expect(observe()).toMatchObject({ changed: false, pendingReview: false, sourceSync: { status: 'local_changes', currentSnapshotId: accepted.resultSnapshotId } });
  expect(observe(changedText)).toMatchObject({ changed: false, pendingReview: true, sourceSync: {
    status: 'pending_review', baseText, sourceText: changedText, currentText: localText } });
  expect(count()).toBe(2);
  expect(db.get('SELECT paper_snapshot_id FROM tracked_decks WHERE id = 1').paper_snapshot_id).toBe(Number(paperId));
  expect(db.get('SELECT COUNT(*) AS count FROM collection_cards').count).toBe(0);
});

it('advances known source-only decks automatically and protects legacy heads with no proven source baseline', () => {
  expect(state()).toMatchObject({ status: 'unknown', revision: 0, currentText: null });
  addSnapshot(localText);
  expect(observe()).toMatchObject({ changed: false, pendingReview: true, sourceSync: { baseText: null, currentText: localText } });
  source.reviewSource(1, 1, review('source'));
  expect(observe(changedText)).toMatchObject({ changed: true, sourceSync: { status: 'synced', currentText: changedText } });
});

it('establishes a legacy baseline only when its existing current text agrees with fetched source', () => {
  addSnapshot('1 Sol Ring (cmm) 396\r\n');
  expect(observe()).toMatchObject({ changed: false, pendingReview: false, sourceSync: { status: 'synced', baseText } });
  expect(count()).toBe(1);
});

it('keep acknowledges once, leaves the digital head intact and only asks again for another source change', () => {
  observe(); acceptProposal(); observe(changedText);
  const operation = review();
  const kept = source.reviewSource(1, 1, operation);
  expect(kept).toMatchObject({ status: 'local_changes', baseText: changedText, sourceText: changedText, currentText: localText, pending: false, resultSnapshotId: null });
  expect(observe(changedText)).toMatchObject({ changed: false, pendingReview: false });
  expect(source.reviewSource(1, 1, operation)).toEqual({ ...kept, replayed: true });
  expect(() => source.reviewSource(1, 1, { ...operation, action: 'source' })).toThrow('operation_conflict');
  expect(count()).toBe(2);
  expect(observe('3 Sol Ring (CMM) [396]')).toMatchObject({ changed: false, pendingReview: true });
});

it.each(['source', 'merge'])('atomically applies %s once and replays the original receipt after restart and later edits', async action => {
  observe(); acceptProposal(); observe(changedText);
  const exact = 'Mainboard\r\n2 Sol Ring (CMM) 396\r\n1 Island (DMU) 265\r\n// exact note  \r\n';
  const operation = review(action, action === 'merge' ? { reviewedText: exact } : {});
  const applied = source.reviewSource(1, 1, operation);
  expect(applied.currentText).toBe(action === 'merge' ? exact : changedText);
  expect(applied.status).toBe(action === 'merge' ? 'local_changes' : 'synced');
  expect(applied.currentSnapshotId).toBe(applied.resultSnapshotId);
  expect(count()).toBe(3);
  addSnapshot('1 Newer Manual Card');
  vi.resetModules(); db = await import('../db.js'); await db.initDb(); source = await import('./sourceSync.js');
  expect(source.reviewSource(1, 1, operation)).toEqual({ ...applied, replayed: true });
  expect(state().currentText).toBe('1 Newer Manual Card');
  expect(count()).toBe(4);
});

it('rejects changed source revisions, changed current snapshot pins, foreign accounts and invalid merge requests', () => {
  observe(); acceptProposal(); observe(changedText);
  const stale = review('source');
  observe('3 Sol Ring (CMM) [396]');
  expect(() => source.reviewSource(1, 1, stale)).toThrow('source_changed');
  const currentStale = review('source'); addSnapshot(localText);
  expect(() => source.reviewSource(1, 1, currentStale)).toThrow('latest_changed');
  expect(() => source.reviewSource(1, 1, { ...review('source'), expectedCurrentTextHash: '0'.repeat(64) })).toThrow('latest_changed');
  expect(() => source.reviewSource(2, 1, review())).toThrow('deck_not_found');
  expect(() => source.sourceSyncState(2, 1)).toThrow('deck_not_found');
  for (const reviewedText of ['', '  ', 'x'.repeat(500001)]) {
    expect(() => source.reviewSource(1, 1, review('merge', { reviewedText }))).toThrow('invalid_source_review');
  }
  expect(() => source.reviewSource(1, 1, review('keep', { reviewedText: '1 Sol Ring' }))).toThrow('invalid_source_review');
});

it('rolls back the source decision and digital snapshot if durable receipt storage fails', () => {
  observe(); acceptProposal(); observe(changedText);
  const before = state();
  db.run("CREATE TRIGGER fail_source_receipt BEFORE INSERT ON deck_source_reviews BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
  expect(() => source.reviewSource(1, 1, review('source'))).toThrow('receipt failure');
  expect(state()).toEqual(before);
  expect(count()).toBe(2);
});

it('retains exact acknowledged and pending source texts after snapshot pruning and database restart', async () => {
  observe();
  const initial = state().currentSnapshotId;
  db.run("UPDATE server_settings SET value = '1' WHERE key = 'max_snapshots_per_deck'");
  acceptProposal(); observe(changedText);
  expect(db.get('SELECT id FROM deck_snapshots WHERE id = ?', [initial])).toBeNull();
  const before = state();
  vi.resetModules(); db = await import('../db.js'); await db.initDb(); source = await import('./sourceSync.js');
  expect(state()).toEqual(before);
  expect(state()).toMatchObject({ baseText, sourceText: changedText, currentText: localText, pending: true });
});

it('treats formatting as equivalent but keeps effective boards, commander, quantities, editions and finish distinct', () => {
  const key = source.sourceTextKey;
  expect(key('1 Sol Ring (CMM) [396]\n1 Island (DMU) 265')).toBe(key('1 Island (dmu) [265]\r\n1 Sol Ring (cmm) 396\r\n'));
  expect(key(localText)).not.toBe(key(`${baseText}\n\n1 Island (DMU) [265]`));
  expect(key('1 Sol Ring (CMM) 396\n\n1 Sol Ring (LCC) 313'))
    .not.toBe(key('1 Sol Ring (LCC) 313\n\n1 Sol Ring (CMM) 396'));
  expect(key(baseText)).not.toBe(key(`Commander\n${baseText}`));
  expect(key(baseText)).not.toBe(key(`${baseText} *F*`));
  expect(key(baseText)).not.toBe(key('1 Sol Ring (LCC) [396]'));
  expect(key(baseText)).not.toBe(key(changedText));
  observe(localText); acceptProposal(`${baseText}\n\n1 Island (DMU) [265]`);
  expect(observe(changedText)).toMatchObject({ changed: false, pendingReview: true });
});

it('separates raw source changes from enrichment drift without hiding explicit printing changes', async () => {
  observe(baseText, { rawText: '1 Sol Ring' });
  expect(observe('1 Sol Ring (LCC) [313]', { rawText: '1 Sol Ring' })).toMatchObject({ changed: false, pendingReview: false });
  expect(state()).toMatchObject({ status: 'synced', baseText, currentText: baseText });
  acceptProposal();
  fetchDeck.mockResolvedValue(upstream(1, { card: { oracleCard: { name: 'Sol Ring' }, edition: { editioncode: 'LEA' } } }));
  enrich.mockResolvedValue(baseText);
  expect(await source.refreshArchidektDeck(1, 1)).toMatchObject({ changed: false, pendingReview: true,
    sourceSync: { sourceText: '1 Sol Ring (LEA)', currentText: localText } });
  expect(source.preservesSourceIdentity('1 Sol Ring', `${baseText} *F*`)).toBe(false);
  expect(source.preservesSourceIdentity('1 Sol Ring *F*', baseText)).toBe(false);
  expect(source.preservesSourceIdentity('1 Sol Ring', baseText)).toBe(true);
  expect(source.preservesSourceIdentity('2 Sol Ring', baseText)).toBe(false);
});

it('re-reads the digital head at commit when a ManaSync proposal is accepted during a source fetch', async () => {
  observe();
  let release;
  fetchDeck.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const refreshing = source.refreshArchidektDeck(1, 1);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const accepted = acceptProposal();
  release(upstream(2));
  expect(await refreshing).toMatchObject({ changed: false, pendingReview: true, sourceSync: { currentSnapshotId: accepted.resultSnapshotId, currentText: localText } });
  expect(count()).toBe(2);
});

it('serializes concurrent upstream requests and compares against a review committed while downloading', async () => {
  observe(); acceptProposal(); observe(changedText);
  let release;
  fetchDeck.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce(upstream(4));
  const first = source.refreshArchidektDeck(1, 1);
  const second = source.refreshArchidektDeck(1, 1);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(fetchDeck).toHaveBeenCalledTimes(1);
  source.reviewSource(1, 1, review('keep'));
  release(upstream(3));
  expect(await first).toMatchObject({ changed: false, pendingReview: true });
  expect(await second).toMatchObject({ changed: false, pendingReview: true, sourceSync: { sourceText: '4 Sol Ring (CMM) [396]', baseText: changedText, currentText: localText } });
  expect(fetchDeck).toHaveBeenCalledTimes(2);
});

it('rejects incomplete upstream responses, permits a genuine empty deck and keeps user-set commander metadata', async () => {
  observe(); db.run('UPDATE tracked_decks SET commanders = ? WHERE id = 1', [JSON.stringify(['Chosen commander'])]);
  const before = state();
  for (const data of [{ name: 'Missing cards' }, { cards: [{}] }, { cards: [{ quantity: 0, card: { name: 'Sol Ring' } }] },
    upstream(1, { card: { name: 'Real\n2 Invented' } }),
    upstream(1, { card: { name: 'Real', edition: { editioncode: 'CMM\n2 Invented' } } }),
    upstream(1, { card: { name: 'Real', edition: { editioncode: 'CMM' }, collectorNumber: '396\n2 Invented' } }),
  ]) {
    fetchDeck.mockResolvedValue(data);
    await expect(source.refreshArchidektDeck(1, 1)).rejects.toMatchObject({ code: 'invalid_source_response' });
    expect(state()).toEqual(before);
  }
  fetchDeck.mockResolvedValue(upstream(2));
  await source.refreshArchidektDeck(1, 1);
  expect(db.get('SELECT commanders FROM tracked_decks WHERE id = 1').commanders).toBe('["Chosen commander"]');
  fetchDeck.mockResolvedValue({ name: 'Empty deck', cards: [] });
  expect(await source.refreshArchidektDeck(1, 1)).toMatchObject({ changed: true, sourceSync: { currentText: '', status: 'synced' } });
});

it('protects source review routes with owned sessions and exposes source summaries in deck lists', async () => {
  observe(); acceptProposal(); observe(changedText);
  expect((await request(sourceRouter, 'GET', '/1/source-sync', session[1])).body).toEqual(state());
  expect((await request(sourceRouter, 'GET', '/1/source-sync', session[2])).status).toBe(404);
  expect((await request(sourceRouter, 'POST', '/1/source-sync/review', session[2], review())).status).toBe(404);
  for (const method of ['GET', 'POST']) {
    expect((await request(sourceRouter, method, `/1/source-sync${method === 'POST' ? '/review' : ''}`, 'clcit_scoped_integration', review())).status).toBe(401);
  }
  const list = await request(deckRouter, 'GET', '/', session[1]);
  expect(list.body.decks[0].source_sync).toMatchObject({ status: 'pending_review', pending: true });
  const operation = review('source');
  expect((await request(sourceRouter, 'POST', '/1/source-sync/review', session[1], operation)).body).toMatchObject({ status: 'synced', replayed: false });
  expect((await request(sourceRouter, 'POST', '/1/source-sync/review', session[1], operation)).body.replayed).toBe(true);
  db.run("UPDATE tracked_decks SET source_type = 'manual', archidekt_deck_id = -1 WHERE id = 1");
  expect((await request(sourceRouter, 'GET', '/1/source-sync', session[1])).status).toBe(409);
  expect((await request(deckRouter, 'GET', '/', session[1])).body.decks[0].source_sync).toBeNull();
});

it('uses the coordinator for initial tracking, manual refresh, bulk refresh, notifications and scheduled auto refresh', async () => {
  fetchDeck.mockResolvedValue(upstream());
  const tracked = await request(deckRouter, 'POST', '/', session[1], { trackedOwnerId: 1, archidektDeckId: 99, deckName: 'Tracked' });
  expect(tracked.status).toBe(201);
  expect(tracked.body.deck.source_sync.status).toBe('synced');
  observe(); acceptProposal();
  fetchDeck.mockResolvedValue(upstream(2));
  const single = await request(deckRouter, 'POST', '/1/refresh', session[1]);
  expect(single.body).toMatchObject({ changed: false, pendingReview: true });
  const bulk = await request(deckRouter, 'POST', '/refresh-all', session[1]);
  expect(bulk.body.summary.pendingReview).toBe(1);
  expect(bulk.body.results.find(result => result.deckId === 1)).toMatchObject({ changed: false, pendingReview: true });
  const scheduler = await import('./notificationScheduler.js');
  expect(await scheduler.processSingleDeck(db.get('SELECT * FROM tracked_decks WHERE id = 1'))).toMatchObject({ changed: false, pendingReview: true });
  db.run('UPDATE tracked_decks SET auto_refresh_hours = 6, last_refreshed_at = NULL WHERE id = 1');
  await scheduler.autoRefreshScheduledDecks();
  expect(state()).toMatchObject({ status: 'pending_review', currentText: localText, sourceText: changedText });
  expect(count()).toBe(2);
  expect(fetchDeck).toHaveBeenCalledTimes(6);
});


it('keeps an existing pending candidate under review after the current head is returned to the old baseline', () => {
  observe(); acceptProposal(); observe(changedText);
  addSnapshot(baseText);
  expect(observe(changedText)).toMatchObject({ changed: false, pendingReview: true, sourceSync: { currentText: baseText } });
  expect(source.reviewSource(1, 1, review('source'))).toMatchObject({ status: 'synced', currentText: changedText });
});

async function createManualSourceDeck(sourceLink = { provider: 'archidekt', deckId: '99', url: 'https://archidekt.com/decks/99' }) {
  const { createIntegrationDeck } = await import('./deckCreation.js');
  const { getInstanceId } = await import('./integrationSchema.js');
  return createIntegrationDeck(1, { operationId: randomUUID(), name: 'My protected manual deck', deckText: localText,
    expectedAccountId: '1', expectedInstanceId: getInstanceId(), sourceLink }).deck;
}

it('promotes the same ManaSync-created source deck on native tracking while protecting its digital and paper history', async () => {
  const manual = await createManualSourceDeck();
  const paperId = Number(manual.latestSnapshotId);
  const latestId = db.run('INSERT INTO deck_snapshots (tracked_deck_id,deck_text,nickname) VALUES (?,?,?)',
    [manual.id, `${localText}\n// intentional local note`, 'My local edit']).lastInsertRowid;
  db.run('UPDATE tracked_decks SET paper_snapshot_id = ?, notes = ? WHERE id = ?', [paperId, 'Keep my notes', manual.id]);
  fetchDeck.mockResolvedValue(upstream(2));
  const input = { trackedOwnerId: 1, archidektDeckId: 99, deckName: 'Provider display name', deckUrl: 'https://archidekt.com/decks/99/title' };
  const promoted = await request(deckRouter, 'POST', '/', session[1], input);
  expect(promoted).toMatchObject({ status: 200, body: { linkedExisting: true, deck: {
    id: Number(manual.id), tracked_owner_id: 1, archidekt_deck_id: 99, source_type: 'archidekt',
    deck_url: 'https://archidekt.com/decks/99', deck_name: 'My protected manual deck',
    paper_snapshot_id: paperId, notes: 'Keep my notes', source_sync: { status: 'pending_review', pending: true }
  } } });
  expect(source.sourceSyncState(1, Number(manual.id))).toMatchObject({ baseText: null, sourceText: changedText,
    currentText: `${localText}\n// intentional local note`, currentSnapshotId: String(latestId) });
  expect(db.all('SELECT id FROM deck_snapshots WHERE tracked_deck_id = ?', [manual.id]).map(row => row.id)).toEqual([paperId, latestId]);
  expect(db.get('SELECT COUNT(*) AS count FROM tracked_decks WHERE user_id = 1').count).toBe(2);
  const again = await request(deckRouter, 'POST', '/', session[1], input);
  expect(again.body.deck.id).toBe(Number(manual.id));
  expect(db.get('SELECT COUNT(*) AS count FROM tracked_decks WHERE user_id = 1').count).toBe(2);
  const other = await request(deckRouter, 'POST', '/', session[2], { ...input, trackedOwnerId: 2 });
  expect(other.status).toBe(201);
  expect(other.body.deck.id).not.toBe(Number(manual.id));
  expect(db.get('SELECT COUNT(*) AS count FROM collection_cards').count).toBe(0);
});

it('rejects ambiguous native/manual source matches before metadata changes or provider fetches', async () => {
  const manual = await createManualSourceDeck(null);
  db.run('INSERT INTO integration_deck_sources (deck_id,user_id,provider,source_deck_id,canonical_url) VALUES (?,?,?,?,?)',
    [manual.id, 1, 'archidekt', '1', 'https://archidekt.com/decks/1']);
  const before = db.get('SELECT * FROM tracked_decks WHERE id = ?', [manual.id]);
  fetchDeck.mockClear();
  const result = await request(deckRouter, 'POST', '/', session[1], { trackedOwnerId: 1, archidektDeckId: 1, deckName: 'A duplicate' });
  expect(result).toMatchObject({ status: 409, body: { error: 'source_identity_conflict' } });
  expect(db.get('SELECT * FROM tracked_decks WHERE id = ?', [manual.id])).toEqual(before);
  expect(db.get('SELECT COUNT(*) AS count FROM tracked_decks').count).toBe(3);
  expect(fetchDeck).not.toHaveBeenCalled();
});

it('retains one promoted deck and its unknown basis when the first source fetch is unavailable', async () => {
  const manual = await createManualSourceDeck();
  const originalError = vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchDeck.mockRejectedValue(new Error('Provider unavailable'));
  try {
    const result = await request(deckRouter, 'POST', '/', session[1], { trackedOwnerId: 1, archidektDeckId: 99, deckName: 'Changed' });
    expect(result).toMatchObject({ status: 200, body: { linkedExisting: true, deck: { id: Number(manual.id), source_sync: { status: 'unknown' } } } });
    expect(source.sourceSyncState(1, Number(manual.id))).toMatchObject({ currentText: localText, sourceText: null, baseText: null });
    expect(db.get('SELECT COUNT(*) AS count FROM tracked_decks').count).toBe(3);
  } finally { originalError.mockRestore(); }
});
