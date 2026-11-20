export const CROWNED_A4_PRESET = 'crowned-a4';
export const CROWNED_A4_PORTRAIT_SIX_PRESET = 'crowned-a4-portrait-six';
export const CROWNED_A4_LANDSCAPE_PRESET = 'crowned-a4-landscape';
export const CROWNED_A4_LANDSCAPE_V1_RECIPE = 'household-crowned-a4-landscape-v1';
export const DAHLE_A4_PRESET = 'dahle-a4-punch';

const A4_PORTRAIT_PRESETS = [CROWNED_A4_PRESET, CROWNED_A4_PORTRAIT_SIX_PRESET, DAHLE_A4_PRESET];

export const PRINT_PAPER = Object.freeze({
  letter: { label: 'US Letter', paperSize: 'letter', recipeId: 'household-letter-v6', template: 'Letter v6', cardsPerSheet: 7 },
  a4: { label: 'A4', optionLabel: 'A4 · Landscape', paperSize: 'a4', recipeId: 'household-a4-v5', template: 'A4 v5', cardsPerSheet: 7 },
  [CROWNED_A4_PRESET]: { label: 'Crowned A4 · Portrait 3×3', paperSize: 'a4', recipeId: 'household-crowned-a4-v2',
    template: 'A4 portrait 3×3 v2', templateVersion: 'v2', cardsPerSheet: 9 },
  [CROWNED_A4_PORTRAIT_SIX_PRESET]: { label: 'Crowned A4 · Portrait 3×2', paperSize: 'a4', recipeId: 'household-crowned-a4-portrait-six-v1',
    template: 'A4 portrait 3×2 v1', templateVersion: 'v1', cardsPerSheet: 6 },
  [CROWNED_A4_LANDSCAPE_PRESET]: { label: 'Crowned A4 · Landscape 2×4', paperSize: 'a4', recipeId: 'household-crowned-a4-landscape-v2',
    template: 'Centered A4 v5', templateVersion: 'v5', cardsPerSheet: 8 },
  [DAHLE_A4_PRESET]: { label: 'A4 3×3 · Dahle 550 + 63×88 R3 Punch', paperSize: 'a4', recipeId: 'household-dahle-a4-punch-v1',
    template: 'Dahle 550 strip cuts', cardsPerSheet: 9 },
});

export const isPrintPaperSize = value => value === 'letter' || value === 'a4';
export const isCrownedPrintPreset = value => value === CROWNED_A4_PRESET
  || value === CROWNED_A4_PORTRAIT_SIX_PRESET || value === CROWNED_A4_LANDSCAPE_PRESET;
export const isA4PrintPreset = value => isCrownedPrintPreset(value) || value === DAHLE_A4_PRESET;

export function availablePrintPaperChoices(capabilities) {
  return ['letter', ...A4_PORTRAIT_PRESETS.filter(preset => capabilities.printPresets?.includes(preset))];
}

export function newPrintPaperChoice(choice) {
  if (choice === 'a4' || choice === CROWNED_A4_LANDSCAPE_PRESET) return CROWNED_A4_PORTRAIT_SIX_PRESET;
  return A4_PORTRAIT_PRESETS.includes(choice) ? choice : 'letter';
}

export function selectAvailablePrintPaper(choice, available) {
  if (available.includes(choice)) return choice;
  return available.find(item => item !== 'letter') ?? 'letter';
}

export function printPaperChoice(batch) {
  const preset = batch?.printPreset;
  if (batch?.paperSize === undefined || batch.paperSize === 'a4') {
    if (isA4PrintPreset(preset)) return preset;
    if ([CROWNED_A4_LANDSCAPE_V1_RECIPE, PRINT_PAPER[CROWNED_A4_LANDSCAPE_PRESET].recipeId].includes(batch?.recipeId)) return CROWNED_A4_LANDSCAPE_PRESET;
    if (batch?.recipeId === PRINT_PAPER[CROWNED_A4_PRESET].recipeId) return CROWNED_A4_PRESET;
    if (batch?.recipeId === PRINT_PAPER[CROWNED_A4_PORTRAIT_SIX_PRESET].recipeId) return CROWNED_A4_PORTRAIT_SIX_PRESET;
    if (batch?.recipeId === PRINT_PAPER[DAHLE_A4_PRESET].recipeId) return DAHLE_A4_PRESET;
  }
  return batch?.paperSize === 'a4' || batch?.recipeId === PRINT_PAPER.a4.recipeId ? 'a4' : 'letter';
}

export function validDahleGuideOptions(request) {
  const { dahleAlignmentMarks, dahleCutGuides } = request;
  return [dahleAlignmentMarks, dahleCutGuides].every(value => value === undefined || typeof value === 'boolean')
    && !(dahleAlignmentMarks && dahleCutGuides)
    && (!(dahleAlignmentMarks || dahleCutGuides) || (request.paperSize === 'a4' && request.printPreset === DAHLE_A4_PRESET));
}

export function dahleGuideFields({ dahleAlignmentMarks, dahleCutGuides }) {
  return {
    ...(dahleAlignmentMarks === true ? { dahleAlignmentMarks: true } : {}),
    ...(dahleCutGuides === true ? { dahleCutGuides: true } : {}),
  };
}

export function printPaperRequest(choice, guides = {}) {
  return { paperSize: PRINT_PAPER[choice].paperSize,
    ...(isA4PrintPreset(choice) ? { printPreset: choice } : {}),
    ...(choice === DAHLE_A4_PRESET ? dahleGuideFields(guides) : {}) };
}

export const printPaperLabel = batch => batch?.recipeId === CROWNED_A4_LANDSCAPE_V1_RECIPE
  ? 'Crowned A4 · Landscape 2×4 (shifted)' : PRINT_PAPER[printPaperChoice(batch)].label;

export function printMarksLabel(batch) {
  if (printPaperChoice(batch) === DAHLE_A4_PRESET) {
    if (batch.dahleCutGuides) return 'Dahle strip cut lines and R3 corner guides';
    return batch.dahleAlignmentMarks ? 'Dahle row ticks and strip index marks' : 'Dahle row ticks';
  }
  return batch.registrationMarks === false ? 'No registration marks' : 'Cameo registration marks';
}

export const refeedSameShortEdge = batch => batch?.recipeId === CROWNED_A4_LANDSCAPE_V1_RECIPE
  || printPaperChoice(batch) === CROWNED_A4_PORTRAIT_SIX_PRESET;

export const stationPaperChoice = station => printPaperChoice({
  paperSize: station?.loadedPaperSize ?? 'letter', printPreset: station?.loadedPrintPreset,
});

export function loadDefaultPrintPaper(storage, key) {
  try {
    return newPrintPaperChoice(storage.getItem(key));
  } catch { return 'letter'; }
}

/** Keep Letter-only station compatibility, including queueing while the Mac is offline. */
export function printPaperUnavailable(batch, station) {
  const choice = printPaperChoice(batch);
  if (choice === DAHLE_A4_PRESET) return 'Print this layout from the downloaded PDF.';
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
