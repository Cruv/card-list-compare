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

/** Stable key for one rendered deck line. */
export function lineKey(board, cardName, collectorNumber) {
  return `${board}|${(cardName || '').toLowerCase()}|${collectorNumber || ''}`;
}

/**
 * Split the owned copies of each card across the deck lines that need them.
 *
 * A name can appear on several lines (two printings, or mainboard + sideboard).
 * Showing each line the FULL owned total would let one physical copy satisfy
 * every line at once — the per-line badges would then disagree with the
 * collection summary. Allocate a per-name budget instead: earlier lines consume
 * copies, later lines see only what is left.
 *
 * Returns Map<lineKey, ownedCopiesForThatLine>.
 */
export function allocateOwnedCopies(parsedDeck, index) {
  const allocation = new Map();
  if (!parsedDeck || !index) return allocation;

  const remaining = new Map(index); // per-name budget, consumed as we go
  const boards = [['Mainboard', parsedDeck.mainboard], ['Sideboard', parsedDeck.sideboard]];

  for (const [board, section] of boards) {
    if (!section) continue;
    // Same order the UI renders in, so the copies land on the lines shown first.
    const entries = [...section.values()].sort(
      (a, b) =>
        a.displayName.localeCompare(b.displayName) ||
        String(a.collectorNumber || '').localeCompare(String(b.collectorNumber || ''))
    );
    for (const entry of entries) {
      const key = normalize(entry.displayName);
      const available = remaining.get(key) || 0;
      const take = Math.min(available, entry.quantity);
      remaining.set(key, available - take);
      allocation.set(lineKey(board, entry.displayName, entry.collectorNumber), take);
    }
  }

  return allocation;
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
