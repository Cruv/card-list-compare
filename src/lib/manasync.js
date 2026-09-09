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
    card: resolvedIdentity({
      name: entry.displayName, setCode: entry.setCode || '',
      collectorNumber: entry.collectorNumber || '',
      finish: entry.isFoil ? 'foil' : 'nonfoil', language: 'en',
    }, cardMap),
  }));
}

function normalizePrintingKey(value) {
  const parts = value.split('|');
  if (parts.length >= 5) parts[parts.length-4] = parts[parts.length-4].toLowerCase();
  return parts.join('|');
}
function matchedRows(card,rows,by) {
  const printing = `${card.scryfallId || `${card.name.toLowerCase()}|${card.setCode}|${card.collectorNumber}`}|${card.finish}|${card.language}`;
  const fallbackPrinting = `${card.name.toLowerCase()}|${card.setCode?.toLowerCase()}|${card.collectorNumber}|${card.finish}|${card.language}`;
  return rows.filter(row => by === 'printing' ? row.key === printing || normalizePrintingKey(row.key) === fallbackPrinting :
    (card.oracleId && row.key === card.oracleId) || normalizeCardName(row.name) === normalizeCardName(card.name));
}
export function ownershipFor(card,rows,by,known) {
  if (!known || (by === 'printing' && !card.scryfallId)) return null;
  const matches = matchedRows(card,rows,by);
  const result = {realOwned:0,incoming:0,received:0,available:0,allocated:0,proxies:0,locations:[]};
  for (const row of matches) {
    for (const field of ['realOwned','incoming','received','available','allocated','proxies']) result[field] += Number(row[field]) || 0;
    result.locations.push(...(row.locations || []));
  }
  return result;
}
export function withShortages(cards, rows, by, known) {
  // Consume actual returned ownership rows once, even when one deck entry has an
  // oracle ID and another entry for the same card only has its name resolved.
  const consumed = new Map();
  return cards.map(entry => {
    const ownership = ownershipFor(entry.card,rows,by,known);
    let shortage = ownership ? entry.quantity : null;
    if (ownership) for (const row of matchedRows(entry.card,rows,by)) {
      const used = consumed.get(row.key) || 0;
      const count = Math.min(shortage,Math.max(0,(Number(row.realOwned) || 0)-used));
      consumed.set(row.key,used+count);
      shortage -= count;
    }
    return {...entry,ownership,shortage};
  });
}

export function shoppingText(cards, exact) {
  return cards.filter(entry => entry.shortage > 0).map(entry => `${entry.shortage} ${entry.card.name}${exact && entry.card.setCode && entry.card.collectorNumber ? ` (${entry.card.setCode}) ${entry.card.collectorNumber}` : ''}`).join('\n');
}
export function manaPoolLink(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `https://manapool.com/add-deck?deck=${encodeURIComponent(btoa(binary))}`;
}
