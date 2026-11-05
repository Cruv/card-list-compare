import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

vi.mock('../middleware/rateLimit.js', () => ({ archidektLimiter: (_req, _res, next) => next() }));
let dir, db, router, tokens, refresh;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'clc-library-import-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.JWT_SECRET = 'test-only-clc-library-import-secret';
  vi.resetModules();
  db = await import('../db.js'); await db.initDb();
  (await import('../lib/integrationSchema.js')).initIntegrationSchema();
  const auth = await import('../middleware/auth.js');
  tokens = {};
  for (const id of [1, 2]) {
    db.run('INSERT INTO users(id,username,password_hash) VALUES(?,?,?)', [id, `user${id}`, 'test']);
    tokens[id] = auth.createToken({ id, username: `user${id}` });
  }
  refresh = vi.fn(async () => { throw new Error('Synthetic provider offline'); });
  const { createSourceTrackingService } = await import('../lib/sourceTracking.js');
  const { createDeckImportRouter } = await import('./deckImports.js');
  router = createDeckImportRouter({ trackSource: createSourceTrackingService({ refreshSource: refresh }) });
});
afterEach(() => { delete process.env.DB_PATH; delete process.env.JWT_SECRET; rmSync(dir, { recursive: true, force: true }); });
function request(body, user = 1) {
  return new Promise((resolve, reject) => {
    router.handle({ method: 'POST', url: '/', headers: user ? { authorization: `Bearer ${tokens[user]}` } : {}, body }, {
      statusCode: 200, status(code) { this.statusCode = code; return this; },
      json(value) { resolve({ status: this.statusCode, body: value }); return this; },
    }, error => error ? reject(error) : resolve({ status: 404 }));
  });
}
const manual = () => ({ operationId: randomUUID(), name: 'My paper deck', deckText: "Commander\n1 Jin Sakai, Ghost of Tsushima (sld) [2226]\n\n4 Plains (trk) [317]\n1 Sigarda's Aid (sld) [731] F" });

it('creates a user-owned manual deck and exact first snapshot without a ManaSync connection', async () => {
  const input = manual(), response = await request(input);
  expect(response.status).toBe(201);
  const deck = db.get('SELECT * FROM tracked_decks WHERE id=?', [response.body.deck.id]);
  expect(deck).toMatchObject({ user_id: 1, source_type: 'manual', paper_snapshot_id: null });
  expect(JSON.parse(deck.commanders)).toEqual(['Jin Sakai, Ghost of Tsushima']);
  expect(db.get('SELECT * FROM deck_snapshots WHERE tracked_deck_id=?', [deck.id])).toMatchObject({ deck_text: input.deckText, nickname: 'Imported card list' });
  expect(refresh).not.toHaveBeenCalled();
});
it('replays exact manual creation after reconnect without a second deck or snapshot', async () => {
  const input = manual(), first = await request(input), replay = await request(input);
  expect(replay.status).toBe(200); expect(replay.body).toMatchObject({ replayed: true, deck: first.body.deck });
  expect(db.get('SELECT COUNT(*) AS n FROM tracked_decks').n).toBe(1);
  expect(db.get('SELECT COUNT(*) AS n FROM deck_snapshots').n).toBe(1);
  expect((await request({ ...input, deckText: '2 Sol Ring' })).status).toBe(409);
});
it('isolates identical operation IDs by authenticated account and refuses account fields', async () => {
  const input = manual(), first = await request(input), second = await request(input, 2);
  expect(second.status).toBe(201); expect(second.body.deck.id).not.toBe(first.body.deck.id);
  expect((await request({ ...manual(), expectedAccountId: '2' })).status).toBe(400);
  expect((await request(manual(), null)).status).toBe(401);
});
it.each([
  { name: '', deckText: '1 Sol Ring' }, { name: 'x'.repeat(201), deckText: '1 Sol Ring' },
  { name: 'Empty', deckText: '' }, { name: 'Invalid', deckText: 'Commander\nSideboard' },
  { name: 'Too long', deckText: '1 Sol Ring\n'.repeat(50001) },
])('rejects incomplete manual lists before writing: %o', async body => {
  expect((await request({ operationId: randomUUID(), ...body })).status).toBe(400);
  expect(db.get('SELECT COUNT(*) AS n FROM tracked_decks').n).toBe(0);
});
it.each(['https://archidekt.com.evil.test/decks/123', 'https://example.test/decks/123', 'file:///tmp/list', 'https://user:pass@archidekt.com/decks/123'])('refuses unsupported source %s without fetching', async sourceUrl => {
  expect((await request({ operationId: randomUUID(), sourceUrl })).status).toBe(400);
  expect(refresh).not.toHaveBeenCalled();
});
it('keeps one durable tracked source when the provider is offline, and replays its receipt', async () => {
  const input = { operationId: randomUUID(), sourceUrl: 'https://deckcheck.co/app/builder/zynmTJxDKo28', name: 'Linked deck' };
  const first = await request(input), replay = await request(input);
  expect(first.status).toBe(201); expect(first.body.tracking).toMatchObject({ status: 'awaiting_source', provider: 'deckcheck' });
  expect(replay.status).toBe(200); expect(replay.body.deck.id).toBe(first.body.deck.id);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(db.get('SELECT COUNT(*) AS n FROM tracked_decks').n).toBe(1);
  expect(db.get('SELECT * FROM tracked_decks')).toMatchObject({ source_type: 'deckcheck', auto_refresh_hours: 1 });
  expect((await request({ ...input, sourceUrl: 'https://deckcheck.co/deck/another' })).status).toBe(409);
});
it('reuses a tracked source across new requests without replacing saved content', async () => {
  const input = { operationId: randomUUID(), sourceUrl: 'https://archidekt.com/decks/123', name: 'Original', deckText: '1 Sol Ring' };
  const first = await request(input), second = await request({ ...input, operationId: randomUUID(), name: 'Different', deckText: '3 Island' });
  expect(second.status).toBe(200); expect(second.body.linkedExisting).toBe(true); expect(second.body.deck.id).toBe(first.body.deck.id);
  expect(db.get('SELECT deck_text FROM deck_snapshots').deck_text).toBe('1 Sol Ring');
});
it('a retry cannot recreate a deliberately deleted deck', async () => {
  const input = manual(), first = await request(input);
  db.run('DELETE FROM tracked_decks WHERE id=?', [first.body.deck.id]);
  expect((await request(input)).status).toBe(410);
  expect(db.get('SELECT COUNT(*) AS n FROM tracked_decks').n).toBe(0);
});
