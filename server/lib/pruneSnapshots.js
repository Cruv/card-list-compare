import { get, all, run } from '../db.js';

/**
 * Prune unlocked snapshots for a deck, keeping only the most recent N unlocked ones.
 * Locked snapshots are never deleted and don't count toward the limit.
 * @param {number} trackedDeckId
 * @returns {number} Number of snapshots deleted
 */
export function pruneSnapshots(trackedDeckId) {
  const setting = get("SELECT value FROM server_settings WHERE key = 'max_snapshots_per_deck'");
  const max = parseInt(setting?.value, 10) || 25;
  if (max <= 0) return 0; // 0 means unlimited

  const countRow = get(
    'SELECT COUNT(*) as count FROM deck_snapshots WHERE tracked_deck_id = ? AND locked = 0',
    [trackedDeckId]
  );

  if (countRow.count <= max) return 0;

  const excess = countRow.count - max;

  const toDelete = all(
    'SELECT id FROM deck_snapshots WHERE tracked_deck_id = ? AND locked = 0 ORDER BY created_at ASC LIMIT ?',
    [trackedDeckId, excess]
  );

  if (toDelete.length === 0) return 0;

  const ids = toDelete.map(s => s.id);
  run(`DELETE FROM deck_snapshots WHERE id IN (${ids.join(',')})`, []);

  return ids.length;
}
