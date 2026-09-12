import crypto from 'node:crypto';
import { parse, parseLine } from '../../src/lib/parser.js';
import { COMMENT_LINE, MAINBOARD_HEADER, SIDEBOARD_HEADER, COMMANDER_HEADER } from '../../src/lib/constants.js';
import { printCardKey, isBasicLand } from '../../src/lib/printSelection.js';
import { normalizeCardName, normalizedName } from '../../src/lib/cardIdentity.js';
import { get } from '../db.js';
import { fetchCardImageUrls } from './scryfallImages.js';

export const MAX_PRINT_COPIES = 250;
export const MAX_PRINT_LIST_TEXT_LENGTH = 100_000;
export const MAX_PRINT_LIST_NAME_LENGTH = 120;
export const PRINT_METADATA_TIMEOUT_MS = 60_000;
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export function printError(message, status = 400) { return Object.assign(new Error(message), { status }); }
const identity = card => `${normalizeCardName(card.displayName)}|${(card.setCode || '').toLowerCase()}|${String(card.collectorNumber || '').toLowerCase()}`;
const hasPrinting = card => !!(card.setCode || card.collectorNumber);

function entries(text, includeSideboard) {
  const deck = parse(text);
  const result = new Map();
  for (const card of [...deck.mainboard.values(), ...(includeSideboard ? deck.sideboard.values() : [])]) {
    if (!Number.isSafeInteger(card.quantity) || card.quantity < 1) throw printError(`Invalid copy count for ${card.displayName}`);
    const key = identity(card);
    const previous = result.get(key);
    result.set(key, { ...card, isFoil: false, quantity: card.quantity + (previous?.quantity || 0) });
  }
  return result;
}

/** Physical copies aggregate zones and ignore foil (home printing cannot reproduce it). */
export function planPhysicalCopies(targetText, baselineText, { includeSideboard = false, replacePrintings = true, maxCopies = MAX_PRINT_COPIES } = {}) {
  const target = entries(targetText, includeSideboard);
  const baseline = entries(baselineText || '', includeSideboard);
  const remaining = [...target.values()].map(card => ({ ...card }));
  // Preserve exact existing copies before spending unspecified/name-only counts.
  for (const card of remaining) {
    const old = baseline.get(identity(card));
    const consumed = Math.min(card.quantity, old?.quantity || 0);
    card.quantity -= consumed;
    if (old) old.quantity -= consumed;
  }
  for (const card of remaining) {
    for (const old of baseline.values()) {
      if (!card.quantity) break;
      if (normalizeCardName(card.displayName) !== normalizeCardName(old.displayName)) continue;
      if (replacePrintings && hasPrinting(card) && hasPrinting(old)) continue;
      const consumed = Math.min(card.quantity, old.quantity);
      card.quantity -= consumed;
      old.quantity -= consumed;
    }
  }
  const cards = remaining.filter(card => card.quantity > 0);
  const total = cards.reduce((sum, card) => sum + card.quantity, 0);
  if (total > maxCopies) throw printError(`PDF jobs support at most ${maxCopies} physical copies. This request needs ${total}.`);
  return cards;
}

function positiveId(value, field, optional = true) {
  if (optional && (value === undefined || value === null)) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw printError(`${field} must be a positive integer`);
  return value;
}
function flag(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw printError(`${name} must be true or false`);
  return value;
}
function containsControls(value, multiline = false) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 127 || (code < 32 && !(multiline && [9, 10, 13].includes(code)))) return true;
  }
  return false;
}

function readPrintInputs(userId, deckId, options = {}) {
  if (deckId === null) return readStandalonePrintInputs(userId, options);
  const deck = get('SELECT * FROM tracked_decks WHERE id = ? AND user_id = ?', [deckId, userId]);
  if (!deck) throw printError('Deck not found', 404);
  const mode = options.mode || 'full';
  if (!['full', 'changes'].includes(mode)) throw printError('mode must be full or changes');
  const artSource = options.artSource || 'scryfall';
  if (!['scryfall', 'saved-mpc'].includes(artSource)) throw printError('artSource must be scryfall or saved-mpc');
  const includeSideboard = flag(options.includeSideboard, false, 'includeSideboard');
  const replacePrintings = flag(options.replacePrintings, false, 'replacePrintings');
  const targetId = positiveId(options.targetSnapshotId, 'targetSnapshotId');
  const target = targetId
    ? get('SELECT * FROM deck_snapshots WHERE id = ? AND tracked_deck_id = ?', [targetId, deckId])
    : get('SELECT * FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [deckId]);
  if (!target) throw printError('Target snapshot not found', 404);
  let source = null;
  if (mode === 'changes') {
    const sourceId = positiveId(options.baselineSnapshotId ?? deck.paper_snapshot_id, 'baselineSnapshotId', false);
    source = get('SELECT * FROM deck_snapshots WHERE id = ? AND tracked_deck_id = ?', [sourceId, deckId]);
    if (!source) throw printError('Baseline snapshot not found', 404);
    if (source.created_at > target.created_at || (source.created_at === target.created_at && source.id > target.id)) {
      throw printError('The baseline must be the target snapshot or an earlier version');
    }
  }
  const cards = planPhysicalCopies(target.deck_text, source?.deck_text, { includeSideboard, replacePrintings, maxCopies: Infinity });
  let overrides = [];
  if (artSource === 'saved-mpc') {
    try { overrides = JSON.parse(deck.mpc_art_overrides || '[]'); } catch { throw printError('Saved artwork is invalid. Save the artwork choices again.'); }
    if (!Array.isArray(overrides) || overrides.length > 612) throw printError('Saved artwork is invalid');
    overrides = overrides.map(row => {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[1] || typeof row[1] !== 'object') throw printError('Saved artwork contains an invalid entry');
      return [row[0], {
        identifier: typeof row[1].identifier === 'string' ? row[1].identifier : null,
        extension: typeof row[1].extension === 'string' ? row[1].extension : null,
        sourceName: typeof row[1].sourceName === 'string' ? row[1].sourceName : null,
      }];
    }).sort((a, b) => a[0].localeCompare(b[0]));
  }
  const version = snapshot => snapshot && ({ id: snapshot.id, createdAt: snapshot.created_at, text: snapshot.deck_text, textHash: sha256(snapshot.deck_text) });
  const plan = {
    version: 2, deckId, deckName: deck.deck_name, requesterId: userId,
    mode, includeSideboard, replacePrintings, finishChangesRequireReprint: false,
    artSource, source: version(source), target: version(target), cards,
    totalCopies: cards.reduce((sum, card) => sum + card.quantity, 0),
    savedArtwork: overrides,
  };
  return plan;
}

/** Ad-hoc input has no snapshot to validate or preserve it on the user's behalf. */
function readStandalonePrintInputs(userId, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw printError('A print-list request must be an object');
  if (options.mode !== undefined && options.mode !== 'adhoc') throw printError('Standalone print lists require mode adhoc');
  if (options.artSource !== undefined && options.artSource !== 'scryfall') throw printError('Standalone print lists use Scryfall artwork');
  if (options.targetSnapshotId != null || options.baselineSnapshotId != null) throw printError('Standalone print lists do not use deck snapshots');
  const includeSideboard = flag(options.includeSideboard, false, 'includeSideboard');
  const text = options.cardText;
  if (typeof text !== 'string' || !text.trim()) throw printError('Add cards to the print list first');
  if (text.length > MAX_PRINT_LIST_TEXT_LENGTH) throw printError(`Print lists support at most ${MAX_PRINT_LIST_TEXT_LENGTH.toLocaleString('en-US')} characters`);
  if (containsControls(text, true)) throw printError('The print list contains unsupported control characters');
  if (options.listName !== undefined && typeof options.listName !== 'string') throw printError('listName must be text');
  const name = options.listName?.trim() || 'Print list';
  if (name.length > MAX_PRINT_LIST_NAME_LENGTH || containsControls(name)) throw printError(`Print-list names must be at most ${MAX_PRINT_LIST_NAME_LENGTH} characters on one line`);
  validateStandalonePrintText(text);
  const cards = planPhysicalCopies(text, '', { includeSideboard, replacePrintings: true, maxCopies: Infinity });
  if (!cards.length) throw printError('No cards are selected for printing. Add cards or include the sideboard.');
  return {
    version: 2, deckId: null, deckName: name, requesterId: userId, mode: 'adhoc',
    includeSideboard, replacePrintings: true, finishChangesRequireReprint: false,
    artSource: 'scryfall', source: null, target: null, list: { name, text, textHash: sha256(text) },
    cards, totalCopies: cards.reduce((sum, card) => sum + card.quantity, 0), savedArtwork: [],
  };
}

function validateStandalonePrintText(text) {
  const lines = text.trim().split(/\r?\n/);
  // Reuse the parser for CSV rows as well as plain card lines. The ordinary
  // parser tolerates invalid rows; a print request must never silently omit one.
  const csv = lines.length > 1 && lines[0].includes(',') && /quantity|count|name|card/i.test(lines[0]);
  const csvHeader = csv && lines[0].split(',').map(field => field.trim().replace(/^"|"$/g, '').toLowerCase());
  if (csv && !csvHeader.some(field => ['name', 'card', 'card name', 'cardname'].includes(field))) {
    throw printError('CSV print lists need a Name or Card column');
  }
  for (let index = csv ? 1 : 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    if (csv) {
      const row = parse(`${lines[0]}\n${line}`);
      if (!row.mainboard.size && !row.sideboard.size) throw printError(`Print-list line ${index + 1} is invalid or excluded by its CSV section. Remove it or correct its card name and positive whole-number quantity.`);
    } else if (!COMMENT_LINE.test(line) && !MAINBOARD_HEADER.test(line) && !SIDEBOARD_HEADER.test(line)
      && !COMMANDER_HEADER.test(line) && !parseLine(line)) {
      throw printError(`Print-list line ${index + 1} is invalid. Use a card name and a positive whole-number quantity.`);
    }
  }
}

/** Edits affect this print order only; the source snapshot/list stays immutable. */
function selectPrintInputs(inputs, options) {
  const excludeBasicLands = flag(options.excludeBasicLands, true, 'excludeBasicLands');
  const excluded = options.excludedCards ?? [];
  if (!Array.isArray(excluded) || excluded.length > 1000 || excluded.some(key => typeof key !== 'string' || key.length > 1000)) {
    throw printError('excludedCards must contain at most 1000 card selection keys');
  }
  for (const key of excluded) {
    let tuple;
    try { tuple = JSON.parse(key); } catch { throw printError('Invalid excluded card selection key'); }
    if (!Array.isArray(tuple) || tuple.length !== 3 || tuple.some(value => typeof value !== 'string')
      || printCardKey({ displayName: tuple[0], setCode: tuple[1], collectorNumber: tuple[2] }) !== key) throw printError('Invalid excluded card selection key');
  }
  const excludedCards = [...new Set(excluded)].sort();
  const additionalCardText = options.additionalCardText ?? '';
  if (typeof additionalCardText !== 'string' || additionalCardText.length > MAX_PRINT_LIST_TEXT_LENGTH) throw printError(`Extra cards must be text of at most ${MAX_PRINT_LIST_TEXT_LENGTH.toLocaleString('en-US')} characters`);
  if (containsControls(additionalCardText, true)) throw printError('Extra cards contain unsupported control characters');
  if (additionalCardText.trim()) validateStandalonePrintText(additionalCardText);
  const extras = planPhysicalCopies(additionalCardText, '', { includeSideboard: inputs.includeSideboard, maxCopies: Infinity });
  const removedCards = [], excludedBasicLands = [], selected = new Map();
  const add = (card, origin) => {
    const selectionKey = printCardKey(card);
    const row = { ...card, selectionKey, baseQuantity: origin === 'base' ? card.quantity : 0, additionalQuantity: origin === 'additional' ? card.quantity : 0 };
    if (origin === 'base' && excludedCards.includes(selectionKey)) { removedCards.push(row); return; }
    if (excludeBasicLands && isBasicLand(card)) { excludedBasicLands.push(row); return; }
    const previous = selected.get(selectionKey);
    selected.set(selectionKey, previous ? { ...previous, quantity: previous.quantity + row.quantity,
      baseQuantity: previous.baseQuantity + row.baseQuantity, additionalQuantity: previous.additionalQuantity + row.additionalQuantity } : row);
  };
  inputs.cards.forEach(card => add(card, 'base'));
  extras.forEach(card => add(card, 'additional'));
  const cards = [...selected.values()], totalCopies = cards.reduce((sum, card) => sum + card.quantity, 0);
  if (!Number.isSafeInteger(totalCopies) || totalCopies > MAX_PRINT_COPIES) throw printError(`PDF jobs support at most ${MAX_PRINT_COPIES} physical copies. This request needs ${totalCopies}.`);
  return { ...inputs, excludeBasicLands, excludedCards, additionalCardText,
    additionalTextHash: sha256(additionalCardText), removedCards, excludedBasicLands, cards, totalCopies };
}

/** Use the same name matching for review and generation, including full DFC aliases. */
export function savedPrintArt(savedArtwork, card, face) {
  const exact = new Map(savedArtwork.map(([name, art]) => [normalizedName(name), art]));
  const fronts = new Map(savedArtwork.map(([name, art]) => [normalizeCardName(name), art]));
  const name = card.faceNames?.[face === 'front' ? 0 : 1];
  const requestedIsFront = normalizeCardName(card.displayName) === normalizeCardName(name || card.displayName);
  return face === 'front'
    ? ((requestedIsFront && exact.get(normalizedName(card.displayName))) || fronts.get(normalizeCardName(name || card.displayName)))
    : exact.get(normalizedName(name));
}

/** Resolve exact printing/face identities before review; no image bytes are downloaded here. */
export async function buildPrintPlan(userId, deckId, options = {}) {
  const inputs = selectPrintInputs(readPrintInputs(userId, deckId, options), options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Artwork metadata review exceeded 60 seconds. Review the print list again.')), PRINT_METADATA_TIMEOUT_MS);
  timer.unref?.();
  let resolved;
  try { resolved = await fetchCardImageUrls(inputs.cards, { allowIncomplete: true, signal: controller.signal }); }
  finally { clearTimeout(timer); }
  const excludedBasicLands = [...inputs.excludedBasicLands];
  const selectedResolved = resolved.filter(card => {
    if (inputs.excludeBasicLands && isBasicLand(card)) { excludedBasicLands.push(card); return false; }
    return true;
  });
  const resolvedCards = selectedResolved.map(card => {
    const identityKnown = !!card.scryfallId;
    const unsupported = card.layout === 'meld'
      ? 'Meld cards need a special paired back layout and cannot be generated yet'
      : card.isDFC && card.faceNames?.length !== 2 ? 'This multi-sided layout is not supported for printing' : null;
    // MPC provides its own pixels, but still requires a resolved physical layout.
    const lookupFailures = (card.lookupFailures || []).filter(item => inputs.artSource === 'scryfall' || item.face === 'card');
    const errors = lookupFailures.map(item => item.reason);
    if (!identityKnown && !errors.length) errors.push('Card/printing could not be resolved');
    if (unsupported) errors.push(unsupported);
    const faces = (card.isDFC ? ['front', 'back'] : ['front']).map(face => {
      const name = card.faceNames?.[face === 'front' ? 0 : 1] || (face === 'front' ? card.displayName : 'Unknown back face');
      const art = inputs.artSource === 'saved-mpc' ? savedPrintArt(inputs.savedArtwork, card, face) : null;
      const identifier = inputs.artSource === 'saved-mpc' ? art?.identifier || null : card.scryfallId || null;
      const selected = inputs.artSource === 'saved-mpc' ? /^[a-zA-Z0-9_-]{10,120}$/.test(identifier || '') : !!card.imageUrls?.[face];
      const error = !identityKnown ? errors[0] : unsupported || (!selected
        ? inputs.artSource === 'saved-mpc' ? `No saved ${face} artwork selection for ${name}` : `No ${face} image URL available`
        : lookupFailures.find(item => item.face === face)?.reason || null);
      if (error && !errors.includes(error)) errors.push(error);
      return { face, name, source: inputs.artSource, identifier,
        thumbnailUrl: selected ? inputs.artSource === 'saved-mpc' ? `/api/mpc/thumbnail/${identifier}` : card.thumbnailUrls?.[face] || card.imageUrls?.[face] : null,
        sourceName: art?.sourceName || null, extension: art?.extension || null,
        status: error ? selected ? 'error' : 'missing' : 'ready', error };
    });
    return { ...card, layout: card.layout || null, isDFC: identityKnown && !unsupported ? !!card.isDFC : null,
      faceNames: card.faceNames || [], scryfallId: card.scryfallId || null, faces, errors };
  });
  // Resolution may take seconds. Do not accept artwork/snapshot edits made while it ran.
  if (JSON.stringify(selectPrintInputs(readPrintInputs(userId, deckId, options), options)) !== JSON.stringify(inputs)) {
    throw printError('Snapshots or artwork changed during preview. Review a fresh plan.', 409);
  }
  const missingArtwork = resolvedCards.flatMap(card => card.faces.filter(face => face.status !== 'ready').map(face => ({
    displayName: card.displayName, setCode: card.setCode, collectorNumber: card.collectorNumber,
    quantity: card.quantity, face: face.face, name: face.name, reason: face.error,
  })));
  const identitiesComplete = resolvedCards.every(card => card.scryfallId && typeof card.isDFC === 'boolean');
  const filteredKeys = new Set(excludedBasicLands.map(card => card.selectionKey));
  const cards = inputs.cards.filter(card => !filteredKeys.has(card.selectionKey));
  const totalCopies = cards.reduce((sum, card) => sum + card.quantity, 0);
  const plan = { ...inputs, cards, totalCopies, excludedBasicLands, resolvedCards, missingArtwork,
    readyToGenerate: totalCopies > 0 && resolvedCards.length === cards.length && resolvedCards.every(card => !card.errors.length),
    ordinaryCopies: identitiesComplete ? resolvedCards.filter(card => !card.isDFC).reduce((sum, card) => sum + card.quantity, 0) : null,
    doubleFacedCopies: identitiesComplete ? resolvedCards.filter(card => card.isDFC).reduce((sum, card) => sum + card.quantity, 0) : null,
  };
  return { ...plan, planHash: sha256(JSON.stringify(plan)) };
}

export function publicPrintPlan(plan) {
  const version = snapshot => snapshot && ({ id: snapshot.id, createdAt: snapshot.createdAt, textHash: snapshot.textHash });
  const { savedArtwork: _saved, additionalCardText: _extraText, ...publicPlan } = plan;
  return { ...publicPlan, source: version(plan.source), target: version(plan.target),
    ...(plan.list ? { list: { name: plan.list.name, textHash: plan.list.textHash } } : {}) };
}
