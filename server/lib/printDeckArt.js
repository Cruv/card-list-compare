import { get, run, transaction } from '../db.js';
import { parse, parseLine, rewriteDeckPrintings } from '../../src/lib/parser.js';
import { printCardKey } from '../../src/lib/printSelection.js';
import { pruneSnapshots } from './pruneSnapshots.js';
import { fetchCardImageUrls } from './scryfallImages.js';
import { latestSnapshot, textHash } from './structuredSnapshots.js';
import { MAX_PRINT_COPIES, printError } from './printQueuePlan.js';

function readChoice(input) {
  const { selectionKey, scryfallId } = input || {};
  if (typeof selectionKey !== 'string' || selectionKey.length > 1000
    || typeof scryfallId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scryfallId)) {
    throw printError('Choose a valid Scryfall printing for a saved deck card.');
  }
  let key;
  try { key = JSON.parse(selectionKey); } catch { throw printError('Invalid card selection. Review the deck and try again.'); }
  if (!Array.isArray(key) || key.length !== 3 || key.some(value => typeof value !== 'string') || !key[0]
    || printCardKey({ displayName: key[0], setCode: key[1], collectorNumber: key[2] }) !== selectionKey) {
    throw printError('Invalid card selection. Review the deck and try again.');
  }
  return { selectionKey, scryfallId: scryfallId.toLowerCase() };
}

function readRequest(input) {
  const { targetSnapshotId, targetTextHash, includeSideboard = false } = input;
  if (!Number.isSafeInteger(targetSnapshotId) || targetSnapshotId < 1 || typeof targetTextHash !== 'string' || !/^[a-f0-9]{64}$/.test(targetTextHash)) {
    throw printError('Review the latest saved deck before choosing artwork.');
  }
  if (typeof includeSideboard !== 'boolean') throw printError('Choose a valid Scryfall printing for a saved deck card.');
  const bulk = input.choices !== undefined;
  const supplied = bulk ? input.choices : [input];
  if (!Array.isArray(supplied) || !supplied.length || supplied.length > MAX_PRINT_COPIES) {
    throw printError(`Choose artwork for between 1 and ${MAX_PRINT_COPIES} saved deck cards.`);
  }
  if (bulk && (input.selectionKey !== undefined || input.scryfallId !== undefined)) {
    throw printError('Provide artwork choices together in one list.');
  }
  const choices = supplied.map(readChoice);
  if (new Set(choices.map(({ selectionKey }) => selectionKey)).size !== choices.length) {
    throw printError('Choose only one printing for each saved deck card.');
  }
  return { targetSnapshotId, targetTextHash, includeSideboard, choices, bulk };
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
  const request = readRequest(input);
  const snapshot = reviewedSnapshot(userId, deckId, request);
  const deck = parse(snapshot.deck_text);
  const includedCards = new Map();
  for (const card of [...deck.mainboard.values(), ...(request.includeSideboard ? deck.sideboard.values() : [])]) {
    const key = printCardKey(card);
    if (!includedCards.has(key)) includedCards.set(key, card);
  }

  const requestedPrintings = request.choices.flatMap(({ selectionKey, scryfallId }) => {
    const card = includedCards.get(selectionKey);
    if (!card) throw printError('This card printing is missing from the reviewed deck.', 409);
    const original = { ...card, quantity: 1, selectionKey };
    return [original, { ...original, requestedScryfallId: scryfallId }];
  });
  const resolved = await fetchCardImageUrls(requestedPrintings, {
    allowIncomplete: true, includePrintingDetails: true, signal: AbortSignal.timeout(20_000),
  });

  const originals = new Map(resolved.filter(card => !card.requestedScryfallId).map(card => [card.selectionKey, card]));
  const selected = new Map(resolved.filter(card => card.requestedScryfallId).map(card => [card.selectionKey, card]));
  const verified = request.choices.map(({ selectionKey, scryfallId }) => {
    const before = originals.get(selectionKey), after = selected.get(selectionKey);
    const card = includedCards.get(selectionKey);
    const printing = exactPaperPrinting(after?.printingDetails);
    if (!before?.oracleId || before.oracleId !== after?.oracleId || after.scryfallId !== scryfallId
      || !printing || after.layout === 'meld' || after.lookupFailures?.length) {
      const name = request.bulk ? card.displayName : 'the saved card';
      throw printError(`This Scryfall printing could not be verified for ${name}. Check the artwork and try again.`, 422);
    }
    return { previousSelectionKey: selectionKey, selectionKey: printCardKey({ ...card, ...printing }), scryfallId, printing };
  });
  const replacements = verified.filter(choice => choice.selectionKey !== choice.previousSelectionKey)
    .map(({ previousSelectionKey, printing }) => ({ selectionKey: previousSelectionKey, ...printing }));
  const changed = replacements.length > 0;
  return transaction(() => {
    const current = reviewedSnapshot(userId, deckId, request);
    let snapshotId = current.id;
    if (changed) {
      const text = rewriteDeckPrintings(current.deck_text, replacements, { includeSideboard: request.includeSideboard });
      if (text === current.deck_text) throw printError('This card printing is missing from the reviewed deck.', 409);
      const { lastInsertRowid } = run('INSERT INTO deck_snapshots (tracked_deck_id, deck_text, nickname) VALUES (?, ?, ?)',
        [deckId, text, 'Print artwork']);
      snapshotId = lastInsertRowid;
      pruneSnapshots(deckId);
    }
    const saved = get('SELECT id, nickname, created_at FROM deck_snapshots WHERE id = ?', [snapshotId]);
    return { snapshot: saved, changed, ...(request.bulk
      ? { choices: verified.map(({ printing: _printing, ...choice }) => choice) }
      : { selectionKey: verified[0].selectionKey }) };
  });
}
