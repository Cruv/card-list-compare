/**
 * Match a user's imported collection against deck cards so deck views can show
 * what the user already owns. Matching is by card NAME (summed across printings
 * and foil/non-foil), DFC front-face aware and accent-insensitive, so
 * "Nazgûl" / "nazgul" and "Fable of the Mirror-Breaker // …" all resolve to the
 * same owned bucket regardless of how the deck or the collection spells them.
 */

function normalize(name) {
  const lower = (name || '').toLowerCase();
  const slash = lower.indexOf(' // ');
  const front = slash !== -1 ? lower.slice(0, slash) : lower;
  return front.normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/**
 * Build an index from a collection card list (server shape: objects with
 * `card_name` and `quantity`) to total owned quantity per normalized name.
 */
export function buildOwnedIndex(collectionCards) {
  const index = new Map();
  for (const c of collectionCards || []) {
    const key = normalize(c.card_name);
    if (!key) continue;
    index.set(key, (index.get(key) || 0) + (Number(c.quantity) || 0));
  }
  return index;
}

/** Total copies of a card name the user owns (0 if none / no index). */
export function ownedCount(cardName, index) {
  if (!index) return 0;
  return index.get(normalize(cardName)) || 0;
}

/**
 * Coverage of a parsed deck by the collection. Needed copies are aggregated per
 * card name across mainboard + sideboard first, so a card in both sections is
 * counted once. Returns unique/owned counts and total copies owned vs needed.
 */
export function collectionCoverage(parsedDeck, index) {
  const needed = new Map();
  for (const section of [parsedDeck?.mainboard, parsedDeck?.sideboard]) {
    if (!section) continue;
    for (const [, entry] of section) {
      const key = normalize(entry.displayName);
      if (!key) continue;
      needed.set(key, (needed.get(key) || 0) + entry.quantity);
    }
  }

  let uniqueOwned = 0;
  let copiesOwned = 0;
  let copiesNeeded = 0;
  for (const [key, need] of needed) {
    const owned = index?.get(key) || 0;
    if (owned > 0) uniqueOwned++;
    copiesOwned += Math.min(owned, need);
    copiesNeeded += need;
  }

  return { uniqueOwned, uniqueTotal: needed.size, copiesOwned, copiesNeeded };
}
