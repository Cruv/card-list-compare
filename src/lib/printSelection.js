import { normalizeCardName } from './cardIdentity.js';

/** Stable requested-printing identity, before Scryfall supplies missing metadata. */
export function printCardKey(card) {
  return JSON.stringify([normalizeCardName(card.displayName ?? card.name),
    String(card.setCode ?? card.set ?? '').trim().toLowerCase(),
    String(card.collectorNumber ?? card.collector_number ?? '').trim().toLowerCase()]);
}

const BASIC_LAND_NAMES = new Set(['plains', 'island', 'swamp', 'mountain', 'forest', 'wastes',
  'snow-covered plains', 'snow-covered island', 'snow-covered swamp', 'snow-covered mountain', 'snow-covered forest']);

/** Known names also work during metadata outages; unknown cards stay in review. */
export function isBasicLand(card) {
  const type = String(card.typeLine ?? card.type_line ?? '').split('—')[0];
  return (/\bBasic\b/i.test(type) && /\bLand\b/i.test(type))
    || BASIC_LAND_NAMES.has(normalizeCardName(card.displayName ?? card.name));
}
