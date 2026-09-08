import { normalizeCardName } from './cardIdentity.js';

/**
 * Build a lookup from bare name → composite keys for maps that use composite keys.
 * This allows matching a bare card name against its complete printing keys.
 */
function buildNameIndex(map) {
  const index = new Map();
  for (const key of map.keys()) {
    const pipe = key.indexOf('|');
    if (pipe !== -1) {
      const bare = key.slice(0, pipe);
      if (!index.has(bare)) index.set(bare, []);
      index.get(bare).push(key);
    }
  }
  return index;
}

/**
 * Collapse multiple composite keys (e.g. 9 different Nazgul printings) into a
 * single bare-name entry with aggregated quantity.
 */
function collapseCompositeKeys(map, compositeKeys, bare) {
  let totalQty = 0;
  let bestEntry = null;
  for (const ck of compositeKeys) {
    const entry = map.get(ck);
    totalQty += entry.quantity;
    if (!bestEntry) bestEntry = entry;
    map.delete(ck);
  }
  // Multiple printings do not identify one artwork. Keep the name and count,
  // but do not attach the first printing's set to an aggregate of many sets.
  map.set(bare, { ...bestEntry, quantity: totalQty, setCode: '', collectorNumber: '', isFoil: false });
}

/**
 * If a name appears as BOTH a bare key and composite key(s) in the same map
 * (e.g. "2 Nazgul" plus "1 Nazgul (ltr) [100]"), merge the composites into the
 * bare key, summing quantity. Otherwise the key-by-key diff compares the split
 * representations and invents phantom in/out rows for cards that never moved
 * (audit H5). Runs after DFC normalization so front-face renames are in place.
 *
 * Merging DISCARDS the composite printings, so it only happens when the other
 * side carries no printing detail for that name. When both sides name printings
 * (e.g. one copy re-sleeved from C21 to LTC), the per-printing keys must survive
 * or the printing swap is erased and the changelog reports "no changes".
 */
function mergeMixedKeys(map, otherMap) {
  const index = buildNameIndex(map);
  const otherHasComposite = buildNameIndex(otherMap);
  for (const [bare, compositeKeys] of index) {
    if (!map.has(bare)) continue; // only the mixed case — bare AND composite both present
    if (otherHasComposite.has(bare)) continue; // both sides have printings — keep them
    const bareEntry = map.get(bare);
    let totalQty = bareEntry.quantity;
    for (const ck of compositeKeys) {
      const entry = map.get(ck);
      totalQty += entry.quantity;
      map.delete(ck);
    }
    map.set(bare, { ...bareEntry, quantity: totalQty });
  }
}

/**
 * Normalize double-faced names while preserving each printing and copy count.
 */
function normalizeDFCKeys(map) {
  for (const key of [...map.keys()]) {
    // Normalize every name before indexing, including full bare DFC names
    // compared with a metadata-qualified front face. Keep the complete printing
    // suffix; renaming must never drop or overwrite quantities.
    const pipe = key.indexOf('|');
    const name = pipe !== -1 ? key.slice(0, pipe) : key;
    const suffix = pipe !== -1 ? key.slice(pipe) : '';
    const front = normalizeCardName(name);
    if (front === name) continue;
    const frontKey = front + suffix;
    const entry = map.get(key);
    const existing = map.get(frontKey);
    map.delete(key);
    map.set(frontKey, existing
      ? { ...existing, quantity: existing.quantity + entry.quantity }
      : entry);
  }
}

function diffSection(beforeMap, afterMap) {
  const cardsIn = [];
  const cardsOut = [];
  const quantityChanges = [];

  const before = new Map(beforeMap);
  const after = new Map(afterMap);

  // First normalize DFC names so "Sheoldred // The True Scriptures" matches "Sheoldred"
  // This must run before composite key remapping so the name indexes are correct.
  normalizeDFCKeys(before);
  normalizeDFCKeys(after);

  // Collapse any name that appears as both bare and composite within a side, so
  // the comparison below sees one entry per name and does not fabricate diffs (H5).
  // Each call checks the opposite side so a genuine printing change is preserved.
  mergeMixedKeys(before, after);
  mergeMixedKeys(after, before);

  const afterIndex = buildNameIndex(after);
  const beforeIndex = buildNameIndex(before);

  // Remap bare before keys → composite after keys (single printing)
  // or collapse multiple composite after keys into bare key (multi-printing)
  for (const [bare, compositeKeys] of afterIndex) {
    if (after.has(bare)) continue; // bare key already exists in after, skip
    if (before.has(bare)) {
      if (compositeKeys.length === 1) {
        const entry = before.get(bare);
        before.delete(bare);
        before.set(compositeKeys[0], entry);
      } else {
        collapseCompositeKeys(after, compositeKeys, bare);
      }
    }
  }

  // Remap bare after keys → composite before keys (single printing)
  // or collapse multiple composite before keys into bare key (multi-printing)
  for (const [bare, compositeKeys] of beforeIndex) {
    if (before.has(bare)) continue; // bare key already exists in before, skip
    if (after.has(bare)) {
      if (compositeKeys.length === 1) {
        const entry = after.get(bare);
        after.delete(bare);
        after.set(compositeKeys[0], entry);
      } else {
        collapseCompositeKeys(before, compositeKeys, bare);
      }
    }
  }

  const allKeys = new Set([...before.keys(), ...after.keys()]);

  for (const key of allKeys) {
    const beforeEntry = before.get(key);
    const afterEntry = after.get(key);

    const beforeQty = beforeEntry ? beforeEntry.quantity : 0;
    const afterQty = afterEntry ? afterEntry.quantity : 0;
    const displayName = (afterEntry || beforeEntry).displayName;
    // Carry one known printing as a whole when a bare import matched it. A bare
    // entry's default false finish must not turn a carried foil into nonfoil.
    const hasPrinting = entry => entry && (entry.setCode || entry.collectorNumber || entry.isFoil);
    const printing = hasPrinting(afterEntry) ? afterEntry : (beforeEntry || afterEntry);
    const setCode = printing?.setCode || '';
    const collectorNumber = printing?.collectorNumber || '';
    const isFoil = printing?.isFoil || false;

    if (beforeQty === 0 && afterQty > 0) {
      cardsIn.push({ name: displayName, quantity: afterQty, setCode, collectorNumber, isFoil });
    } else if (beforeQty > 0 && afterQty === 0) {
      cardsOut.push({ name: displayName, quantity: beforeQty, setCode, collectorNumber, isFoil });
    } else if (beforeQty !== afterQty) {
      quantityChanges.push({
        name: displayName,
        oldQty: beforeQty,
        newQty: afterQty,
        delta: afterQty - beforeQty,
        setCode,
        collectorNumber,
        isFoil,
      });
    }
  }

  // Detect printing changes: same card name in both cardsIn and cardsOut with same quantity
  // These are printing/artwork swaps, not actual card additions or removals
  const printingChanges = [];
  const outByName = new Map();
  for (const card of cardsOut) {
    const key = normalizeCardName(card.name);
    if (!outByName.has(key)) outByName.set(key, []);
    outByName.get(key).push(card);
  }

  for (let i = cardsIn.length - 1; i >= 0; i--) {
    const inCard = cardsIn[i];
    const key = normalizeCardName(inCard.name);
    const outGroup = outByName.get(key);
    if (!outGroup || outGroup.length === 0) continue;

    // Find matching out card with same quantity
    const outIdx = outGroup.findIndex(o => o.quantity === inCard.quantity);
    if (outIdx === -1) continue;

    const outCard = outGroup[outIdx];
    printingChanges.push({
      name: inCard.name,
      quantity: inCard.quantity,
      oldSetCode: outCard.setCode,
      oldCollectorNumber: outCard.collectorNumber,
      oldIsFoil: outCard.isFoil,
      newSetCode: inCard.setCode,
      newCollectorNumber: inCard.collectorNumber,
      newIsFoil: inCard.isFoil,
    });

    // Remove from both arrays
    cardsIn.splice(i, 1);
    outGroup.splice(outIdx, 1);
    const globalOutIdx = cardsOut.indexOf(outCard);
    if (globalOutIdx !== -1) cardsOut.splice(globalOutIdx, 1);
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  cardsIn.sort(byName);
  cardsOut.sort(byName);
  quantityChanges.sort(byName);
  printingChanges.sort(byName);

  const allNames = new Set([...before.values(), ...after.values()].map(entry => normalizeCardName(entry.displayName)));
  const changedNames = new Set([...cardsIn, ...cardsOut, ...quantityChanges, ...printingChanges].map(card => normalizeCardName(card.name)));
  return {
    cardsIn, cardsOut, quantityChanges, printingChanges,
    totalUniqueCards: allNames.size,
    unchangedCount: [...allNames].filter(name => !changedNames.has(name)).length,
  };
}

export function computeDiff(before, after) {
  return {
    mainboard: diffSection(before.mainboard, after.mainboard),
    sideboard: diffSection(before.sideboard, after.sideboard),
    hasSideboard: before.sideboard.size > 0 || after.sideboard.size > 0,
    commanders: after.commanders || [],
  };
}
