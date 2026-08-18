import { get, all, run } from '../db.js';

/**
 * Prune unlocked snapshots for a deck, keeping only the most recent N unlocked ones.
 * Locked snapshots are never deleted and don't count toward the limit.
 * @param {number} trackedDeckId
 * @returns {number} Number of snapshots deleted
 */
export function pruneSnapshots(trackedDeckId) {
  const setting = get("SELECT value FROM server_settings WHERE key = 'max_snapshots_per_deck'");
  // NaN-guard, NOT `|| 25`: a stored '0' means unlimited and must survive parsing
  // (a truthy-fallback turned 0 into 25 and silently deleted history — audit H8).
  const parsed = parseInt(setting?.value, 10);
  const max = Number.isNaN(parsed) ? 25 : parsed;
  if (max <= 0) return 0; // 0 means unlimited

  // The paper snapshot is protected from pruning even when it could not be
  // auto-locked (lock limit reached) — otherwise the deck's paper_snapshot_id is
  // left dangling with no UI recovery (audit: paper-snapshot prune).
  const deck = get('SELECT paper_snapshot_id FROM tracked_decks WHERE id = ?', [trackedDeckId]);
  const paperId = deck?.paper_snapshot_id ?? null;

  const countRow = get(
    'SELECT COUNT(*) as count FROM deck_snapshots WHERE tracked_deck_id = ? AND locked = 0 AND (? IS NULL OR id != ?)',
    [trackedDeckId, paperId, paperId]
  );

  if (countRow.count <= max) return 0;

  const excess = countRow.count - max;

  const toDelete = all(
    'SELECT id FROM deck_snapshots WHERE tracked_deck_id = ? AND locked = 0 AND (? IS NULL OR id != ?) ORDER BY created_at ASC LIMIT ?',
    [trackedDeckId, paperId, paperId, excess]
  );

  if (toDelete.length === 0) return 0;

  const ids = toDelete.map(s => s.id);
  const placeholders = ids.map(() => '?').join(',');
  run(`DELETE FROM deck_snapshots WHERE id IN (${placeholders})`, ids);

  return ids.length;
}
