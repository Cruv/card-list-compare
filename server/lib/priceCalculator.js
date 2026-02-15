import { get, run } from '../db.js';
import { parse } from '../../src/lib/parser.js';
import { fetchCardPrices, fetchSpecificPrintingPrices } from './scryfall.js';

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

  const cards = [];
  let totalPrice = 0;
  let budgetPrice = 0;
  const seen = new Set();

  for (const [, entry] of parsed.mainboard) {
    const key = entry.displayName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const defaultData = defaultPrices.get(key);
    const specificData = specificPrices.get(key);

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
      cards.push({
        name: entry.displayName,
        quantity: entry.quantity,
        price,
        cheapestPrice,
        total: lineTotal,
        cheapestTotal,
      });
    }
  }
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
