import { printPlanBridgeCards } from './manasync';
import { collectDeckIdentifiers, fetchCardData } from './scryfall';

export async function resolvePrintPlanOwnership(plan) {
  if (Array.isArray(plan.resolvedCards) && plan.resolvedCards.length === plan.cards.length) {
    const cards = printPlanBridgeCards(plan, null);
    return { cards, unresolved: cards.filter(({ card }) => !card.oracleId) };
  }
  const identifiers = collectDeckIdentifiers({
    mainboard: new Map(plan.cards.map((card, index) => [index, card])),
    sideboard: new Map(),
  });
  const cards = printPlanBridgeCards(plan, await fetchCardData(identifiers));
  // Scryfall transport failures produce unresolved sentinel rows, not rejections.
  const unresolved = cards.filter(({ card }) => !card.oracleId);
  return { cards, unresolved };
}
