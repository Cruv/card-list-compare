import crypto from 'node:crypto';
import { parse } from '../../src/lib/parser.js';
import { normalizeCardName } from '../../src/lib/cardIdentity.js';
import { get } from '../db.js';

export const MAX_PRINT_COPIES = 250;
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

export function buildPrintPlan(userId, deckId, options = {}) {
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
      return [row[0], { identifier: row[1].identifier || null, extension: row[1].extension || null, sourceName: row[1].sourceName || null }];
    }).sort((a, b) => a[0].localeCompare(b[0]));
  }
  const selectedNames = new Set(overrides.filter(row => /^[a-zA-Z0-9_-]{10,120}$/.test(row[1].identifier || '')).map(row => normalizeCardName(row[0])));
  const missingArtwork = artSource === 'saved-mpc'
    ? cards.filter(card => !selectedNames.has(normalizeCardName(card.displayName))).map(card => ({ displayName: card.displayName, face: 'front', quantity: card.quantity }))
    : [];
  const version = snapshot => snapshot && ({ id: snapshot.id, createdAt: snapshot.created_at, text: snapshot.deck_text, textHash: sha256(snapshot.deck_text) });
  const plan = {
    version: 1, deckId, deckName: deck.deck_name, requesterId: userId,
    mode, includeSideboard, replacePrintings, finishChangesRequireReprint: false,
    artSource, source: version(source), target: version(target), cards,
    totalCopies: cards.reduce((sum, card) => sum + card.quantity, 0),
    savedArtwork: overrides, missingArtwork,
  };
  return { ...plan, planHash: sha256(JSON.stringify(plan)) };
}

export function publicPrintPlan(plan) {
  const version = snapshot => snapshot && ({ id: snapshot.id, createdAt: snapshot.createdAt, textHash: snapshot.textHash });
  const { savedArtwork: _saved, ...publicPlan } = plan;
  return { ...publicPlan, source: version(plan.source), target: version(plan.target) };
}
