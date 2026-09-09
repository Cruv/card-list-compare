import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

vi.mock('./archidekt.js', () => ({ fetchDeck: vi.fn() }));
vi.mock('./trackedProviderSource.js', () => ({ fetchTrackedProviderSource: vi.fn() }));
vi.mock('./enrichDeckText.js', () => ({ enrichDeckText: vi.fn(async text => text) }));
vi.mock('./priceCalculator.js', () => ({ computeDeckPrices: vi.fn(async () => null) }));
let directory, db, tracking, source, instanceId, fetchDeck, fetchOther;
const base = '1 Sol Ring (CMM) [396]';
const observation = (text = base) => ({ rawText: text, text, name: 'Provider deck', commanders: [] });
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'clc-source-tracking-'));
  process.env.DB_PATH = join(directory, 'test.db');
  vi.resetModules();
  db = await import('../db.js'); await db.initDb();
  const schema = await import('./integrationSchema.js'); schema.initIntegrationSchema(); schema.initIntegrationSchema();
  instanceId = schema.getInstanceId();
  for (const id of [1, 2]) db.run('INSERT INTO users (id,username,password_hash) VALUES (?,?,?)', [id, `owner${id}`, 'test']);
  tracking = (await import('./sourceTracking.js')).trackIntegrationSource;
  source = await import('./sourceSync.js');
  fetchDeck = (await import('./archidekt.js')).fetchDeck;
  fetchOther = (await import('./trackedProviderSource.js')).fetchTrackedProviderSource;
  fetchDeck.mockReset().mockResolvedValue({ name: 'Archidekt deck', cards: [{ quantity: 1, modifier: 'Normal',
    card: { oracleCard: { name: 'Sol Ring' }, edition: { editioncode: 'CMM' }, collectorNumber: '396' } }] });
  fetchOther.mockReset().mockResolvedValue(observation());
});
afterEach(() => { delete process.env.DB_PATH; rmSync(directory, { recursive: true, force: true }); });
const input = (provider = 'archidekt', userId = 1) => ({ operationId: randomUUID(), expectedAccountId: String(userId), expectedInstanceId: instanceId,
  sourceLink: { provider, deckId: '99', url: `https://${provider === 'deckcheck' ? 'deckcheck.co/deck' : `${provider}.com/decks`}/99` } });
const count = table => db.get(`SELECT COUNT(*) AS count FROM ${table}`).count;

it.each(['archidekt', 'moxfield', 'deckcheck'])('creates durable native %s tracking before fetching and reuses the source on new operations', async provider => {
  const fetcher = provider === 'archidekt' ? fetchDeck : fetchOther;
  const response = await fetcher.getMockImplementation()();
  fetcher.mockImplementation(async () => {
    expect(count('integration_source_tracks')).toBeGreaterThan(0);
    expect(count('tracked_decks')).toBe(1);
    expect(db.get('SELECT source_type,auto_refresh_hours FROM tracked_decks')).toEqual({ source_type: provider, auto_refresh_hours: 1 });
    return response;
  });
  const operation = input(provider);
  const first = await tracking(1, operation);
  expect(first).toMatchObject({ linkedExisting: false, replayed: false, tracking: { status: 'tracked', provider },
    deck: { sourceLink: operation.sourceLink, sourceTracking: { status: 'tracked' }, paperSnapshotId: null } });
  expect(first.deck.snapshots).toHaveLength(1);
  expect(first.deck.snapshots[0].deckText).toBe(base);
  const again = await tracking(1, { ...operation, operationId: randomUUID() });
  expect(again.linkedExisting).toBe(true);
  expect(again.deck.id).toBe(first.deck.id);
  expect(count('tracked_decks')).toBe(1); expect(count('deck_snapshots')).toBe(1);
  expect(count('collection_cards')).toBe(0);
});

it('keeps tracking receipts stable across lost replies, later provider changes, restart, and deletion', async () => {
  const operation = input('moxfield');
  const first = await tracking(1, operation);
  fetchOther.mockResolvedValue(observation('2 Sol Ring (CMM) [396]'));
  await source.refreshArchidektDeck(1, Number(first.deck.id));
  expect(count('deck_snapshots')).toBe(2);
  vi.resetModules(); db = await import('../db.js'); await db.initDb();
  tracking = (await import('./sourceTracking.js')).trackIntegrationSource;
  const replay = await tracking(1, { ...operation, sourceLink: { url: operation.sourceLink.url + '?share=1', deckId: '99', provider: 'moxfield' } });
  expect(replay).toEqual({ ...first, replayed: true });
  await expect(tracking(1, { ...operation, name: 'Different request' })).rejects.toMatchObject({ code: 'operation_conflict' });
  db.run('DELETE FROM tracked_decks WHERE id = ?', [first.deck.id]);
  await expect(tracking(1, operation)).rejects.toMatchObject({ status: 410, code: 'tracked_deck_deleted' });
  expect(count('tracked_decks')).toBe(0);
});

it('promotes a manual provider binding without replacing its local edits or paper marker', async () => {
  const operation = input('deckcheck');
  const manual = (await import('./deckCreation.js')).createIntegrationDeck(1, { ...operation, name: 'My local name', deckText: `${base}\n1 Island` }).deck;
  db.run('UPDATE tracked_decks SET paper_snapshot_id = ? WHERE id = ?', [manual.latestSnapshotId, manual.id]);
  const result = await tracking(1, { ...operation, operationId: randomUUID() });
  expect(result).toMatchObject({ linkedExisting: true, deck: { id: manual.id, name: 'My local name', paperSnapshotId: manual.latestSnapshotId } });
  expect(result.deck.snapshots).toHaveLength(1);
  expect(source.sourceSyncState(1, Number(manual.id))).toMatchObject({ sourceProvider: 'deckcheck', status: 'pending_review',
    baseText: null, currentText: `${base}\n1 Island`, sourceText: base, sourceTracking: { status: 'tracked', message: expect.stringContaining('review') } });
  expect(db.get('SELECT source_type,auto_refresh_hours FROM tracked_decks')).toEqual({ source_type: 'deckcheck', auto_refresh_hours: 1 });
});

it('shows an explicit etched failure while retaining good snapshots, then clears it after a readable scheduled refresh', async () => {
  const first = await tracking(1, input('moxfield'));
  db.run('UPDATE tracked_decks SET paper_snapshot_id = ? WHERE id = ?', [first.deck.latestSnapshotId, first.deck.id]);
  fetchOther.mockRejectedValue(Object.assign(new Error('Unsupported etched finish'), { code: 'unsupported_finish' }));
  const failed = await tracking(1, input('moxfield'));
  expect(failed).toMatchObject({ tracking: { status: 'awaiting_source', message: expect.stringContaining('etched') },
    deck: { sourceTracking: { status: 'awaiting_source', message: expect.stringContaining('etched') }, paperSnapshotId: first.deck.latestSnapshotId } });
  expect(count('deck_snapshots')).toBe(1);
  fetchOther.mockResolvedValue(observation('2 Sol Ring (CMM) [396]'));
  db.run('UPDATE tracked_decks SET last_refreshed_at = NULL');
  await (await import('./notificationScheduler.js')).autoRefreshScheduledDecks();
  expect(source.sourceSyncState(1, Number(first.deck.id))).toMatchObject({ currentText: '2 Sol Ring (CMM) [396]', sourceTracking: { status: 'tracked' } });
  expect(db.get('SELECT paper_snapshot_id FROM tracked_decks').paper_snapshot_id).toBe(Number(first.deck.latestSnapshotId));
});

it('pins the destination account, isolates identical sources, and validates before changing state', async () => {
  const first = await tracking(1, input());
  const second = await tracking(2, input('archidekt', 2));
  expect(second.deck.id).not.toBe(first.deck.id);
  await expect(tracking(2, input())).rejects.toMatchObject({ code: 'connection_changed' });
  for (const change of [{ expectedInstanceId: randomUUID() }, { name: '' }, { deckText: 4 }, { arbitrary: true }, { operationId: 'bad' },
    { sourceLink: { provider: 'archidekt', deckId: '100', url: 'https://archidekt.com/decks/99' } }]) {
    await expect(tracking(1, { ...input(), ...change })).rejects.toBeDefined();
  }
  expect(count('tracked_decks')).toBe(2);
});

it('rolls back source identity, owner, and deck if intent persistence fails, without fetching', async () => {
  db.run("CREATE TRIGGER fail_track_intent BEFORE INSERT ON integration_source_tracks BEGIN SELECT RAISE(ABORT,'intent failure'); END");
  await expect(tracking(1, input())).rejects.toThrow('intent failure');
  for (const table of ['tracked_decks', 'tracked_owners', 'integration_deck_sources', 'integration_source_tracks']) expect(count(table)).toBe(0);
  expect(fetchDeck).not.toHaveBeenCalled();
});

it('distinguishes a linked manual source from a native tracker whose scheduled refresh is paused', async () => {
  const operation = input();
  const manual = (await import('./deckCreation.js')).createIntegrationDeck(1, { ...operation, name: 'Manual linked source', deckText: base }).deck;
  expect(manual.sourceTracking).toBeNull();
  const tracked = await tracking(1, { ...operation, operationId: randomUUID() });
  db.run('UPDATE tracked_decks SET auto_refresh_hours = NULL WHERE id = ?', [tracked.deck.id]);
  const current = (await import('./structuredSnapshots.js')).serializeDeck(db.get('SELECT * FROM tracked_decks WHERE id = ?', [tracked.deck.id]));
  expect(current.sourceTracking).toMatchObject({ status: 'tracked', message: expect.stringContaining('paused') });
});
