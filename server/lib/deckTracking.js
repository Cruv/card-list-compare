import { get, run, transaction } from '../db.js';
import { findDecksBySource, parseDeckSourceUrl } from './deckSources.js';
import { SourceSyncError } from './sourceSync.js';

// Reuse one provider identity in either direction: a manual deck created through
// the bridge may later acquire native Archidekt tracking without changing its ID,
// current text, paper marker, proposal receipts, or snapshot history.
export function trackArchidektDeck(userId, { trackedOwnerId, archidektDeckId, deckName }) {
  if (!Number.isSafeInteger(archidektDeckId) || archidektDeckId < 1) {
    throw new SourceSyncError(400, 'invalid_source_link');
  }
  const source = parseDeckSourceUrl(`https://archidekt.com/decks/${archidektDeckId}`);
  return transaction(() => {
    const owner = get("SELECT id FROM tracked_owners WHERE id = ? AND user_id = ? AND source_type = 'archidekt'", [trackedOwnerId, userId]);
    if (!owner) throw new SourceSyncError(404, 'tracked_owner_not_found');
    const matches = findDecksBySource(userId, source);
    if (matches.length > 1) throw new SourceSyncError(409, 'source_identity_conflict');
    if (matches.length === 1) {
      const existing = matches[0];
      if (existing.source_type === 'manual') {
        run("UPDATE tracked_decks SET tracked_owner_id = ?, archidekt_deck_id = ?, source_type = 'archidekt', deck_url = ? WHERE id = ? AND user_id = ?",
          [owner.id, archidektDeckId, source.url, existing.id, userId]);
      }
      return { deckId: existing.id, reused: true };
    }
    const inserted = run('INSERT INTO tracked_decks (user_id, tracked_owner_id, archidekt_deck_id, deck_name, deck_url) VALUES (?, ?, ?, ?, ?)',
      [userId, owner.id, archidektDeckId, deckName, source.url]);
    return { deckId: inserted.lastInsertRowid, reused: false };
  });
}
