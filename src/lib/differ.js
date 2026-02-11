function diffSection(beforeMap, afterMap) {
  const cardsIn = [];
  const cardsOut = [];
  const quantityChanges = [];
  let unchangedCount = 0;

  const allKeys = new Set([...beforeMap.keys(), ...afterMap.keys()]);

  for (const key of allKeys) {
    const beforeEntry = beforeMap.get(key);
    const afterEntry = afterMap.get(key);

    const beforeQty = beforeEntry ? beforeEntry.quantity : 0;
    const afterQty = afterEntry ? afterEntry.quantity : 0;
    const displayName = (afterEntry || beforeEntry).displayName;
    // Prefer set code from afterEntry (current state), fall back to beforeEntry
    const setCode = (afterEntry?.setCode || beforeEntry?.setCode || '');

    if (beforeQty === 0 && afterQty > 0) {
      cardsIn.push({ name: displayName, quantity: afterQty, setCode });
    } else if (beforeQty > 0 && afterQty === 0) {
      cardsOut.push({ name: displayName, quantity: beforeQty, setCode });
    } else if (beforeQty !== afterQty) {
      quantityChanges.push({
        name: displayName,
        oldQty: beforeQty,
        newQty: afterQty,
        delta: afterQty - beforeQty,
        setCode,
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
