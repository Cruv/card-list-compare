import { Router } from 'express';
import { all, get } from '../db.js';
import { parse } from '../../src/lib/parser.js';
import { computeDiff } from '../../src/lib/differ.js';

const router = Router();

// Resolve share → deck + verify existence
function resolveShare(req, res) {
  const shareId = req.params.id;
  if (!shareId || typeof shareId !== 'string') {
    res.status(400).json({ error: 'Invalid share ID' });
    return null;
  }

  const share = get(
    `SELECT sdv.*, d.deck_name, d.commanders, d.deck_url, u.username as owner_username
     FROM shared_deck_views sdv
     JOIN tracked_decks d ON d.id = sdv.tracked_deck_id
     JOIN users u ON u.id = sdv.user_id
     WHERE sdv.id = ?`,
    [shareId]
  );

  if (!share) {
    res.status(404).json({ error: 'Shared deck not found or no longer shared' });
    return null;
  }

  return share;
}

// GET /shared-deck/:id — public deck info + snapshot list
router.get('/:id', (req, res) => {
  const share = resolveShare(req, res);
  if (!share) return;

  const snapshots = all(
    `SELECT id, nickname, locked, created_at FROM deck_snapshots
     WHERE tracked_deck_id = ? ORDER BY created_at DESC`,
    [share.tracked_deck_id]
  );

  // Count cards in each snapshot
  const snapshotList = snapshots.map(s => {
    const snap = get('SELECT deck_text FROM deck_snapshots WHERE id = ?', [s.id]);
    let cardCount = 0;
    if (snap?.deck_text) {
      try {
        const parsed = parse(snap.deck_text);
        // Commanders are already merged into mainboard by the parser
        for (const [, card] of parsed.mainboard) cardCount += card.quantity;
        for (const [, card] of parsed.sideboard) cardCount += card.quantity;
      } catch { /* ignore */ }
    }
    return {
      id: s.id,
      nickname: s.nickname,
      locked: !!s.locked,
      created_at: s.created_at,
      cardCount,
    };
  });

  let commanders = [];
  try { commanders = JSON.parse(share.commanders || '[]'); } catch { /* ignore */ }

  res.json({
    deckName: share.deck_name,
    commanders,
    ownerUsername: share.owner_username,
    sharedAt: share.created_at,
    deckUrl: share.deck_url,
    snapshots: snapshotList,
  });
});

// GET /shared-deck/:id/changelog?a=X&b=Y — compute diff between two snapshots
router.get('/:id/changelog', (req, res) => {
  const share = resolveShare(req, res);
  if (!share) return;

  const { a, b } = req.query;
  let snapA, snapB;

  if (a && b) {
    snapA = get('SELECT * FROM deck_snapshots WHERE id = ? AND tracked_deck_id = ?', [a, share.tracked_deck_id]);
    snapB = get('SELECT * FROM deck_snapshots WHERE id = ? AND tracked_deck_id = ?', [b, share.tracked_deck_id]);
    if (!snapA || !snapB) {
      return res.status(404).json({ error: 'One or both snapshots not found' });
    }
  } else {
    const recent = all(
      'SELECT * FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at DESC LIMIT 2',
      [share.tracked_deck_id]
    );
    if (recent.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 snapshots to generate a changelog' });
    }
    snapB = recent[0];
    snapA = recent[1];
  }

  const before = parse(snapA.deck_text);
  const after = parse(snapB.deck_text);
  const diff = computeDiff(before, after);

  res.json({
    diff,
    before: { id: snapA.id, nickname: snapA.nickname, created_at: snapA.created_at },
    after: { id: snapB.id, nickname: snapB.nickname, created_at: snapB.created_at },
  });
});

// GET /shared-deck/:id/snapshot/:snapshotId — get snapshot deck text
router.get('/:id/snapshot/:snapshotId', (req, res) => {
  const share = resolveShare(req, res);
  if (!share) return;

  const snapshotId = parseInt(req.params.snapshotId, 10);
  if (isNaN(snapshotId)) {
    return res.status(400).json({ error: 'Invalid snapshot ID' });
  }

  const snapshot = get(
    'SELECT id, deck_text, nickname, created_at FROM deck_snapshots WHERE id = ? AND tracked_deck_id = ?',
    [snapshotId, share.tracked_deck_id]
  );

  if (!snapshot) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }

  res.json({ snapshot });
});

export default router;
