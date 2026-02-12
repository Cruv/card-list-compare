/**
 * Build a lookup from bare name → composite keys for maps that use composite keys.
 * This allows matching "lightning bolt" against "lightning bolt|227".
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
  map.set(bare, { ...bestEntry, quantity: totalQty, collectorNumber: '', isFoil: false });
}

/**
 * Extract front face from a double-faced card name.
 * "sheoldred // the true scriptures" → "sheoldred"
 */
function frontFace(name) {
  const slash = name.indexOf(' // ');
  return slash !== -1 ? name.slice(0, slash) : name;
}

/**
 * Normalize DFC keys in a map: rename "name // back" keys to just "name"
 * when the other map has the front-face-only key. Handles both bare keys
 * and composite keys (name|collectorNumber).
 */
function normalizeDFCKeys(map, otherMap) {
  for (const key of [...map.keys()]) {
    if (otherMap.has(key)) continue;

    // Extract the name portion (strip collector number if present)
    const pipe = key.indexOf('|');
    const name = pipe !== -1 ? key.slice(0, pipe) : key;
    const suffix = pipe !== -1 ? key.slice(pipe) : '';
    const front = frontFace(name);
    if (front === name) continue;

    // Try matching the front-face key (with same collector number suffix) in other map
    const frontKey = front + suffix;
    if (otherMap.has(frontKey) && !map.has(frontKey)) {
      const entry = map.get(key);
      map.delete(key);
      map.set(frontKey, entry);
      continue;
    }

    // Try matching the bare front-face (no collector number) in other map
    // e.g. "sheoldred // the true scriptures|123" → "sheoldred" when other has "sheoldred"
    if (otherMap.has(front) && !map.has(front)) {
      const entry = map.get(key);
      map.delete(key);
      map.set(front, entry);
    }
  }
}

function diffSection(beforeMap, afterMap) {
  const cardsIn = [];
  const cardsOut = [];
  const quantityChanges = [];
  let unchangedCount = 0;

  const before = new Map(beforeMap);
  const after = new Map(afterMap);

  // First normalize DFC names so "Sheoldred // The True Scriptures" matches "Sheoldred"
  // This must run before composite key remapping so the name indexes are correct.
  normalizeDFCKeys(before, after);
  normalizeDFCKeys(after, before);

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
    // Prefer metadata from afterEntry (current state), fall back to beforeEntry
    const setCode = (afterEntry?.setCode || beforeEntry?.setCode || '');
    const collectorNumber = (afterEntry?.collectorNumber || beforeEntry?.collectorNumber || '');
    const isFoil = afterEntry?.isFoil ?? beforeEntry?.isFoil ?? false;

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
    } else {
      unchangedCount++;
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  cardsIn.sort(byName);
  cardsOut.sort(byName);
  quantityChanges.sort(byName);

  return { cardsIn, cardsOut, quantityChanges, totalUniqueCards: allKeys.size, unchangedCount };
}

export function computeDiff(before, after) {
  return {
    mainboard: diffSection(before.mainboard, after.mainboard),
    sideboard: diffSection(before.sideboard, after.sideboard),
    hasSideboard: before.sideboard.size > 0 || after.sideboard.size > 0,
    commanders: after.commanders || [],
  };
}
