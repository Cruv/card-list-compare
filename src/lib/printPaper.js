export const PRINT_PAPER = Object.freeze({
  letter: { label: 'US Letter', recipeId: 'household-letter-v6', template: 'Letter v6' },
  a4: { label: 'A4', recipeId: 'household-a4-v5', template: 'A4 v5' },
});

export const isPrintPaperSize = value => typeof value === 'string' && Object.hasOwn(PRINT_PAPER, value);

export function printPaperSize(batch) {
  return batch?.paperSize === 'a4' || batch?.recipeId === PRINT_PAPER.a4.recipeId ? 'a4' : 'letter';
}

export const printPaperLabel = batch => PRINT_PAPER[printPaperSize(batch)].label;

export function loadDefaultPrintPaper(storage, key) {
  try {
    const size = storage.getItem(key);
    return isPrintPaperSize(size) ? size : 'letter';
  } catch { return 'letter'; }
}

/** Keep Letter-only station compatibility, including queueing while the Mac is offline. */
export function printPaperUnavailable(batch, station) {
  const size = printPaperSize(batch);
  const loaded = station?.loadedPaperSize ?? 'letter';
  if (size === 'a4' && !station?.online) return 'The Mac must be online to verify A4 printing is available.';
  if (size === 'a4' && !station.supportedRecipeIds?.includes(PRINT_PAPER.a4.recipeId)) {
    return 'Update and configure the Mac companion to print A4.';
  }
  if (size !== loaded) return `The Mac is set up for ${PRINT_PAPER[loaded]?.label || 'a different paper size'}. This batch uses ${PRINT_PAPER[size].label}.`;
  return '';
}
