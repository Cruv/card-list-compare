import { Router } from 'express';
import { all, get, run } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { parseCollectionImportText } from '../lib/collectionImport.js';

const router = Router();
router.use(requireAuth);

// Get user's collection
router.get('/', (req, res) => {
  const cards = all(
    'SELECT id, card_name, set_code, collector_number, quantity, is_foil FROM collection_cards WHERE user_id = ? ORDER BY card_name ASC',
    [req.user.userId]
  );
  res.json({ cards });
});

// Get collection summary (unique cards + total cards)
router.get('/summary', (req, res) => {
  const row = get(
    'SELECT COUNT(*) as uniqueCards, COALESCE(SUM(quantity), 0) as totalCards FROM collection_cards WHERE user_id = ?',
    [req.user.userId]
  );
  res.json(row);
});

// Add a single card
router.post('/', (req, res) => {
  const { cardName, setCode, collectorNumber, quantity, isFoil } = req.body;
  if (!cardName || typeof cardName !== 'string') {
    return res.status(400).json({ error: 'cardName is required' });
  }
  const qty = Math.max(1, Math.min(999, parseInt(quantity, 10) || 1));

  // Upsert: if exists, add quantity; otherwise insert
  const existing = get(
    'SELECT id, quantity FROM collection_cards WHERE user_id = ? AND card_name = ? AND COALESCE(set_code, "") = ? AND COALESCE(collector_number, "") = ? AND is_foil = ?',
    [req.user.userId, cardName.trim(), setCode?.trim() || '', collectorNumber?.trim() || '', isFoil ? 1 : 0]
  );

  if (existing) {
    run('UPDATE collection_cards SET quantity = quantity + ? WHERE id = ?', [qty, existing.id]);
  } else {
    run(
      'INSERT INTO collection_cards (user_id, card_name, set_code, collector_number, quantity, is_foil) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.userId, cardName.trim(), setCode?.trim() || null, collectorNumber?.trim() || null, qty, isFoil ? 1 : 0]
    );
  }

  res.json({ success: true });
});

// Bulk import from text (same format as deck text)
router.post('/import', (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }

  // Parsing delegates to the shared deck-text parser (see
  // server/lib/collectionImport.js and docs/DECK_TEXT_FORMAT.md).
  const { cards, skipped } = parseCollectionImportText(text);

  let imported = 0;

  for (const card of cards) {
    // Upsert
    const existing = get(
      'SELECT id, quantity FROM collection_cards WHERE user_id = ? AND card_name = ? AND COALESCE(set_code, "") = ? AND COALESCE(collector_number, "") = ? AND is_foil = ?',
      [req.user.userId, card.cardName, card.setCode || '', card.collectorNumber || '', card.isFoil]
    );

    if (existing) {
      run('UPDATE collection_cards SET quantity = quantity + ? WHERE id = ?', [card.quantity, existing.id]);
    } else {
      run(
        'INSERT INTO collection_cards (user_id, card_name, set_code, collector_number, quantity, is_foil) VALUES (?, ?, ?, ?, ?, ?)',
        [req.user.userId, card.cardName, card.setCode, card.collectorNumber, card.quantity, card.isFoil]
      );
    }
    imported++;
  }

  res.json({ imported, skipped });
});

// Update card quantity
router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  const card = get('SELECT * FROM collection_cards WHERE id = ? AND user_id = ?', [id, req.user.userId]);
  if (!card) return res.status(404).json({ error: 'Card not found' });

  const { quantity } = req.body;
  if (quantity === undefined || typeof quantity !== 'number' || quantity < 0) {
    return res.status(400).json({ error: 'quantity must be a non-negative number' });
  }

  if (quantity === 0) {
    run('DELETE FROM collection_cards WHERE id = ?', [id]);
  } else {
    run('UPDATE collection_cards SET quantity = ? WHERE id = ?', [quantity, id]);
  }

  res.json({ success: true });
});

// Delete a card
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  const card = get('SELECT * FROM collection_cards WHERE id = ? AND user_id = ?', [id, req.user.userId]);
  if (!card) return res.status(404).json({ error: 'Card not found' });

  run('DELETE FROM collection_cards WHERE id = ?', [id]);
  res.json({ success: true });
});

// Clear entire collection
router.delete('/', (req, res) => {
  run('DELETE FROM collection_cards WHERE user_id = ?', [req.user.userId]);
  res.json({ success: true });
});

export default router;
