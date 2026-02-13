import { Router } from 'express';
import { all, get, run } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireIntParam, requireMaxLength } from '../middleware/validate.js';
import { parse } from '../../src/lib/parser.js';
import { computeDiff } from '../../src/lib/differ.js';
import { enrichDeckText } from '../lib/enrichDeckText.js';
import { pruneSnapshots } from '../lib/pruneSnapshots.js';

const router = Router();

router.use(requireAuth);

function verifyDeckOwnership(req, res) {
  const deckId = requireIntParam(req, res, 'deckId');
  if (deckId === null) return null;

  const deck = get('SELECT * FROM tracked_decks WHERE id = ? AND user_id = ?', [deckId, req.user.userId]);
  if (!deck) {
    res.status(404).json({ error: 'Tracked deck not found' });
    return null;
  }
  return deck;
}

// Create a manual snapshot (e.g. from URL import)
router.post('/:deckId/snapshots', async (req, res) => {
  const deck = verifyDeckOwnership(req, res);
  if (!deck) return;

  const { deck_text, nickname } = req.body;
  if (!deck_text || typeof deck_text !== 'string' || !deck_text.trim()) {
    return res.status(400).json({ error: 'deck_text is required and must be non-empty' });
  }
  if (nickname !== null && nickname !== undefined && typeof nickname !== 'string') {
    return res.status(400).json({ error: 'Nickname must be a string or null' });
  }
  if (nickname && !requireMaxLength(res, nickname, 100, 'Nickname')) return;

  // Enrich deck text with set/collector metadata from previous snapshot + Scryfall
  let enrichedText = deck_text.trim();
  try {
    const latest = get(
      'SELECT deck_text FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at DESC LIMIT 1',
      [deck.id]
    );
    enrichedText = await enrichDeckText(enrichedText, latest?.deck_text || null);
  } catch (err) {
    console.error('Enrichment failed, storing raw text:', err.message);
  }

  const result = run(
    'INSERT INTO deck_snapshots (tracked_deck_id, deck_text, nickname) VALUES (?, ?, ?)',
    [deck.id, enrichedText, nickname?.trim() || null]
  );
  pruneSnapshots(deck.id);

  // Backfill commanders if the deck doesn't have any set
  if (!deck.commanders || deck.commanders === '[]') {
    try {
      const parsed = parse(enrichedText);
      const cmds = parsed.commanders || [];
      if (cmds.length > 0) {
        run('UPDATE tracked_decks SET commanders = ? WHERE id = ?',
          [JSON.stringify(cmds), deck.id]);
      }
    } catch {
      // Parse failure is non-fatal
    }
  }

  const snapshot = get('SELECT id, nickname, created_at FROM deck_snapshots WHERE id = ?',
    [result.lastInsertRowid]);
  res.status(201).json({ snapshot });
});

router.get('/:deckId/snapshots', (req, res) => {
  const deck = verifyDeckOwnership(req, res);
  if (!deck) return;

  const snapshots = all(
    'SELECT id, nickname, locked, created_at FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at DESC',
    [deck.id]
  );

  res.json({ snapshots });
});

// Get a single snapshot with deck_text (for loading into DeckInput)
router.get('/:deckId/snapshots/:snapshotId', (req, res) => {
  const deck = verifyDeckOwnership(req, res);
  if (!deck) return;
  const snapshotId = requireIntParam(req, res, 'snapshotId');
  if (snapshotId === null) return;

  const snapshot = get('SELECT * FROM deck_snapshots WHERE id = ? AND tracked_deck_id = ?',
    [snapshotId, deck.id]);
  if (!snapshot) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }

  res.json({ snapshot });
});

router.delete('/:deckId/snapshots/:snapshotId', (req, res) => {
  const deck = verifyDeckOwnership(req, res);
  if (!deck) return;
  const snapshotId = requireIntParam(req, res, 'snapshotId');
  if (snapshotId === null) return;

  const snapshot = get('SELECT * FROM deck_snapshots WHERE id = ? AND tracked_deck_id = ?',
    [snapshotId, deck.id]);
  if (!snapshot) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }
  if (snapshot.locked) {
    return res.status(400).json({ error: 'Cannot delete a locked snapshot. Unlock it first.' });
  }

  run('DELETE FROM deck_snapshots WHERE id = ?', [snapshotId]);
  res.json({ success: true });
});

router.patch('/:deckId/snapshots/:snapshotId', (req, res) => {
  const deck = verifyDeckOwnership(req, res);
  if (!deck) return;
  const snapshotId = requireIntParam(req, res, 'snapshotId');
  if (snapshotId === null) return;

  const { nickname } = req.body;
  if (nickname !== null && nickname !== undefined && typeof nickname !== 'string') {
    return res.status(400).json({ error: 'Nickname must be a string or null' });
  }
  if (!requireMaxLength(res, nickname, 100, 'Nickname')) return;

  const snapshot = get('SELECT * FROM deck_snapshots WHERE id = ? AND tracked_deck_id = ?',
    [snapshotId, deck.id]);
  if (!snapshot) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }

  run('UPDATE deck_snapshots SET nickname = ? WHERE id = ?', [nickname?.trim() || null, snapshotId]);
  res.json({ success: true });
});

// Lock a snapshot (prevent auto-pruning and deletion)
router.patch('/:deckId/snapshots/:snapshotId/lock', (req, res) => {
  const deck = verifyDeckOwnership(req, res);
  if (!deck) return;
  const snapshotId = requireIntParam(req, res, 'snapshotId');
  if (snapshotId === null) return;

  const snapshot = get('SELECT * FROM deck_snapshots WHERE id = ? AND tracked_deck_id = ?',
    [snapshotId, deck.id]);
  if (!snapshot) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }
  if (snapshot.locked) {
    return res.json({ success: true }); // Already locked
  }

  // Check lock limit
  const lockSetting = get("SELECT value FROM server_settings WHERE key = 'max_locked_per_deck'");
  const maxLocked = parseInt(lockSetting?.value, 10) || 5;
  if (maxLocked > 0) {
    const lockedCount = get(
      'SELECT COUNT(*) as count FROM deck_snapshots WHERE tracked_deck_id = ? AND locked = 1',
      [deck.id]
    );
    if (lockedCount.count >= maxLocked) {
      return res.status(400).json({ error: `Lock limit reached (${maxLocked} per deck). Unlock another snapshot first.` });
    }
  }

  run('UPDATE deck_snapshots SET locked = 1 WHERE id = ?', [snapshotId]);
  res.json({ success: true });
});

// Unlock a snapshot
router.patch('/:deckId/snapshots/:snapshotId/unlock', (req, res) => {
  const deck = verifyDeckOwnership(req, res);
  if (!deck) return;
  const snapshotId = requireIntParam(req, res, 'snapshotId');
  if (snapshotId === null) return;

  const snapshot = get('SELECT * FROM deck_snapshots WHERE id = ? AND tracked_deck_id = ?',
    [snapshotId, deck.id]);
  if (!snapshot) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }

  run('UPDATE deck_snapshots SET locked = 0 WHERE id = ?', [snapshotId]);
  res.json({ success: true });
});

// Timeline — summary stats for all consecutive snapshot pairs
router.get('/:deckId/timeline', (req, res) => {
  const deck = verifyDeckOwnership(req, res);
  if (!deck) return;

  const snapshots = all(
    'SELECT id, deck_text, nickname, locked, created_at FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at ASC',
    [deck.id]
  );

  const entries = [];
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    const parsed = parse(snap.deck_text);
    // Count total cards across all sections
    let cardCount = 0;
    for (const [, qty] of parsed.mainboard) cardCount += qty;
    for (const [, qty] of parsed.sideboard) cardCount += qty;
    cardCount += (parsed.commanders || []).length;

    const entry = {
      snapshotId: snap.id,
      date: snap.created_at,
      nickname: snap.nickname,
      locked: !!snap.locked,
      cardCount,
    };

    if (i > 0) {
      const prevParsed = parse(snapshots[i - 1].deck_text);
      const diff = computeDiff(prevParsed, parsed);
      let added = 0, removed = 0, changed = 0;
      for (const section of ['mainboard', 'sideboard']) {
        if (diff[section]) {
          added += (diff[section].added || []).length;
          removed += (diff[section].removed || []).length;
          changed += (diff[section].changed || []).length;
        }
      }
      entry.delta = { added, removed, changed };
    }

    entries.push(entry);
  }

  res.json({ entries });
});

router.get('/:deckId/changelog', (req, res) => {
  const deck = verifyDeckOwnership(req, res);
  if (!deck) return;

  const { a, b } = req.query;
  let snapA, snapB;

  if (a && b) {
    snapA = get('SELECT * FROM deck_snapshots WHERE id = ? AND tracked_deck_id = ?', [a, deck.id]);
    snapB = get('SELECT * FROM deck_snapshots WHERE id = ? AND tracked_deck_id = ?', [b, deck.id]);
    if (!snapA || !snapB) {
      return res.status(404).json({ error: 'One or both snapshots not found' });
    }
  } else {
    const recent = all(
      'SELECT * FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at DESC LIMIT 2',
      [deck.id]
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
    before: { id: snapA.id, nickname: snapA.nickname, created_at: snapA.created_at, deck_text: snapA.deck_text },
    after: { id: snapB.id, nickname: snapB.nickname, created_at: snapB.created_at, deck_text: snapB.deck_text },
  });
});

export default router;
