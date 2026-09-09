import { randomUUID } from 'node:crypto';
import { get, run, transaction } from '../db.js';
import { getInstanceId } from './integrationSchema.js';
import { serializeDeck, textHash } from './structuredSnapshots.js';
import { ProposalError } from './deckProposals.js';
import { parse } from '../../src/lib/parser.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = ['operationId', 'name', 'deckText', 'expectedInstanceId', 'expectedAccountId'];
const fail = (status, code) => { throw new ProposalError(status, code); };

export function createIntegrationDeck(userId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'invalid_deck_creation');
  const { operationId, name, deckText, expectedInstanceId, expectedAccountId } = input;
  if (expectedInstanceId !== getInstanceId() || expectedAccountId !== String(userId)) {
    fail(409, 'connection_changed');
  }
  const payloadHash = textHash(JSON.stringify({ operationId, name, deckText, expectedInstanceId, expectedAccountId }));
  return transaction(() => {
    const previous = typeof operationId === 'string'
      ? get('SELECT * FROM integration_deck_creations WHERE user_id = ? AND operation_id = ?', [userId, operationId]) : null;
    if (previous) {
      if (previous.payload_hash !== payloadHash || Object.keys(input).some(key => !fields.includes(key))) fail(409, 'operation_conflict');
      if (!get('SELECT id FROM tracked_decks WHERE id = ? AND user_id = ?', [previous.deck_id, userId])) fail(410, 'created_deck_deleted');
      return { deck: JSON.parse(previous.receipt), replayed: true, operationId };
    }
    if (typeof operationId !== 'string' || !UUID.test(operationId) ||
        typeof name !== 'string' || !name.trim() || name.length > 200 ||
        typeof deckText !== 'string' || deckText.length > 500000 || Object.keys(input).some(key => !fields.includes(key))) {
      fail(400, 'invalid_deck_creation');
    }
    let owner = get("SELECT id FROM tracked_owners WHERE user_id = ? AND source_type = 'manual' ORDER BY id LIMIT 1", [userId]);
    if (!owner) {
      const inserted = run("INSERT INTO tracked_owners (user_id,archidekt_username,source_type) VALUES (?,?,'manual')",
        [userId, `manasync-manual:${randomUUID()}`]);
      owner = { id: inserted.lastInsertRowid };
    }
    const localSourceId = Math.min(0, get('SELECT MIN(archidekt_deck_id) AS id FROM tracked_decks WHERE user_id = ?', [userId]).id ?? 0) - 1;
    const inserted = run(`INSERT INTO tracked_decks (user_id,tracked_owner_id,archidekt_deck_id,deck_name,source_type,commanders)
      VALUES (?,?,?,?,'manual',?)`, [userId, owner.id, localSourceId, name, JSON.stringify(parse(deckText).commanders)]);
    const deckId = inserted.lastInsertRowid;
    run("INSERT INTO deck_snapshots (tracked_deck_id,deck_text,nickname) VALUES (?,?,'Created from ManaSync')", [deckId, deckText]);
    const deck = serializeDeck(get('SELECT * FROM tracked_decks WHERE id = ?', [deckId]));
    run('INSERT INTO integration_deck_creations (user_id,operation_id,payload_hash,deck_id,receipt) VALUES (?,?,?,?,?)',
      [userId, operationId, payloadHash, deckId, JSON.stringify(deck)]);
    return { deck, operationId, replayed: false };
  });
}
