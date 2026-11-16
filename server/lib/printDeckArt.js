import { get, run, transaction } from '../db.js';
import { parse, parseLine, rewriteDeckPrinting } from '../../src/lib/parser.js';
import { printCardKey } from '../../src/lib/printSelection.js';
import { pruneSnapshots } from './pruneSnapshots.js';
import { fetchCardImageUrls } from './scryfallImages.js';
import { latestSnapshot, textHash } from './structuredSnapshots.js';
import { printError } from './printQueuePlan.js';

function readChoice(input) {
  const { targetSnapshotId, targetTextHash, selectionKey, scryfallId, includeSideboard = false } = input;
  if (!Number.isSafeInteger(targetSnapshotId) || targetSnapshotId < 1 || typeof targetTextHash !== 'string' || !/^[a-f0-9]{64}$/.test(targetTextHash)) {
    throw printError('Review the latest saved deck before choosing artwork.');
  }
  if (typeof includeSideboard !== 'boolean' || typeof selectionKey !== 'string' || selectionKey.length > 1000
    || typeof scryfallId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scryfallId)) {
    throw printError('Choose a valid Scryfall printing for a saved deck card.');
  }
  let key;
  try { key = JSON.parse(selectionKey); } catch { throw printError('Invalid card selection. Review the deck and try again.'); }
  if (!Array.isArray(key) || key.length !== 3 || key.some(value => typeof value !== 'string') || !key[0]
    || printCardKey({ displayName: key[0], setCode: key[1], collectorNumber: key[2] }) !== selectionKey) {
    throw printError('Invalid card selection. Review the deck and try again.');
  }
  return { targetSnapshotId, targetTextHash, selectionKey, includeSideboard, scryfallId: scryfallId.toLowerCase() };
}

function reviewedSnapshot(userId, deckId, { targetSnapshotId, targetTextHash }) {
  if (!get('SELECT id FROM tracked_decks WHERE id = ? AND user_id = ?', [deckId, userId])) throw printError('Deck not found.', 404);
  const snapshot = latestSnapshot(deckId);
  if (snapshot?.id !== targetSnapshotId || textHash(snapshot.deck_text) !== targetTextHash) {
    throw printError('The saved deck changed. Review the latest version before saving artwork.', 409);
  }
  return snapshot;
}

function exactPaperPrinting(printing) {
  if (printing?.paper !== true || printing.language !== 'en'
    || typeof printing.setCode !== 'string' || !printing.setCode
    || typeof printing.collectorNumber !== 'string' || !printing.collectorNumber) return null;
  const setCode = printing.setCode.toLowerCase();
  const { collectorNumber } = printing;
  const roundTrip = parseLine(`1 Card (${setCode}) [${collectorNumber}]`);
  return roundTrip?.setCode === setCode && roundTrip.collectorNumber === collectorNumber
    ? { setCode, collectorNumber } : null;
}

export async function savePrintArtToDeck(userId, deckId, input) {
  const choice = readChoice(input);
  const snapshot = reviewedSnapshot(userId, deckId, choice);
  const deck = parse(snapshot.deck_text);
  const baseCard = [...deck.mainboard.values(), ...(choice.includeSideboard ? deck.sideboard.values() : [])]
    .find(card => printCardKey(card) === choice.selectionKey);
  if (!baseCard) throw printError('This card printing is missing from the reviewed deck.', 409);

  const original = { ...baseCard, quantity: 1 };
  const [before, after] = await fetchCardImageUrls([original, { ...original, requestedScryfallId: choice.scryfallId }], {
    allowIncomplete: true, includePrintingDetails: true, signal: AbortSignal.timeout(20_000),
  });
  const exactPrinting = exactPaperPrinting(after?.printingDetails);
  if (!before?.oracleId || before.oracleId !== after?.oracleId || after.scryfallId !== choice.scryfallId
    || !exactPrinting || after.layout === 'meld' || after.lookupFailures?.length) {
    throw printError('This Scryfall printing could not be verified for the saved card. Check the artwork and try again.', 422);
  }
  const selectionKey = printCardKey({ ...baseCard, ...exactPrinting });

  return transaction(() => {
    const current = reviewedSnapshot(userId, deckId, choice);
    if (selectionKey === choice.selectionKey) {
      return { snapshot: { id: current.id, nickname: current.nickname, created_at: current.created_at }, selectionKey, changed: false };
    }
    const text = rewriteDeckPrinting(current.deck_text, choice.selectionKey, exactPrinting, { includeSideboard: choice.includeSideboard });
    if (text === current.deck_text) throw printError('This card printing is missing from the reviewed deck.', 409);
    const { lastInsertRowid } = run('INSERT INTO deck_snapshots (tracked_deck_id, deck_text, nickname) VALUES (?, ?, ?)',
      [deckId, text, 'Print artwork']);
    pruneSnapshots(deckId);
    const saved = get('SELECT id, nickname, created_at FROM deck_snapshots WHERE id = ?', [lastInsertRowid]);
    return { snapshot: saved, selectionKey, changed: true };
  });
}
