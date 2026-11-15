export const CROWNED_A4_PRESET = 'crowned-a4';
export const CROWNED_A4_PORTRAIT_SIX_PRESET = 'crowned-a4-portrait-six';
export const CROWNED_A4_LANDSCAPE_PRESET = 'crowned-a4-landscape';
export const CROWNED_A4_LANDSCAPE_V1_RECIPE = 'household-crowned-a4-landscape-v1';

export const PRINT_PAPER = Object.freeze({
  letter: { label: 'US Letter', paperSize: 'letter', recipeId: 'household-letter-v6', template: 'Letter v6', cardsPerSheet: 7 },
  a4: { label: 'A4', optionLabel: 'A4 · Landscape', paperSize: 'a4', recipeId: 'household-a4-v5', template: 'A4 v5', cardsPerSheet: 7 },
  [CROWNED_A4_PRESET]: { label: 'Crowned A4 · Portrait 3×3', paperSize: 'a4', recipeId: 'household-crowned-a4-v2',
    template: 'A4 portrait 3×3 v2', templateVersion: 'v2', cardsPerSheet: 9 },
  [CROWNED_A4_PORTRAIT_SIX_PRESET]: { label: 'Crowned A4 · Portrait 3×2', paperSize: 'a4', recipeId: 'household-crowned-a4-portrait-six-v1',
    template: 'A4 portrait 3×2 v1', templateVersion: 'v1', cardsPerSheet: 6 },
  [CROWNED_A4_LANDSCAPE_PRESET]: { label: 'Crowned A4 · Landscape 2×4', paperSize: 'a4', recipeId: 'household-crowned-a4-landscape-v2',
    template: 'Centered A4 v5', templateVersion: 'v5', cardsPerSheet: 8 },
});

export const isPrintPaperSize = value => value === 'letter' || value === 'a4';
export const isCrownedPrintPreset = value => value === CROWNED_A4_PRESET
  || value === CROWNED_A4_PORTRAIT_SIX_PRESET || value === CROWNED_A4_LANDSCAPE_PRESET;

export function printPaperChoice(batch) {
  const preset = batch?.printPreset;
  if (batch?.paperSize === undefined || batch.paperSize === 'a4') {
    if (isCrownedPrintPreset(preset)) return preset;
    if ([CROWNED_A4_LANDSCAPE_V1_RECIPE, PRINT_PAPER[CROWNED_A4_LANDSCAPE_PRESET].recipeId].includes(batch?.recipeId)) return CROWNED_A4_LANDSCAPE_PRESET;
    if (batch?.recipeId === PRINT_PAPER[CROWNED_A4_PRESET].recipeId) return CROWNED_A4_PRESET;
    if (batch?.recipeId === PRINT_PAPER[CROWNED_A4_PORTRAIT_SIX_PRESET].recipeId) return CROWNED_A4_PORTRAIT_SIX_PRESET;
  }
  return batch?.paperSize === 'a4' || batch?.recipeId === PRINT_PAPER.a4.recipeId ? 'a4' : 'letter';
}

export function printPaperRequest(choice) {
  return { paperSize: PRINT_PAPER[choice].paperSize,
    ...(isCrownedPrintPreset(choice) ? { printPreset: choice } : {}) };
}

export const printPaperLabel = batch => batch?.recipeId === CROWNED_A4_LANDSCAPE_V1_RECIPE
  ? 'Crowned A4 · Landscape 2×4 (shifted)' : PRINT_PAPER[printPaperChoice(batch)].label;

export const refeedSameShortEdge = batch => batch?.recipeId === CROWNED_A4_LANDSCAPE_V1_RECIPE
  || printPaperChoice(batch) === CROWNED_A4_PORTRAIT_SIX_PRESET;

export const stationPaperChoice = station => printPaperChoice({
  paperSize: station?.loadedPaperSize ?? 'letter', printPreset: station?.loadedPrintPreset,
});

export function loadDefaultPrintPaper(storage, key) {
  try {
    const choice = storage.getItem(key);
    return isPrintPaperSize(choice) || isCrownedPrintPreset(choice) ? choice : 'letter';
  } catch { return 'letter'; }
}

/** Keep Letter-only station compatibility, including queueing while the Mac is offline. */
export function printPaperUnavailable(batch, station) {
  const choice = printPaperChoice(batch);
  const label = printPaperLabel(batch);
  const recipeId = batch?.recipeId === CROWNED_A4_LANDSCAPE_V1_RECIPE ? batch.recipeId : PRINT_PAPER[choice].recipeId;
  const loaded = stationPaperChoice(station);
  if (choice !== 'letter' && !station?.online) return `The Mac must be online to check ${label} printing.`;
  if (choice !== 'letter' && !station.supportedRecipeIds?.includes(recipeId)) {
    return `Update and configure the Mac companion to print ${label}.`;
  }
  if (choice !== loaded) return `The Mac is set up for ${PRINT_PAPER[loaded].label}. This batch uses ${label}.`;
  return '';
}
