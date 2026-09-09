import { get, run, transaction } from '../db.js';
import { latestSnapshot, structuredCards, textHash } from './structuredSnapshots.js';
import { fetchDeck } from './archidekt.js';
import { archidektToText } from './deckToText.js';
import { enrichDeckText } from './enrichDeckText.js';
import { pruneSnapshots } from './pruneSnapshots.js';
import { parse } from '../../src/lib/parser.js';
import { COMMANDER_HEADER, MAINBOARD_HEADER, SIDEBOARD_HEADER } from '../../src/lib/constants.js';
import { trackedDeckSourceLink, sourceTrackingState, recordSourceTrackingStatus, sourceFailureMessage } from './deckSources.js';
import { fetchTrackedProviderSource } from './trackedProviderSource.js';

export class SourceSyncError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new SourceSyncError(status, code, message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalize = value => value.normalize('NFC').trim().replace(/[‘’′]/g, "'").replace(/\s+/g, ' ').toLowerCase();

// Compare card content rather than line order/bracket style. Exact text is still
// stored and reviewed. Printing, finish, section, and unknown/comment text matter.
export function sourceTextKey(text) {
  if (text === null) return null;
  const { cards, unresolvedLines } = structuredCards(text);
  // Match splitSections' legacy blank-line behavior per line, including which
  // printing belongs to each board when a card name appears in both boards.
  let target = 'mainboard', seen = false, explicitSideboard = false;
  const content = { mainboard: 0, sideboard: 0, commander: 0 };
  const effectiveSections = text.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (COMMANDER_HEADER.test(trimmed)) target = 'commander';
    else if (SIDEBOARD_HEADER.test(trimmed)) { target = 'sideboard'; explicitSideboard = true; }
    else if (MAINBOARD_HEADER.test(trimmed)) target = 'mainboard';
    else if (!trimmed) {
      if (seen && !explicitSideboard && target === 'mainboard' && content.mainboard) target = 'sideboard';
      else if (target === 'commander' && content.commander) target = 'mainboard';
    } else { seen = true; content[target]++; }
    return target;
  });
  const counts = new Map();
  for (const card of cards) {
    const key = JSON.stringify([normalize(card.name), card.section, effectiveSections[card.lineNumber - 1], card.setCode.toLowerCase(), card.collectorNumber, card.finish]);
    counts.set(key, (counts.get(key) || 0) + card.quantity);
  }
  const notes = [...unresolvedLines.map(line => normalize(line.rawLine)),
    ...text.split(/\r?\n/).filter(line => /^\s*(\/\/|#)/.test(line)).map(normalize)];
  // Legacy CLC accepts a blank separator as an implicit sideboard. Its parser
  // may merge printings, so retain both this effective board membership and the
  // per-line printing identities above; neither representation alone is enough.
  const parsed = parse(text);
  const board = entries => {
    const totals = new Map();
    for (const entry of entries.values()) {
      const name = normalize(entry.displayName);
      totals.set(name, (totals.get(name) || 0) + entry.quantity);
    }
    return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
  };
  return JSON.stringify({ cards: [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)), notes,
    mainboard: board(parsed.mainboard), sideboard: board(parsed.sideboard), commanders: parsed.commanders.map(normalize).sort() });
}

function ownedDeck(userId, deckId) {
  const deck = get('SELECT * FROM tracked_decks WHERE id = ? AND user_id = ?', [deckId, userId]);
  if (!deck) fail(404, 'deck_not_found');
  if (deck.source_type === 'manual' || (deck.source_type === 'archidekt' && deck.archidekt_deck_id <= 0)) fail(409, 'manual_deck_has_no_upstream');
  return deck;
}
const sourceRow = deckId => get('SELECT * FROM deck_source_sync WHERE deck_id = ?', [deckId]);

export function sourceSyncState(userId, deckId) {
  const deck = ownedDeck(userId, deckId);
  const row = sourceRow(deckId);
  const current = latestSnapshot(deckId);
  const status = row?.pending ? 'pending_review' : row?.base_text == null ? 'unknown'
    : sourceTextKey(current?.deck_text ?? null) === sourceTextKey(row.base_text) ? 'synced' : 'local_changes';
  return { status, sourceProvider: deck.source_type || 'archidekt', sourceTracking: sourceTrackingState(userId, deckId), revision: row?.revision ?? 0, baseText: row?.base_text ?? null,
    sourceText: row?.source_text ?? null, currentText: current?.deck_text ?? null,
    currentSnapshotId: current ? String(current.id) : null,
    currentTextHash: current ? textHash(current.deck_text) : null,
    checkedAt: row?.checked_at ?? null, pending: !!row?.pending };
}

export function sourceSyncSummary(deck) {
  if (deck.source_type === 'manual' || (deck.source_type === 'archidekt' && deck.archidekt_deck_id <= 0)) return null;
  const { status, pending, checkedAt } = sourceSyncState(deck.user_id, deck.id);
  return { status, pending, checkedAt };
}

function saveRow(deckId, values) {
  const previous = sourceRow(deckId);
  const fields = ['base_raw_text', 'base_text', 'source_raw_text', 'source_text', 'pending'];
  const changed = !previous || fields.some(field => previous[field] !== values[field]);
  run(`INSERT INTO deck_source_sync (deck_id,revision,base_raw_text,base_text,source_raw_text,source_text,pending,checked_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(deck_id) DO UPDATE SET revision=excluded.revision,
    base_raw_text=excluded.base_raw_text,base_text=excluded.base_text,source_raw_text=excluded.source_raw_text,
    source_text=excluded.source_text,pending=excluded.pending,checked_at=excluded.checked_at`,
  [deckId, (previous?.revision ?? 0) + Number(changed), ...fields.map(field => values[field]), values.checked_at]);
}

// Called only after the fetch/enrichment finishes. The transaction re-reads the
// head: a proposal or manual snapshot committed during the request is protected.
export function observeSource(userId, deckId, { rawText, text, name, commanders = [] }) {
  return transaction(() => {
    const deck = ownedDeck(userId, deckId);
    const current = latestSnapshot(deckId);
    const previous = sourceRow(deckId);
    const checkedAt = new Date().toISOString();
    const sameSource = previous?.base_raw_text != null && sourceTextKey(rawText) === sourceTextKey(previous.base_raw_text);
    const currentMatchesSource = sourceTextKey(current?.deck_text ?? null) === sourceTextKey(text);
    const followsBase = previous?.base_text != null && sourceTextKey(current?.deck_text ?? null) === sourceTextKey(previous.base_text);
    // A known source-only head may advance. An unknown legacy head is trusted
    // only when it matches the actual fetched source, never because it is latest.
    const publish = !previous?.pending && (!current || (!sameSource && followsBase));
    const acknowledge = publish || currentMatchesSource;
    const pending = !sameSource && !acknowledge;
    let changed = false;
    if (publish && !currentMatchesSource) {
      run("INSERT INTO deck_snapshots (tracked_deck_id,deck_text,nickname) VALUES (?,?,?)", [deckId, text, `${deck.source_type} source`]);
      changed = true;
      const sourceHadCommander = previous?.base_raw_text && parse(previous.base_raw_text).commanders.length > 0;
      const savedCommanders = commanders.length || sourceHadCommander ? JSON.stringify(commanders) : deck.commanders;
      run('UPDATE tracked_decks SET deck_name = ?, commanders = ? WHERE id = ?',
        [name || deck.deck_name, savedCommanders, deckId]);
      pruneSnapshots(deckId);
    }
    saveRow(deckId, {
      base_raw_text: acknowledge ? rawText : previous?.base_raw_text ?? null,
      base_text: acknowledge ? text : previous?.base_text ?? null,
      source_raw_text: rawText, source_text: text, pending: Number(pending), checked_at: checkedAt,
    });
    run('UPDATE tracked_decks SET last_refreshed_at = datetime("now") WHERE id = ?', [deckId]);
    const sourceSync = sourceSyncState(userId, deckId);
    return { changed, pendingReview: sourceSync.pending, sourceSync,
      message: sourceSync.pending ? 'The provider changed. Review the source without replacing your current deck.'
        : sourceSync.status === 'local_changes' ? 'The source is unchanged. Your local changes are preserved.'
          : changed ? 'New provider snapshot saved' : 'Deck is up to date',
      previousText: current?.deck_text ?? null, deckText: latestSnapshot(deckId)?.deck_text ?? null };
  });
}

// Metadata enrichment must never rewrite a printing or finish explicitly
// reported by Archidekt. If carry-forward/Scryfall cannot honor it, review the
// exact raw list instead of silently choosing another printing.
export function preservesSourceIdentity(rawText, enrichedText) {
  const originals = structuredCards(rawText).cards.sort((a, b) =>
    Number(!!b.setCode) + Number(!!b.collectorNumber) - Number(!!a.setCode) - Number(!!a.collectorNumber));
  const enriched = structuredCards(enrichedText).cards.map(card => ({ ...card, remaining: card.quantity }));
  for (const card of originals) {
    let remaining = card.quantity;
    for (const candidate of enriched) {
      if (normalize(candidate.name) !== normalize(card.name) || candidate.section !== card.section || candidate.finish !== card.finish ||
          (card.setCode && candidate.setCode.toLowerCase() !== card.setCode.toLowerCase()) ||
          (card.collectorNumber && candidate.collectorNumber !== card.collectorNumber)) continue;
      const matched = Math.min(remaining, candidate.remaining);
      candidate.remaining -= matched;
      remaining -= matched;
    }
    if (remaining !== 0) return false;
  }
  return enriched.every(card => card.remaining === 0);
}

// sql.js has one writer process. Serializing the entire fetch per deck also
// prevents a slow older request from becoming the newest upstream observation.
const refreshes = new Map();
export function refreshArchidektDeck(userId, deckId) {
  const key = `${userId}:${deckId}`;
  const task = (refreshes.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
    try {
    const deck = ownedDeck(userId, deckId);
    let observation;
    if (deck.source_type === 'archidekt') {
      const data = await fetchDeck(deck.archidekt_deck_id);
      if (Array.isArray(data?.cards) && data.cards.some(entry => /etched/i.test(entry?.modifier || ''))) {
        const error = new Error('Unsupported etched source finish'); error.code = 'unsupported_finish'; throw error;
      }
      if (!data || !Array.isArray(data.cards) || data.cards.some(entry => {
        const name = entry?.card?.oracleCard?.name || entry?.card?.name;
        const set = entry?.card?.edition?.editioncode || '';
        const collector = entry?.card?.collectorNumber || '';
        return !entry || !Number.isSafeInteger(entry.quantity) || entry.quantity <= 0 || entry.quantity > 1000000 ||
          typeof name !== 'string' || !name.trim() || /[\r\n]/.test(name) ||
          (set && (typeof set !== 'string' || !/^[a-z0-9]+$/i.test(set))) ||
          (collector && (typeof collector !== 'string' || !set || !/^[\w-]+$/.test(collector))) ||
          !['Normal', 'Foil'].includes(entry.modifier || 'Normal');
      })) fail(502, 'invalid_source_response', 'Archidekt returned an incomplete deck. Your current deck is preserved.');
      const { text, commanders } = archidektToText(data);
      observation = { rawText: text, commanders, name: data.name };
    } else {
      const link = trackedDeckSourceLink(deck);
      if (!link || link.provider !== deck.source_type) fail(409, 'source_identity_conflict');
      observation = await fetchTrackedProviderSource(link);
    }
    const { rawText, commanders, name } = observation;
    const baseline = sourceRow(deckId)?.base_text ?? latestSnapshot(deckId)?.deck_text ?? null;
    let text = rawText;
    try {
      const enriched = deck.source_type === 'archidekt' ? await enrichDeckText(rawText, baseline) : rawText;
      if (preservesSourceIdentity(rawText, enriched)) text = enriched;
    } catch { /* preserve the fetched text */ }
    const result = observeSource(userId, deckId, { rawText, text, name, commanders });
    recordSourceTrackingStatus(userId, deckId, 'tracked', result.pendingReview ? 'Provider changes are waiting for source review. Your current deck is preserved.' : 'CLC is tracking this provider source.');
    return { ...result, sourceSync: sourceSyncState(userId, deckId) };
    } catch (error) {
      recordSourceTrackingStatus(userId, deckId, 'awaiting_source', sourceFailureMessage(error));
      throw error;
    }
  });
  refreshes.set(key, task);
  const clear = () => { if (refreshes.get(key) === task) refreshes.delete(key); };
  task.then(clear, clear);
  return task;
}

export function reviewSource(userId, deckId, input) {
  ownedDeck(userId, deckId);
  const { operationId, expectedRevision, expectedCurrentSnapshotId, expectedCurrentTextHash, action, reviewedText } = input || {};
  const fields = ['operationId', 'expectedRevision', 'expectedCurrentSnapshotId', 'expectedCurrentTextHash', 'action', 'reviewedText'];
  if (!input || typeof operationId !== 'string' || !uuid.test(operationId) ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      !(expectedCurrentSnapshotId === null || (typeof expectedCurrentSnapshotId === 'string' && /^[1-9]\d*$/.test(expectedCurrentSnapshotId))) ||
      !(expectedCurrentTextHash === null || (typeof expectedCurrentTextHash === 'string' && /^[a-f0-9]{64}$/.test(expectedCurrentTextHash))) ||
      !['keep', 'source', 'merge'].includes(action) ||
      (action === 'merge' ? typeof reviewedText !== 'string' || !reviewedText.trim() || reviewedText.length > 500000 : reviewedText !== undefined) ||
      Object.keys(input).some(field => !fields.includes(field))) fail(400, 'invalid_source_review');
  const payloadHash = textHash(JSON.stringify({ deckId: String(deckId), operationId, expectedRevision, expectedCurrentSnapshotId, expectedCurrentTextHash, action, reviewedText }));
  return transaction(() => {
    const receipt = get('SELECT * FROM deck_source_reviews WHERE user_id = ? AND operation_id = ?', [userId, operationId]);
    if (receipt) {
      if (receipt.payload_hash !== payloadHash) fail(409, 'operation_conflict');
      return { ...JSON.parse(receipt.receipt), replayed: true };
    }
    const state = sourceSyncState(userId, deckId);
    if (state.revision !== expectedRevision || !state.pending) fail(409, 'source_changed');
    if (state.currentSnapshotId !== expectedCurrentSnapshotId || state.currentTextHash !== expectedCurrentTextHash) fail(409, 'latest_changed');
    const row = sourceRow(deckId);
    const text = action === 'merge' ? reviewedText : row.source_text;
    let resultSnapshotId = null;
    if (action !== 'keep' && text !== state.currentText) {
      resultSnapshotId = String(run('INSERT INTO deck_snapshots (tracked_deck_id,deck_text,nickname) VALUES (?,?,?)',
        [deckId, text, action === 'source' ? 'Reviewed Archidekt source' : 'Reviewed source merge']).lastInsertRowid);
      run('UPDATE tracked_decks SET commanders = ? WHERE id = ?', [JSON.stringify(parse(text).commanders), deckId]);
      pruneSnapshots(deckId);
    }
    saveRow(deckId, { ...row, base_raw_text: row.source_raw_text, base_text: row.source_text, pending: 0 });
    const result = { ...sourceSyncState(userId, deckId), resultSnapshotId, replayed: false };
    run('INSERT INTO deck_source_reviews (user_id,operation_id,deck_id,payload_hash,receipt) VALUES (?,?,?,?,?)',
      [userId, operationId, deckId, payloadHash, JSON.stringify(result)]);
    return result;
  });
}
