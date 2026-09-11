import crypto from 'node:crypto';
import { parse } from '../../src/lib/parser.js';
import { normalizeCardName, normalizedName } from '../../src/lib/cardIdentity.js';
import { get } from '../db.js';
import { fetchCardImageUrls } from './scryfallImages.js';

export const MAX_PRINT_COPIES = 250;
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
export function planPhysicalCopies(targetText, baselineText, { includeSideboard = false, replacePrintings = true } = {}) {
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
  if (total > MAX_PRINT_COPIES) throw printError(`PDF jobs support at most ${MAX_PRINT_COPIES} physical copies. This request needs ${total}.`);
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

function readPrintInputs(userId, deckId, options = {}) {
  const deck = get('SELECT * FROM tracked_decks WHERE id = ? AND user_id = ?', [deckId, userId]);
  if (!deck) throw printError('Deck not found', 404);
  const mode = options.mode || 'full';
  if (!['full', 'changes'].includes(mode)) throw printError('mode must be full or changes');
  const artSource = options.artSource || 'scryfall';
  if (!['scryfall', 'saved-mpc'].includes(artSource)) throw printError('artSource must be scryfall or saved-mpc');
  const includeSideboard = flag(options.includeSideboard, false, 'includeSideboard');
  const replacePrintings = flag(options.replacePrintings, true, 'replacePrintings');
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
  const cards = planPhysicalCopies(target.deck_text, source?.deck_text, { includeSideboard, replacePrintings });
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
  const inputs = readPrintInputs(userId, deckId, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Artwork metadata review exceeded 60 seconds. Review the print list again.')), PRINT_METADATA_TIMEOUT_MS);
  timer.unref?.();
  let resolved;
  try { resolved = await fetchCardImageUrls(inputs.cards, { allowIncomplete: true, signal: controller.signal }); }
  finally { clearTimeout(timer); }
  const resolvedCards = resolved.map(card => {
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
  if (JSON.stringify(readPrintInputs(userId, deckId, options)) !== JSON.stringify(inputs)) {
    throw printError('Snapshots or artwork changed during preview. Review a fresh plan.', 409);
  }
  const missingArtwork = resolvedCards.flatMap(card => card.faces.filter(face => face.status !== 'ready').map(face => ({
    displayName: card.displayName, setCode: card.setCode, collectorNumber: card.collectorNumber,
    quantity: card.quantity, face: face.face, name: face.name, reason: face.error,
  })));
  const identitiesComplete = resolvedCards.every(card => card.scryfallId && typeof card.isDFC === 'boolean');
  const plan = { ...inputs, resolvedCards, missingArtwork,
    readyToGenerate: inputs.totalCopies > 0 && resolvedCards.every(card => !card.errors.length),
    ordinaryCopies: identitiesComplete ? resolvedCards.filter(card => !card.isDFC).reduce((sum, card) => sum + card.quantity, 0) : null,
    doubleFacedCopies: identitiesComplete ? resolvedCards.filter(card => card.isDFC).reduce((sum, card) => sum + card.quantity, 0) : null,
  };
  return { ...plan, planHash: sha256(JSON.stringify(plan)) };
}

export function publicPrintPlan(plan) {
  const version = snapshot => snapshot && ({ id: snapshot.id, createdAt: snapshot.createdAt, textHash: snapshot.textHash });
  const { savedArtwork: _saved, ...publicPlan } = plan;
  return { ...publicPlan, source: version(plan.source), target: version(plan.target) };
}
