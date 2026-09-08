import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
  const file = join(dir, 'fixture.zip');
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

describe('saved MPC artwork reset', () => {
  it('distinguishes a deliberate empty selection from artwork never configured', async () => {
    expect(await (await request('/api/decks/1/mpc-overrides')).json())
      .toEqual({ overrides: [], configured: false });
    const saved = await request('/api/decks/1/mpc-overrides', 'PUT', { overrides: [] });
    expect(saved.status).toBe(200);
    expect(db.get('SELECT mpc_art_overrides FROM tracked_decks WHERE id = 1').mpc_art_overrides).toBe('[]');
    expect(await (await request('/api/decks/1/mpc-overrides')).json())
      .toEqual({ overrides: [], configured: true });
  });
});
