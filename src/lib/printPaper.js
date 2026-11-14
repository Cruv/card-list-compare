export const CROWNED_A4_PRESET = 'crowned-a4';

export const PRINT_PAPER = Object.freeze({
  letter: { label: 'US Letter', paperSize: 'letter', recipeId: 'household-letter-v6', template: 'Letter v6', cardsPerSheet: 7 },
  a4: { label: 'A4', paperSize: 'a4', recipeId: 'household-a4-v5', template: 'A4 v5', cardsPerSheet: 7 },
  [CROWNED_A4_PRESET]: { label: 'Crowned A4', paperSize: 'a4', recipeId: 'household-crowned-a4-v2',
    template: 'A4 portrait 3×3 v2', cardsPerSheet: 9 },
});

export const isPrintPaperSize = value => value === 'letter' || value === 'a4';

export function printPaperChoice(batch) {
  if (batch?.printPreset === CROWNED_A4_PRESET || batch?.recipeId === PRINT_PAPER[CROWNED_A4_PRESET].recipeId) return CROWNED_A4_PRESET;
  return batch?.paperSize === 'a4' || batch?.recipeId === PRINT_PAPER.a4.recipeId ? 'a4' : 'letter';
}

export function printPaperRequest(choice) {
  return { paperSize: PRINT_PAPER[choice].paperSize,
    ...(choice === CROWNED_A4_PRESET ? { printPreset: choice } : {}) };
}

export const printPaperLabel = batch => PRINT_PAPER[printPaperChoice(batch)].label;

export const stationPaperChoice = station => printPaperChoice({
  paperSize: station?.loadedPaperSize, printPreset: station?.loadedPrintPreset,
});

export function loadDefaultPrintPaper(storage, key) {
  try {
    const choice = storage.getItem(key);
    return isPrintPaperSize(choice) || choice === CROWNED_A4_PRESET ? choice : 'letter';
  } catch { return 'letter'; }
}

/** Keep Letter-only station compatibility, including queueing while the Mac is offline. */
export function printPaperUnavailable(batch, station) {
  const choice = printPaperChoice(batch);
  const { label, recipeId } = PRINT_PAPER[choice];
  const loaded = stationPaperChoice(station);
  if (choice !== 'letter' && !station?.online) return `The Mac must be online to check ${label} printing.`;
  if (choice !== 'letter' && !station.supportedRecipeIds?.includes(recipeId)) {
    return `Update and configure the Mac companion to print ${label}.`;
  }
  if (choice !== loaded) return `The Mac is set up for ${PRINT_PAPER[loaded].label}. This batch uses ${label}.`;
  return '';
}
