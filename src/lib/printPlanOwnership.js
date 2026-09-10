import { printPlanBridgeCards } from './manasync';
import { collectDeckIdentifiers, fetchCardData } from './scryfall';

export async function resolvePrintPlanOwnership(plan) {
  const identifiers = collectDeckIdentifiers({
    mainboard: new Map(plan.cards.map((card, index) => [index, card])),
    sideboard: new Map(),
  });
  const cards = printPlanBridgeCards(plan, await fetchCardData(identifiers));
  // Scryfall transport failures produce unresolved sentinel rows, not rejections.
  const unresolved = cards.filter(({ card }) => card.setCode && card.collectorNumber && !card.scryfallId);
  return { cards, unresolved };
}
