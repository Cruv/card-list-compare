import { get, run, transaction } from '../db.js';
import { getInstanceId } from './integrationSchema.js';
import { normalizeDeckSourceLink, findDecksBySource, recordSourceTrackingStatus, sourceFailureMessage } from './deckSources.js';
import { serializeDeck, textHash } from './structuredSnapshots.js';
import { refreshArchidektDeck } from './sourceSync.js';
import { ProposalError } from './deckProposals.js';

export const SOURCE_TRACKING_PROVIDERS = ['archidekt', 'moxfield', 'deckcheck'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = ['operationId', 'sourceLink', 'expectedInstanceId', 'expectedAccountId', 'name', 'deckText'];
const fail = (status, code) => { throw new ProposalError(status, code); };

export function createSourceTrackingService({ refreshSource = refreshArchidektDeck } = {}) {
  return async function trackSource(userId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'invalid_source_tracking');
    const { operationId, expectedInstanceId, expectedAccountId, name, deckText } = input;
    if (expectedInstanceId !== getInstanceId() || expectedAccountId !== String(userId)) fail(409, 'connection_changed');
    const source = normalizeDeckSourceLink(input.sourceLink);
    const payloadHash = textHash(JSON.stringify({ operationId, expectedInstanceId, expectedAccountId,
      sourceLink: source || input.sourceLink, name, deckText }));
    const prepared = transaction(() => {
      const previous = typeof operationId === 'string'
        ? get('SELECT * FROM integration_source_tracks WHERE user_id = ? AND operation_id = ?', [userId, operationId]) : null;
      if (previous) {
        if (previous.payload_hash !== payloadHash || Object.keys(input).some(key => !fields.includes(key))) fail(409, 'operation_conflict');
        if (!get('SELECT id FROM tracked_decks WHERE id = ? AND user_id = ?', [previous.deck_id, userId])) fail(410, 'tracked_deck_deleted');
        return { ...previous, replayed: true };
      }
      if (typeof operationId !== 'string' || !UUID.test(operationId) || !source ||
          (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 200)) ||
          (deckText !== undefined && (typeof deckText !== 'string' || deckText.length > 500000)) ||
          Object.keys(input).some(key => !fields.includes(key))) fail(400, 'invalid_source_tracking');
      const upstreamId = source.provider === 'archidekt' ? Number(source.deckId) : null;
      if (source.provider === 'archidekt' && !Number.isSafeInteger(upstreamId)) fail(400, 'invalid_source_tracking');
      const matches = findDecksBySource(userId, source);
      if (matches.length > 1) fail(409, 'source_identity_conflict');
      let deck = matches[0];
      const linkedExisting = Boolean(deck);
      if (!deck || deck.source_type === 'manual') {
        let owner = get("SELECT id FROM tracked_owners WHERE user_id = ? AND source_type = 'linked' ORDER BY id LIMIT 1", [userId]);
        if (!owner) owner = { id: run("INSERT INTO tracked_owners (user_id,archidekt_username,source_type) VALUES (?,?,'linked')",
          [userId, `Linked sources:${userId}`]).lastInsertRowid };
        if (deck) {
          run('UPDATE tracked_decks SET tracked_owner_id = ?, source_type = ?, archidekt_deck_id = ?, deck_url = ?, auto_refresh_hours = COALESCE(auto_refresh_hours,1) WHERE id = ? AND user_id = ?',
            [owner.id, source.provider, upstreamId ?? deck.archidekt_deck_id, source.url, deck.id, userId]);
        } else {
          const localId = Math.min(0, get('SELECT MIN(archidekt_deck_id) AS id FROM tracked_decks WHERE user_id = ?', [userId]).id ?? 0) - 1;
          const deckId = run('INSERT INTO tracked_decks (user_id,tracked_owner_id,source_type,archidekt_deck_id,deck_name,deck_url,auto_refresh_hours) VALUES (?,?,?,?,?,?,1)',
            [userId, owner.id, source.provider, upstreamId ?? localId, name ?? `${source.provider} ${source.deckId}`.slice(0, 200), source.url]).lastInsertRowid;
          deck = { id: deckId };
          if (deckText !== undefined) run("INSERT INTO deck_snapshots (tracked_deck_id,deck_text,nickname) VALUES (?,?,'Initial linked deck')", [deckId, deckText]);
          run('INSERT INTO integration_deck_sources (deck_id,user_id,provider,source_deck_id,canonical_url) VALUES (?,?,?,?,?)',
            [deckId, userId, source.provider, source.deckId, source.url]);
        }
      }
      run('INSERT OR IGNORE INTO integration_deck_sources (deck_id,user_id,provider,source_deck_id,canonical_url) VALUES (?,?,?,?,?)',
        [deck.id, userId, source.provider, source.deckId, source.url]);
      if (!get('SELECT tracking_status FROM integration_deck_sources WHERE deck_id = ?', [deck.id]).tracking_status) {
        recordSourceTrackingStatus(userId, deck.id, 'awaiting_source', 'Waiting for the first complete provider list.');
      }
      run('INSERT INTO integration_source_tracks (user_id,operation_id,payload_hash,deck_id,linked_existing) VALUES (?,?,?,?,?)',
        [userId, operationId, payloadHash, deck.id, linkedExisting ? 1 : 0]);
      return { deck_id: deck.id, linked_existing: linkedExisting, replayed: false, receipt: null };
    });
    if (prepared.receipt) return { ...JSON.parse(prepared.receipt), replayed: true };

    // Durable identity and intent already exist. Network I/O never runs inside
    // the SQLite transaction; a restart can retry this same deck safely.
    let status = 'tracked', message = 'CLC is tracking this provider source.';
    try {
      const refreshed = await refreshSource(userId, prepared.deck_id);
      if (refreshed?.pendingReview) message = 'Provider changes are waiting for source review. Your current deck is preserved.';
    }
    catch (error) {
      status = 'awaiting_source';
      message = sourceFailureMessage(error);
    }
    return transaction(() => {
      const receipt = get('SELECT receipt FROM integration_source_tracks WHERE user_id = ? AND operation_id = ?', [userId, operationId]);
      if (receipt?.receipt) return { ...JSON.parse(receipt.receipt), replayed: true };
      const deck = get('SELECT * FROM tracked_decks WHERE id = ? AND user_id = ?', [prepared.deck_id, userId]);
      if (!deck) fail(410, 'tracked_deck_deleted');
      recordSourceTrackingStatus(userId, prepared.deck_id, status, message);
      const result = { deck: serializeDeck(deck), operationId, linkedExisting: Boolean(prepared.linked_existing),
        tracking: { status, provider: source.provider, message }, replayed: prepared.replayed };
      run('UPDATE integration_source_tracks SET receipt = ? WHERE user_id = ? AND operation_id = ?', [JSON.stringify(result), userId, operationId]);
      return result;
    });
  };
}

export const trackIntegrationSource = createSourceTrackingService();
