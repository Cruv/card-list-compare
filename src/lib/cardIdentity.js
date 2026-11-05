/** Normalize spelling for stable keys without changing the displayed card name. */
export function normalizedName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .replace(/['\u2018\u2019`\u2032]/g, "'")
    .trim()
    .toLowerCase();
}

/** Front-face names match full double-faced names during deck comparison. */
export function normalizeCardName(name) {
  return normalizedName(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/\s*\/\/\s*/)[0].trim();
}

/**
 * Identity of one deck line. Collector numbers are only unique inside a set;
 * foil and nonfoil copies must also remain separate. Bare names intentionally
 * remain bare, since imports without printing information need name matching.
 * Accept both parsed entries and the card identifiers used by Scryfall callers.
 */
export function cardIdentityKey(card) {
  const name = normalizedName(card.displayName ?? card.name);
  const set = String(card.setCode ?? card.set ?? '').trim().toLowerCase();
  const collector = String(card.collectorNumber ?? card.collector_number ?? '').trim().toLowerCase();
  const foil = Boolean(card.isFoil);
  return set || collector || foil
    ? `${name}|${set}|${collector}|${foil ? 'foil' : 'nonfoil'}`
    : name;
}
