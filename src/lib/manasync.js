import { deckBridgeLines } from './deckBridgeLines.js';
import { cardIdentityKey, normalizedName, normalizeCardName } from './cardIdentity.js';
// Match the explicit ManaSync availability contract. realOwned includes incoming originals.
function resolvedIdentity(card, cardMap) {
  const exact = cardMap?.get(cardIdentityKey({ ...card, isFoil: card.finish === 'foil' }));
  const generic = cardMap?.get(normalizedName(card.name));
  const matches = card.setCode && card.collectorNumber
    && exact?.setCode?.toLowerCase() === card.setCode.toLowerCase()
    && String(exact?.collectorNumber).toLowerCase() === String(card.collectorNumber).toLowerCase();
  return { ...card, oracleId: exact?.oracleId || generic?.oracleId || null,
    scryfallId: matches ? exact.scryfallId || null : null };
}
export function deckBridgeCards(parsed,cardMap,deckText) {
  const lines = deckBridgeLines(deckText);
  if (lines) return lines.map(entry => ({ ...entry, card: resolvedIdentity(entry.card, cardMap) }));
  if (!parsed) return [];
  const cards = [];
  for (const [section,entries] of [['mainboard',parsed.mainboard],['sideboard',parsed.sideboard]]) {
    for (const [key,entry] of entries || []) {
      cards.push({key:`${section}:${key}`,quantity:entry.quantity,section,card:resolvedIdentity({name:entry.displayName,
        setCode:entry.setCode || '',collectorNumber:entry.collectorNumber || '',finish:entry.isFoil ? 'foil' : 'nonfoil',language:'en'},cardMap)});
    }
  }
  for (const name of parsed.commanders || []) if (!cards.some(v => normalizeCardName(v.card.name) === normalizeCardName(name))) {
    cards.push({key:`commander:${name}`,quantity:1,section:'commander',card:{name,oracleId:cardMap?.get(normalizedName(name))?.oracleId || null,
      scryfallId:null,setCode:'',collectorNumber:'',finish:'nonfoil',language:'en'}});
  }
  return cards;
}

/** Use the reviewed physical plan's copies, including its chosen snapshot and zones. */
export function printPlanBridgeCards(plan, cardMap) {
  return (plan?.cards || []).map((entry, index) => ({
    key: `print-plan:${index}:${cardIdentityKey(entry)}`,
    quantity: entry.quantity,
    card: { ...resolvedIdentity({
      name: entry.displayName, setCode: entry.setCode || '',
      collectorNumber: entry.collectorNumber || '',
      finish: entry.isFoil ? 'foil' : 'nonfoil', language: 'en',
    }, cardMap), ...(plan.resolvedCards?.[index] ? {
      oracleId: plan.resolvedCards[index].oracleId || null,
      scryfallId: plan.resolvedCards[index].scryfallId || null,
    } : {}) },
  }));
}

function matchedRows(card, rows) {
  return rows.filter(row => (card.oracleId && row.key === card.oracleId)
    || normalizeCardName(row.name) === normalizeCardName(card.name));
}
/** One original in any printing covers unlimited proxy copies, across decks. */
export function ownershipFor(card, rows, known) {
  if (!known) return null;
  const matches = matchedRows(card, rows);
  // A name match can prove ownership during a lookup outage; an unresolved
  // identity with no match cannot prove that the user owns no original.
  if (!matches.length && !card.oracleId) return null;
  const result = { hasOriginal: false, incomingOnly: false, locations: [] };
  let originals = 0, received = 0, incoming = 0;
  for (const row of matches) {
    originals += Math.max(0, Number(row.realOwned) || 0); // Already includes incoming.
    received += Math.max(0, Number(row.received) || 0);
    incoming += Math.max(0, Number(row.incoming) || 0);
    result.locations.push(...(row.locations || []).filter(location => !location.isProxy));
  }
  result.hasOriginal = originals > 0;
  result.incomingOnly = originals > 0 && received === 0 && incoming > 0;
  return result;
}
export function withOriginalOwnership(cards, rows, known) {
  const oracleByName = new Map(cards.filter(entry => entry.card.oracleId)
    .map(entry => [normalizeCardName(entry.card.name), entry.card.oracleId]));
  return cards.map(entry => {
    const name = normalizeCardName(entry.card.name);
    const oracle = entry.card.oracleId || oracleByName.get(name);
    const ownership = ownershipFor({ ...entry.card, oracleId: oracle }, rows, known);
    return { ...entry, ownership, shoppingKey: oracle ? `oracle:${oracle}` : `name:${name}` };
  });
}

export function shoppingText(cards) {
  const seen = new Set();
  return cards.filter(entry => {
    if (entry.ownership?.hasOriginal !== false || seen.has(entry.shoppingKey)) return false;
    seen.add(entry.shoppingKey);
    return true;
  }).map(entry => `1 ${entry.card.name}`).join('\n');
}
export function manaPoolLink(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `https://manapool.com/add-deck?deck=${encodeURIComponent(btoa(binary))}`;
}
