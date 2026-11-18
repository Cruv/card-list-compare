import { get, run, transaction } from '../db.js';
import { deckTextIncompatibilities, parse } from '../../src/lib/parser.js';
import { normalizeCardName } from '../../src/lib/cardIdentity.js';
import { fetchCardPrices, fetchSpecificPrintingPrices, printingKey } from './scryfall.js';
import { latestSnapshot } from './structuredSnapshots.js';

const validPrice = price => Number.isFinite(price) && price >= 0;

/**
 * Price the captured snapshot and save only complete observations. An older
 * snapshot can receive its own historical price, but cannot change the deck's
 * current total or send a price alert.
 */
export async function computeDeckPrices(deckId, snapshot) {
  const snapshotId = snapshot?.id;
  const deckText = snapshot?.deck_text;
  if (!snapshotId || !deckText) return null;

  const parsed = parse(deckText);
  if (parsed.problems.length && deckTextIncompatibilities(deckText, { includeSideboard: false }).length) return null;

  // The parser already includes commander rows, with their printing and finish,
  // in the mainboard. Price each printing separately before aggregating by name.
  const entries = [...parsed.mainboard.values()];
  let defaultPrices, specificPrices;
  try {
    [defaultPrices, specificPrices] = await Promise.all([
      fetchCardPrices(entries.map(entry => entry.displayName)),
      fetchSpecificPrintingPrices(entries.map(entry => ({
        name: entry.displayName, set: entry.setCode, collectorNumber: entry.collectorNumber,
      }))),
    ]);
  } catch (error) {
    console.warn(`[Prices] Lookup failed for deck ${deckId}: ${error.message}`);
    return null;
  }

  let totalPrice = 0;
  let budgetPrice = 0;
  const cardsByName = new Map();
  for (const entry of entries) {
    const key = entry.displayName.toLowerCase();
    const defaultData = defaultPrices.get(key);
    const budgetOptions = [defaultData?.priceUsd, defaultData?.priceUsdFoil].filter(validPrice);
    if (budgetOptions.length === 0) return null;
    const cheapestPrice = Math.min(...budgetOptions);

    let price = cheapestPrice;
    if (entry.setCode && entry.collectorNumber) {
      const exact = specificPrices.get(printingKey(entry.setCode, entry.collectorNumber));
      price = entry.isFoil ? exact?.priceUsdFoil : exact?.priceUsd;
      if (!validPrice(price) || normalizeCardName(exact.name) !== normalizeCardName(entry.displayName)) return null;
    }

    const total = price * entry.quantity;
    const cheapestTotal = cheapestPrice * entry.quantity;
    totalPrice += total;
    budgetPrice += cheapestTotal;
    const existing = cardsByName.get(key);
    if (existing) {
      existing.quantity += entry.quantity;
      existing.total += total;
      existing.cheapestTotal += cheapestTotal;
      existing.price = existing.total / existing.quantity;
      existing.cheapestPrice = existing.cheapestTotal / existing.quantity;
    } else {
      cardsByName.set(key, { name: entry.displayName, quantity: entry.quantity, price, cheapestPrice, total, cheapestTotal });
    }
  }

  const roundedTotal = Math.round(totalPrice * 100) / 100;
  const roundedBudget = Math.round(budgetPrice * 100) / 100;
  if (!validPrice(roundedTotal) || !validPrice(roundedBudget)) return null;

  const isCurrent = transaction(() => {
    const saved = get('SELECT deck_text, snapshot_price FROM deck_snapshots WHERE id = ? AND tracked_deck_id = ?', [snapshotId, deckId]);
    if (saved?.deck_text !== deckText) return false;
    if (saved.snapshot_price === null) {
      run('UPDATE deck_snapshots SET snapshot_price = ?, snapshot_budget_price = ? WHERE id = ?',
        [roundedTotal, roundedBudget, snapshotId]);
    }
    const current = latestSnapshot(deckId)?.id === snapshotId;
    if (current) {
      run('UPDATE tracked_decks SET last_known_price = ?, last_known_budget_price = ? WHERE id = ?',
        [roundedTotal, roundedBudget, deckId]);
    }
    return current;
  });

  const cards = [...cardsByName.values()].sort((a, b) => b.total - a.total);
  return { snapshotId, isCurrent, totalPrice: roundedTotal, budgetPrice: roundedBudget, cards };
}
