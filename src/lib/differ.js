/**
 * Build a lookup from bare name → composite key for maps that use composite keys.
 * This allows matching "lightning bolt" against "lightning bolt|227".
 */
function buildNameIndex(map) {
  const index = new Map();
  for (const key of map.keys()) {
    const pipe = key.indexOf('|');
    if (pipe !== -1) {
      const bare = key.slice(0, pipe);
      // Only index if the bare name isn't also a direct key (avoid collisions)
      if (!map.has(bare)) {
        if (!index.has(bare)) index.set(bare, []);
        index.get(bare).push(key);
      }
    }
  }
  return index;
}

function diffSection(beforeMap, afterMap) {
  const cardsIn = [];
  const cardsOut = [];
  const quantityChanges = [];
  let unchangedCount = 0;

  // Normalize: when one side uses bare keys and the other uses composite keys,
  // remap the bare-key entries to match composite keys so the same card is compared.
  const before = new Map(beforeMap);
  const after = new Map(afterMap);

  const afterIndex = buildNameIndex(after);
  const beforeIndex = buildNameIndex(before);

  // Remap bare before keys → composite after keys
  for (const [bare, compositeKeys] of afterIndex) {
    if (before.has(bare) && compositeKeys.length === 1) {
      const entry = before.get(bare);
      before.delete(bare);
      before.set(compositeKeys[0], entry);
    }
  }

  // Remap bare after keys → composite before keys
  for (const [bare, compositeKeys] of beforeIndex) {
    if (after.has(bare) && compositeKeys.length === 1) {
      const entry = after.get(bare);
      after.delete(bare);
      after.set(compositeKeys[0], entry);
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
