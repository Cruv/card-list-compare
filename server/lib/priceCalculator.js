import { get, run } from '../db.js';
import { parse } from '../../src/lib/parser.js';
import { fetchCardPrices, fetchSpecificPrintingPrices, printingKey } from './scryfall.js';

/**
 * Compute deck prices from deck text and stamp results to the database.
 * Used by both the prices API endpoint and the auto-refresh scheduler.
 *
 * @param {number} deckId — tracked_decks.id
 * @param {string} deckText — raw deck text to price
 * @returns {{ totalPrice: number, budgetPrice: number, cards: Array }} or null on failure
 */
export async function computeDeckPrices(deckId, deckText) {
  if (!deckText) return null;

  const parsed = parse(deckText);
  const cardNames = [];
  const cardEntries = [];
  for (const [, entry] of parsed.mainboard) {
    cardNames.push(entry.displayName);
    cardEntries.push({ name: entry.displayName, set: entry.setCode, collectorNumber: entry.collectorNumber, isFoil: entry.isFoil, quantity: entry.quantity });
  }
  for (const name of parsed.commanders) cardNames.push(name);

  const [defaultPrices, specificPrices] = await Promise.all([
    fetchCardPrices(cardNames),
    fetchSpecificPrintingPrices(cardEntries),
  ]);

  // Scryfall returned nothing for a deck that has cards — it is down or rate
  // limiting. Report "no data" rather than a $0 deck, which callers would
  // otherwise store as a real price and alert on as a total collapse in value.
  if (cardNames.length > 0 && defaultPrices.size === 0 && specificPrices.size === 0) {
    console.warn(`[Prices] No price data returned for deck ${deckId} — skipping this run`);
    return null;
  }

  let totalPrice = 0;
  let budgetPrice = 0;
  const seen = new Set();
  // Aggregate the display list by name (a card under multiple printings is one
  // row), but every printing's quantity contributes to the totals — the old
  // `seen`-skip dropped all but the first printing, underpricing the deck.
  const cardsByName = new Map();

  for (const [, entry] of parsed.mainboard) {
    const key = entry.displayName.toLowerCase();
    // Mark priced so the commander loop below doesn't re-price a commander that
    // also lives in the mainboard — but do NOT skip other printings of the name.
    seen.add(key);
    const defaultData = defaultPrices.get(key);
    // Look the printing up by set+collector — one card name can appear under
    // several printings at very different prices, so a name lookup would charge
    // them all the same.
    const specificData = (entry.setCode && entry.collectorNumber)
      ? specificPrices.get(printingKey(entry.setCode, entry.collectorNumber))
      : null;

    const cheapNonFoil = defaultData?.priceUsd ?? 0;
    const cheapFoil = defaultData?.priceUsdFoil ?? 0;
    const cheapestPrice = (cheapNonFoil && cheapFoil)
      ? Math.min(cheapNonFoil, cheapFoil)
      : (cheapNonFoil || cheapFoil);

    const useSpecific = specificData && (entry.setCode && entry.collectorNumber);
    const price = useSpecific
      ? (entry.isFoil ? (specificData.priceUsdFoil ?? specificData.priceUsd ?? cheapestPrice) : (specificData.priceUsd ?? cheapestPrice))
      : cheapestPrice;

    const lineTotal = price * entry.quantity;
    const cheapestTotal = cheapestPrice * entry.quantity;
    totalPrice += lineTotal;
    budgetPrice += cheapestTotal;
    if (price > 0 || cheapestPrice > 0) {
      const existing = cardsByName.get(key);
      if (existing) {
        existing.quantity += entry.quantity;
        existing.total += lineTotal;
        existing.cheapestTotal += cheapestTotal;
        // Printings of one name can differ in price, so the row's unit price is
        // the blended average — keep it consistent with total/quantity.
        existing.price = existing.total / existing.quantity;
        existing.cheapestPrice = existing.cheapestTotal / existing.quantity;
      } else {
        cardsByName.set(key, {
          name: entry.displayName,
          quantity: entry.quantity,
          price,
          cheapestPrice,
          total: lineTotal,
          cheapestTotal,
        });
      }
    }
  }
  const cards = [...cardsByName.values()];
  for (const name of parsed.commanders) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const defaultData = defaultPrices.get(key);
    const cNonFoil = defaultData?.priceUsd ?? 0;
    const cFoil = defaultData?.priceUsdFoil ?? 0;
    const cheapestPrice = (cNonFoil && cFoil) ? Math.min(cNonFoil, cFoil) : (cNonFoil || cFoil);
    const price = cheapestPrice;
    const lineTotal = price;
    totalPrice += lineTotal;
    budgetPrice += cheapestPrice;
    if (price > 0) {
      cards.push({ name, quantity: 1, price, cheapestPrice, total: lineTotal, cheapestTotal: cheapestPrice });
    }
  }

  const roundedTotal = Math.round(totalPrice * 100) / 100;
  const roundedBudget = Math.round(budgetPrice * 100) / 100;

  // Update last known prices on the deck
  run('UPDATE tracked_decks SET last_known_price = ?, last_known_budget_price = ? WHERE id = ?',
    [roundedTotal, roundedBudget, deckId]);

  // Stamp latest snapshot with price data
  const latestSnap = get(
    'SELECT id, snapshot_price FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at DESC LIMIT 1',
    [deckId]
  );
  if (latestSnap && latestSnap.snapshot_price === null) {
    run('UPDATE deck_snapshots SET snapshot_price = ?, snapshot_budget_price = ? WHERE id = ?',
      [roundedTotal, roundedBudget, latestSnap.id]);
  }

  cards.sort((a, b) => b.total - a.total);

  return { totalPrice: roundedTotal, budgetPrice: roundedBudget, cards };
}
