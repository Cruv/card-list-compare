/** Sheet counts are meaningful only after every card's physical faces resolve. */
export function printReviewSummary(plan) {
  const ordinary = plan?.ordinaryCopies, doubleFaced = plan?.doubleFacedCopies;
  if (![ordinary, doubleFaced].every(value => Number.isSafeInteger(value) && value >= 0)
    || ordinary + doubleFaced !== plan.totalCopies) return null;
  const ordinarySheets = Math.ceil(ordinary / 7), packets = Math.ceil(doubleFaced / 7);
  return { ordinary, doubleFaced, ordinarySheets, packets,
    sheets: ordinarySheets + packets, pages: ordinarySheets + packets * 2 };
}

export function printReviewReady(plan) {
  if (plan?.readyToGenerate !== true || !plan.totalCopies || plan.missingArtwork?.length
    || !Array.isArray(plan.resolvedCards) || plan.resolvedCards.length !== plan.cards?.length) return false;
  return plan.resolvedCards.every(card => {
    if (typeof card.isDFC !== 'boolean' || card.errors?.length) return false;
    const required = card.isDFC ? ['front', 'back'] : ['front'];
    return required.every(face => card.faces?.some(item => item.face === face && item.status === 'ready' && item.identifier));
  });
}

/** Return original plan indexes: display filtering never changes printable copies. */
export function printReviewIndexes(plan, options = {}, ownershipRows = []) {
  const query = (options.query || '').trim().toLocaleLowerCase();
  const rows = (plan?.cards || []).map((card, index) => ({ ...card, ...plan.resolvedCards?.[index], index }));
  const filtered = rows.filter(card => {
    const ownership = ownershipRows[card.index]?.ownership;
    const status = !ownership ? 'unknown' : !ownership.hasOriginal ? 'missing' : ownership.incomingOnly ? 'incoming' : 'owned';
    const sides = typeof card.isDFC !== 'boolean' ? 'unresolved' : card.isDFC ? 'double' : 'single';
    return (!query || `${card.displayName} ${card.setCode || ''} ${card.collectorNumber || ''}`.toLocaleLowerCase().includes(query))
      && (!options.sides || options.sides === 'all' || options.sides === sides)
      && (!options.ownership || options.ownership === 'all' || options.ownership === status);
  });
  const byName = (a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }) || a.index - b.index;
  filtered.sort((a, b) => {
    if (options.sort === 'name-desc') return -byName(a, b);
    if (options.sort === 'quantity-desc') return b.quantity - a.quantity || byName(a, b);
    if (options.sort === 'quantity-asc') return a.quantity - b.quantity || byName(a, b);
    if (options.sort === 'double-first') return Number(b.isDFC === true) - Number(a.isDFC === true) || byName(a, b);
    if (options.sort === 'name') return byName(a, b);
    return a.index - b.index;
  });
  return filtered.map(card => card.index);
}

export function loadPrintCreationIntent(storage, key) {
  try {
    const request = JSON.parse(storage.getItem(key));
    if (!request || !['full', 'changes', 'adhoc'].includes(request.mode)
      || !['scryfall', 'saved-mpc'].includes(request.artSource)
      || (request.mode !== 'adhoc' && (!Number.isSafeInteger(request.targetSnapshotId) || request.targetSnapshotId < 1))
      || (request.mode === 'changes' && (!Number.isSafeInteger(request.baselineSnapshotId) || request.baselineSnapshotId < 1))
      || (request.mode === 'adhoc' && (request.artSource !== 'scryfall'
        || typeof request.listName !== 'string' || request.listName.length > 120
        || typeof request.cardText !== 'string' || !request.cardText.trim() || request.cardText.length > 100000))
      || !validSelectionOptions(request)
      || typeof request.queueOnReady !== 'boolean' || typeof request.includeSideboard !== 'boolean' || typeof request.replacePrintings !== 'boolean'
      || !/^[a-f0-9]{64}$/.test(request.expectedPlanHash || '') || !/^[a-f0-9]{48}$/.test(request.idempotencyKey || '')) return null;
    // Old requests predate basic-land filtering. A retry must retain that old
    // behavior rather than adopt the newly checked default.
    return { ...request, excludeBasicLands: request.excludeBasicLands ?? false };
  } catch { return null; }
}

function validSelectionOptions(value) {
  return (value.excludeBasicLands === undefined || typeof value.excludeBasicLands === 'boolean')
    && (value.additionalCardText === undefined || (typeof value.additionalCardText === 'string' && value.additionalCardText.length <= 100000))
    && (value.excludedCards === undefined || (Array.isArray(value.excludedCards) && value.excludedCards.length <= 1000
      && value.excludedCards.every(key => typeof key === 'string' && key.length > 0 && key.length <= 1000)));
}

/** Browser drafts are convenience copies; a saved creation intent takes priority. */
export function loadStandalonePrintDraft(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key));
    if (!value || typeof value.listName !== 'string' || value.listName.length > 120
      || typeof value.cardText !== 'string' || value.cardText.length > 100000
      || typeof value.includeSideboard !== 'boolean' || !validSelectionOptions(value)) return null;
    const removedCards = Array.isArray(value.removedCards) ? value.removedCards.filter(card => card
      && typeof card.key === 'string' && typeof card.name === 'string' && Number.isSafeInteger(card.quantity) && card.quantity > 0) : [];
    return { listName: value.listName, cardText: value.cardText, includeSideboard: value.includeSideboard,
      excludeBasicLands: value.excludeBasicLands ?? true, additionalCardText: value.additionalCardText ?? '',
      excludedCards: value.excludedCards ?? [], removedCards };
  } catch { return null; }
}

export function rejectedPrintCreation(error) {
  // Authentication can reject a retry before the server can return its already
  // accepted receipt. Keep that key through session or permission recovery.
  return error.status >= 400 && error.status < 500 && ![401, 403, 408, 429].includes(error.status);
}
