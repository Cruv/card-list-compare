import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import express from 'express';

// Exercise real routes and SQLite with an authenticated fixture user; no live
// accounts, external image services, or production data are used.
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.user = { userId: 1 }; next(); },
}));

let dir, db, queue, server, baseUrl;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'clc-lifecycle-'));
  vi.stubEnv('DB_PATH', join(dir, 'test.db'));
  vi.resetModules();
  db = await import('../db.js');
  await db.initDb();
  queue = await import('../lib/downloadQueue.js');
  db.run("INSERT INTO users (username, password_hash) VALUES ('fixture', 'unused')");
  db.run("INSERT INTO tracked_owners (user_id, archidekt_username) VALUES (1, 'fixture')");
  for (const id of [1, 2]) {
    db.run('INSERT INTO tracked_decks (user_id, tracked_owner_id, archidekt_deck_id, deck_name) VALUES (1, 1, ?, ?)', [id, `Deck ${id}`]);
  }
  const app = express();
  app.use(express.json());
  app.use('/api/decks', (await import('./decks.js')).default);
  app.use('/api/decks', (await import('./snapshots.js')).default);
  app.use('/api/shared-deck', (await import('./shared-decks.js')).default);
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  vi.useRealTimers();
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function snapshot(text, locked = 0) {
  return db.run("INSERT INTO deck_snapshots (tracked_deck_id, deck_text, locked, created_at) VALUES (1, ?, ?, '2026-09-08 12:00:00')", [text, locked]).lastInsertRowid;
}
async function request(path, method = 'GET', body) {
  return fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function completedJob(expiresAt) {
  const snapId = snapshot('1 Sol Ring');
  const file = join(dir, 'fixture.complete.zip');
  writeFileSync(file, 'fixture');
  db.run(`INSERT INTO image_download_jobs
    (id, user_id, tracked_deck_id, snapshot_id, status, file_path, file_size, completed_at, expires_at)
    VALUES ('fixture', 1, 1, ?, 'completed', ?, 7, datetime('now'), ?)`, [snapId, file, expiresAt]);
  return { snapId, file };
}

describe('snapshot selection and physical-deck marker', () => {
  it('lists and compares snapshots by insertion order when timestamps tie', async () => {
    // A valid alternate query plan must not change which snapshot is latest.
    db.run('DROP INDEX idx_deck_snapshots_created');
    const first = snapshot('1 Sol Ring');
    const second = snapshot('1 Lightning Bolt');
    const third = snapshot('1 Counterspell');
    const list = await (await request('/api/decks/1/snapshots')).json();
    expect(list.snapshots.map(s => s.id)).toEqual([third, second, first]);
    const diff = await (await request('/api/decks/1/changelog')).json();
    expect([diff.before.id, diff.after.id]).toEqual([second, third]);
    const timeline = await (await request('/api/decks/1/timeline')).json();
    expect(timeline.entries.map(s => s.snapshotId)).toEqual([first, second, third]);
    const exported = await (await request('/api/decks/export-batch', 'POST', { deckIds: [1] })).json();
    expect(exported.decks[0].text).toBe('1 Counterspell');
  });

  it('reports printing-only revisions in version history, including sideboard changes', async () => {
    const before = snapshot('1 Sol Ring (C21) 263\n\nSideboard\n1 Counterspell (2XM) 47');
    const after = snapshot('1 Sol Ring (CMM) 396\n\nSideboard\n1 Counterspell (DMR) 45');
    const timeline = await (await request('/api/decks/1/timeline')).json();
    expect(timeline.entries.map(entry => entry.snapshotId)).toEqual([before, after]);
    expect(timeline.entries[0].delta).toBeUndefined();
    expect(timeline.entries[1].delta).toEqual({ added: 0, removed: 0, changed: 0, printingChanged: 2 });
  });

  it('uses the same latest snapshot ordering in public shared decks', async () => {
    db.run('DROP INDEX idx_deck_snapshots_created');
    const first = snapshot('1 Sol Ring');
    const second = snapshot('1 Lightning Bolt');
    db.run("INSERT INTO shared_deck_views (id, tracked_deck_id, user_id) VALUES ('fixture', 1, 1)");
    const diff = await (await request('/api/shared-deck/fixture/changelog')).json();
    expect([diff.before.id, diff.after.id]).toEqual([first, second]);
  });

  it('uses only the newest tied snapshot for overlap membership', async () => {
    // Reverse scans expose accidental reliance on which duplicate row wins.
    db.run('PRAGMA reverse_unordered_selects = ON');
    snapshot('1 Lightning Bolt');
    snapshot('2 Sol Ring');
    db.run("INSERT INTO deck_snapshots (tracked_deck_id, deck_text) VALUES (2, '1 Sol Ring')");
    const overlap = await (await request('/api/decks/overlap')).json();
    expect(Object.keys(overlap.sharedCards)).toEqual(['sol ring']);
    expect(overlap.decks.find(deck => deck.id === 1).totalCards).toBe(2);
  });

  it('honors unlimited locks when automatically locking the paper snapshot', async () => {
    db.run("UPDATE server_settings SET value = '0' WHERE key = 'max_locked_per_deck'");
    for (let n = 0; n < 5; n++) snapshot('1 Sol Ring', 1);
    const paper = snapshot('1 Lightning Bolt');
    const response = await request(`/api/decks/1/snapshots/${paper}/paper`, 'PATCH', {});
    expect(response.status).toBe(200);
    expect((await response.json()).autoLocked).toBe(true);
    expect(db.get('SELECT locked FROM deck_snapshots WHERE id = ?', [paper]).locked).toBe(1);
  });

  it('retains the paper marker without exceeding a finite lock limit', async () => {
    db.run("UPDATE server_settings SET value = '1' WHERE key = 'max_locked_per_deck'");
    snapshot('1 Sol Ring', 1);
    const paper = snapshot('1 Lightning Bolt');
    const response = await request(`/api/decks/1/snapshots/${paper}/paper`, 'PATCH', {});
    expect((await response.json()).autoLocked).toBe(false);
    expect(db.get('SELECT paper_snapshot_id FROM tracked_decks WHERE id = 1').paper_snapshot_id).toBe(paper);
  });
});

describe('download lifetime and deck scope', () => {
  it.each(['iso', 'sqlite'])('rejects an expired %s timestamp at file download', async format => {
    const expired = new Date(Date.now() - 60_000).toISOString();
    completedJob(format === 'iso' ? expired : expired.slice(0, 19).replace('T', ' '));
    expect((await request('/api/decks/1/download-jobs/fixture/file')).status).toBe(410);
  });

  it('reuses a completed ZIP only while it is unexpired', () => {
    const { snapId } = completedJob(new Date(Date.now() + 60_000).toISOString());
    vi.useFakeTimers();
    expect(queue.submitJob(1, 1, snapId).isExisting).toBe(true);
    // Keep now and expiry on the same date to expose lexicographic T vs space.
    // SQLite uses the actual clock even while JS worker timers are paused.
    const today = db.get("SELECT date('now') AS day").day;
    db.run('UPDATE image_download_jobs SET expires_at = ?', [`${today}T00:00:00.000Z`]);
    expect(queue.submitJob(1, 1, snapId).isExisting).toBe(false);
  });

  it('refuses a legacy ZIP and queues regeneration with completeness checks', async () => {
    const { snapId } = completedJob(new Date(Date.now() + 60_000).toISOString());
    const legacyFile = join(dir, 'legacy.zip');
    writeFileSync(legacyFile, 'unverified');
    db.run('UPDATE image_download_jobs SET file_path = ?', [legacyFile]);
    const status = await (await request('/api/decks/1/download-jobs/fixture')).json();
    expect(status.status).toBe('failed');
    expect(status.error).toContain('predates completeness checks');
    expect(status.downloadUrl).toBeUndefined();
    expect((await request('/api/decks/1/download-jobs/fixture/file')).status).toBe(400);
    vi.useFakeTimers();
    expect(queue.submitJob(1, 1, snapId).isExisting).toBe(false);
  });

  it('cleans expired ISO ZIPs on startup', () => {
    const today = db.get("SELECT date('now') AS day").day;
    const { file } = completedJob(`${today}T00:00:00.000Z`);
    vi.useFakeTimers();
    queue.initDownloadQueue();
    expect(existsSync(file)).toBe(false);
    expect(queue.getJobStatus('fixture').file_path).toBeNull();
  });

  it('does not resolve a job through a different deck URL', async () => {
    completedJob(new Date(Date.now() + 60_000).toISOString());
    expect((await request('/api/decks/2/download-jobs/fixture')).status).toBe(404);
    expect((await request('/api/decks/2/download-jobs/fixture/file')).status).toBe(404);
  });
});

describe('conflict-safe saved MPC artwork', () => {
  const artwork = identifier => [['sol ring', { identifier, thumbnailUrl: `https://fixture.invalid/${identifier}.png`, dpi: 600 }]];
  const readArtwork = async (id = 1) => (await request(`/api/decks/${id}/mpc-overrides`)).json();
  const saveArtwork = (overrides, baseRevision, id = 1) => request(`/api/decks/${id}/mpc-overrides`, 'PUT', { overrides, baseRevision });

  it('distinguishes a deliberate empty selection from artwork never configured', async () => {
    expect(await readArtwork()).toEqual({ overrides: [], configured: false, revision: 0 });
    const saved = await saveArtwork([], 0);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ saved: true, count: 0, revision: 1 });
    expect(db.get('SELECT mpc_art_overrides FROM tracked_decks WHERE id = 1').mpc_art_overrides).toBe('[]');
    expect(await readArtwork()).toEqual({ overrides: [], configured: true, revision: 1 });
  });

  it('rejects the stale second client without overwriting the newer saved choices or writing the DB', async () => {
    const firstClient = await readArtwork();
    const secondClient = await readArtwork();
    expect((await saveArtwork(artwork('first'), firstClient.revision)).status).toBe(200);
    const diskBeforeConflict = readFileSync(join(dir, 'test.db'));
    const stale = await saveArtwork(artwork('second'), secondClient.revision);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'ARTWORK_CONFLICT', overrides: artwork('first'), configured: true, revision: 1 });
    expect(await readArtwork()).toEqual({ overrides: artwork('first'), configured: true, revision: 1 });
    expect(readFileSync(join(dir, 'test.db'))).toEqual(diskBeforeConflict);
    expect((await saveArtwork(artwork('reviewed'), 1)).status).toBe(200);
    expect(await readArtwork()).toEqual({ overrides: artwork('reviewed'), configured: true, revision: 2 });
  });

  it('guards a deliberate reset against stale artwork and local migration saves', async () => {
    await saveArtwork(artwork('original'), 0);
    await saveArtwork([], 1);
    const staleEdit = await saveArtwork(artwork('stale-edit'), 1);
    const staleMigration = await saveArtwork(artwork('stale-device-cache'), 0);
    expect(staleEdit.status).toBe(409);
    expect(staleMigration.status).toBe(409);
    expect(await staleMigration.json()).toMatchObject({ code: 'ARTWORK_CONFLICT', overrides: [], configured: true, revision: 2 });
    expect(await readArtwork()).toEqual({ overrides: [], configured: true, revision: 2 });
  });

  it('detects intervening saves even when artwork returns to exactly the same bytes', async () => {
    await saveArtwork(artwork('original'), 0);
    const staleClient = await readArtwork();
    await saveArtwork([], 1);
    await saveArtwork(artwork('original'), 2);
    const stale = await saveArtwork(artwork('older-client-edit'), staleClient.revision);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ overrides: artwork('original'), revision: 3 });
  });

  it('rejects a same-base replay after a lost response instead of applying it twice', async () => {
    await saveArtwork(artwork('accepted'), 0); // The client does not consume this response.
    const replay = await saveArtwork(artwork('accepted'), 0);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: 'ARTWORK_CONFLICT', overrides: artwork('accepted'), revision: 1 });
    expect(await readArtwork()).toEqual({ overrides: artwork('accepted'), configured: true, revision: 1 });
  });

  it('requires versioned clients rather than silently accepting old unguarded saves', async () => {
    const response = await request('/api/decks/1/mpc-overrides', 'PUT', { overrides: artwork('old-client') });
    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({ code: 'ARTWORK_REVISION_REQUIRED', error: expect.stringContaining('Reload CLC') });
    expect(await readArtwork()).toEqual({ overrides: [], configured: false, revision: 0 });
  });

  it.each([-1, 0.5, '0', null, true, Number.MAX_SAFE_INTEGER + 1])('rejects malformed revision %s', async baseRevision => {
    const response = await saveArtwork(artwork('bad-revision'), baseRevision);
    expect(response.status).toBe(400);
    expect(await readArtwork()).toEqual({ overrides: [], configured: false, revision: 0 });
  });

  it.each([null, {}, ['sol ring'], [[null, {}]], [['sol ring', null]], [['sol ring', []]], [['', {}]]])('rejects malformed artwork pairs %j', async overrides => {
    expect((await saveArtwork(overrides, 0)).status).toBe(400);
    expect(await readArtwork()).toEqual({ overrides: [], configured: false, revision: 0 });
  });

  it('retains the existing 612-face limit', async () => {
    const faces = Array.from({ length: 613 }, (_, index) => [`card ${index}`, { identifier: String(index) }]);
    expect((await saveArtwork(faces, 0)).status).toBe(400);
    expect(await readArtwork()).toEqual({ overrides: [], configured: false, revision: 0 });
  });

  it('does not disclose foreign or deleted artwork/revisions even to malformed or stale writes', async () => {
    db.run("INSERT INTO users (id, username, password_hash) VALUES (2, 'foreign', 'unused')");
    db.run("INSERT INTO tracked_owners (id, user_id, archidekt_username) VALUES (2, 2, 'foreign')");
    db.run(`INSERT INTO tracked_decks (id, user_id, tracked_owner_id, archidekt_deck_id, deck_name, mpc_art_overrides, mpc_art_revision)
      VALUES (3, 2, 2, 3, 'Foreign deck', ?, 7)`, [JSON.stringify(artwork('private'))]);
    db.run('DELETE FROM tracked_decks WHERE id = 1');
    for (const id of [1, 3, 999]) {
      for (const body of [undefined, { overrides: [] }, { overrides: [], baseRevision: 0 }]) {
        const response = await request(`/api/decks/${id}/mpc-overrides`, body ? 'PUT' : 'GET', body);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'Deck not found' });
      }
    }
    expect(db.get('SELECT mpc_art_revision FROM tracked_decks WHERE id = 3').mpc_art_revision).toBe(7);
  });

  it('preserves valid legacy pairs on read while excluding malformed Map entries', async () => {
    db.run('UPDATE tracked_decks SET mpc_art_overrides = ? WHERE id = 1', [JSON.stringify([...artwork('valid'), null, ['bad', null]])]);
    expect(await readArtwork()).toEqual({ overrides: artwork('valid'), configured: true, revision: 0 });
  });

  it('rolls back both artwork and revision after a disk failure and permits a durable retry', async () => {
    await saveArtwork(artwork('original'), 0);
    const dbPath = join(dir, 'test.db');
    const diskBeforeFailure = readFileSync(dbPath);
    mkdirSync(`${dbPath}.tmp`);
    const failed = await saveArtwork(artwork('retry'), 1);
    expect(failed.status).toBe(500);
    expect(await readArtwork()).toEqual({ overrides: artwork('original'), configured: true, revision: 1 });
    expect(readFileSync(dbPath)).toEqual(diskBeforeFailure);
    expect(db.get('PRAGMA foreign_keys').foreign_keys).toBe(1);
    rmSync(`${dbPath}.tmp`, { recursive: true });
    const retry = await saveArtwork(artwork('retry'), 1);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ saved: true, count: 1, revision: 2 });
    const persisted = new (db.getDb().constructor)(readFileSync(dbPath));
    try {
      expect(persisted.exec('SELECT mpc_art_overrides, mpc_art_revision FROM tracked_decks WHERE id = 1')[0].values)
        .toEqual([[JSON.stringify(artwork('retry')), 2]]);
    } finally { persisted.close(); }
  });
});
