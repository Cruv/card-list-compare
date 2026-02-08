function diffSection(beforeMap, afterMap) {
  const cardsIn = [];
  const cardsOut = [];
  const quantityChanges = [];

  const allKeys = new Set([...beforeMap.keys(), ...afterMap.keys()]);

  for (const key of allKeys) {
    const beforeEntry = beforeMap.get(key);
    const afterEntry = afterMap.get(key);

    const beforeQty = beforeEntry ? beforeEntry.quantity : 0;
    const afterQty = afterEntry ? afterEntry.quantity : 0;
    const displayName = (afterEntry || beforeEntry).displayName;

    if (beforeQty === 0 && afterQty > 0) {
      cardsIn.push({ name: displayName, quantity: afterQty });
    } else if (beforeQty > 0 && afterQty === 0) {
      cardsOut.push({ name: displayName, quantity: beforeQty });
    } else if (beforeQty !== afterQty) {
      quantityChanges.push({
        name: displayName,
        oldQty: beforeQty,
        newQty: afterQty,
        delta: afterQty - beforeQty,
      });
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  cardsIn.sort(byName);
  cardsOut.sort(byName);
  quantityChanges.sort(byName);

  return { cardsIn, cardsOut, quantityChanges };
}

export function computeDiff(before, after) {
  return {
    mainboard: diffSection(before.mainboard, after.mainboard),
    sideboard: diffSection(before.sideboard, after.sideboard),
    hasSideboard: before.sideboard.size > 0 || after.sideboard.size > 0,
  };
}
