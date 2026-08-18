import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir;
let dbPath;
let db;
let prune;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'clc-prune-'));
  dbPath = join(dir, 'test.db');
  process.env.DB_PATH = dbPath;
  vi.resetModules();
  db = await import('../db.js');
  await db.initDb();
  ({ pruneSnapshots: prune } = await import('./pruneSnapshots.js'));
  db.run("INSERT INTO users (username, password_hash) VALUES ('u', 'h')");
  db.run("INSERT INTO tracked_owners (user_id, archidekt_username) VALUES (1, 'o')");
  db.run(
    "INSERT INTO tracked_decks (user_id, tracked_owner_id, archidekt_deck_id, deck_name) VALUES (1, 1, 100, 'D')"
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

function addSnapshot(n, { locked = 0 } = {}) {
  const ts = `2026-01-01 00:00:${String(n).padStart(2, '0')}`;
  db.run(
    'INSERT INTO deck_snapshots (tracked_deck_id, deck_text, locked, created_at) VALUES (1, ?, ?, ?)',
    [`snap${n}`, locked, ts]
  );
  return db.get('SELECT id FROM deck_snapshots WHERE deck_text = ?', [`snap${n}`]).id;
}
function setMax(v) {
  db.run("UPDATE server_settings SET value = ? WHERE key = 'max_snapshots_per_deck'", [String(v)]);
}
function ids() {
  return db.all('SELECT deck_text FROM deck_snapshots WHERE tracked_deck_id = 1 ORDER BY created_at ASC')
    .map(r => r.deck_text);
}

describe('pruneSnapshots', () => {
  it('keeps the N most-recent unlocked snapshots and deletes the oldest excess', () => {
    setMax(3);
    for (let n = 1; n <= 5; n++) addSnapshot(n);
    const deleted = prune(1);
    expect(deleted).toBe(2);
    expect(ids()).toEqual(['snap3', 'snap4', 'snap5']);
  });

  it('treats max = 0 as unlimited and deletes nothing (audit H8)', () => {
    setMax(0);
    for (let n = 1; n <= 5; n++) addSnapshot(n);
    expect(prune(1)).toBe(0);
    expect(ids()).toHaveLength(5);
  });

  it('never deletes locked snapshots and does not count them toward the limit', () => {
    setMax(2);
    addSnapshot(1, { locked: 1 });
    for (let n = 2; n <= 5; n++) addSnapshot(n);
    prune(1);
    // keep 2 newest unlocked (snap4, snap5) + the locked snap1
    expect(ids()).toEqual(['snap1', 'snap4', 'snap5']);
  });

  it('protects the paper snapshot from pruning even when it is the oldest and unlocked', () => {
    setMax(1);
    const paperId = addSnapshot(1); // oldest — would be first to go
    addSnapshot(2);
    addSnapshot(3);
    db.run('UPDATE tracked_decks SET paper_snapshot_id = ? WHERE id = 1', [paperId]);
    prune(1);
    const remaining = ids();
    expect(remaining).toContain('snap1'); // paper survived
    expect(remaining).toContain('snap3'); // newest unlocked survived
    expect(remaining).not.toContain('snap2'); // oldest non-paper pruned
  });
});
