import { Router } from 'express';
import { all, get, run } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireIntParam, requireMaxLength } from '../middleware/validate.js';
import { parse } from '../../src/lib/parser.js';
import { computeDiff } from '../../src/lib/differ.js';
import { enrichDeckText } from '../lib/enrichDeckText.js';

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
    'SELECT id, nickname, created_at FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at DESC',
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
