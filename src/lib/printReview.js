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

export function loadPrintCreationIntent(storage, key) {
  try {
    const request = JSON.parse(storage.getItem(key));
    if (!request || !['full', 'changes'].includes(request.mode)
      || !['scryfall', 'saved-mpc'].includes(request.artSource)
      || !Number.isSafeInteger(request.targetSnapshotId) || request.targetSnapshotId < 1
      || (request.mode === 'changes' && (!Number.isSafeInteger(request.baselineSnapshotId) || request.baselineSnapshotId < 1))
      || typeof request.queueOnReady !== 'boolean' || typeof request.includeSideboard !== 'boolean' || typeof request.replacePrintings !== 'boolean'
      || !/^[a-f0-9]{64}$/.test(request.expectedPlanHash || '') || !/^[a-f0-9]{48}$/.test(request.idempotencyKey || '')) return null;
    return request;
  } catch { return null; }
}

export function rejectedPrintCreation(error) {
  // Authentication can reject a retry before the server can return its already
  // accepted receipt. Keep that key through session or permission recovery.
  return error.status >= 400 && error.status < 500 && ![401, 403, 408, 429].includes(error.status);
}
