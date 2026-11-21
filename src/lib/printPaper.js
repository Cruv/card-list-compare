import dahleA4PunchGeometry from '../../server/lib/dahleA4PunchGeometry.json' with { type: 'json' };

export const CROWNED_A4_PRESET = 'crowned-a4';
export const CROWNED_A4_PORTRAIT_SIX_PRESET = 'crowned-a4-portrait-six';
export const CROWNED_A4_LANDSCAPE_PRESET = 'crowned-a4-landscape';
export const CROWNED_A4_LANDSCAPE_V1_RECIPE = 'household-crowned-a4-landscape-v1';
export const DAHLE_A4_PRESET = 'dahle-a4-punch';
export const DAHLE_LETTER_PRESET = 'dahle-letter-punch';
export const isDahlePrintPreset = value => value === DAHLE_A4_PRESET || value === DAHLE_LETTER_PRESET;

export const PRINT_FOIL_PROFILES = Object.freeze({
  'rainbow-v1': 'Rainbow foil',
  'surge-v1': 'Surge foil',
});
export const isFoilProfile = value => typeof value === 'string' && Object.hasOwn(PRINT_FOIL_PROFILES, value);
export const foilProfileLabel = value => isFoilProfile(value) ? PRINT_FOIL_PROFILES[value] : undefined;
export const availablePrintFoilProfiles = capabilities => Object.keys(PRINT_FOIL_PROFILES)
  .filter(profile => Array.isArray(capabilities?.foilProfiles) && capabilities.foilProfiles.includes(profile));

const { bleed, page, letterPage, rows, trim } = dahleA4PunchGeometry;
const dahleStripWidth = trim[1] + 2 * bleed;
const dahleLayout = ([width, height]) => Object.freeze({
  bleedMm: bleed,
  stripLengthMm: width,
  stripWidthMm: dahleStripWidth,
  stripSize: `${width} × ${dahleStripWidth} mm`,
  topMarginMm: Number(((height - rows * dahleStripWidth) / 2).toFixed(2)),
});
export const DAHLE_A4_LAYOUT = dahleLayout(page);
export const DAHLE_LETTER_LAYOUT = dahleLayout(letterPage);

const NEW_PRINT_PRESETS = [CROWNED_A4_PRESET, CROWNED_A4_PORTRAIT_SIX_PRESET, DAHLE_A4_PRESET, DAHLE_LETTER_PRESET];

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
    template: 'Dahle 550 strip cuts', cardsPerSheet: 9, punchLayout: DAHLE_A4_LAYOUT },
  [DAHLE_LETTER_PRESET]: { label: 'US Letter 3×3 · Dahle 550 + 63×88 R3 Punch', paperSize: 'letter', recipeId: 'household-dahle-letter-punch-v1',
    template: 'Dahle 550 strip cuts', cardsPerSheet: 9, punchLayout: DAHLE_LETTER_LAYOUT },
});

export const isPrintPaperSize = value => value === 'letter' || value === 'a4';
export const isCrownedPrintPreset = value => value === CROWNED_A4_PRESET
  || value === CROWNED_A4_PORTRAIT_SIX_PRESET || value === CROWNED_A4_LANDSCAPE_PRESET;
const isPrintPreset = value => isCrownedPrintPreset(value) || isDahlePrintPreset(value);
export const matchesPrintPreset = (preset, paperSize) => isPrintPreset(preset) && PRINT_PAPER[preset].paperSize === paperSize;

export function availablePrintPaperChoices(capabilities) {
  return ['letter', ...NEW_PRINT_PRESETS.filter(preset => capabilities.printPresets?.includes(preset))];
}

export function newPrintPaperChoice(choice) {
  if (choice === 'a4' || choice === CROWNED_A4_LANDSCAPE_PRESET) return CROWNED_A4_PORTRAIT_SIX_PRESET;
  return NEW_PRINT_PRESETS.includes(choice) ? choice : 'letter';
}

export function selectAvailablePrintPaper(choice, available) {
  if (available.includes(choice)) return choice;
  if (choice === DAHLE_LETTER_PRESET) return 'letter';
  return available.find(item => item !== 'letter') ?? 'letter';
}

export function printPaperChoice(batch) {
  const preset = batch?.printPreset;
  if (isPrintPreset(preset) && (batch.paperSize === undefined || matchesPrintPreset(preset, batch.paperSize))) return preset;
  if ((batch?.paperSize === undefined || batch.paperSize === 'letter')
    && batch?.recipeId === PRINT_PAPER[DAHLE_LETTER_PRESET].recipeId) return DAHLE_LETTER_PRESET;
  if (batch?.paperSize === undefined || batch.paperSize === 'a4') {
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
    && (!(dahleAlignmentMarks || dahleCutGuides) || (isDahlePrintPreset(request.printPreset) && matchesPrintPreset(request.printPreset, request.paperSize)));
}

export function dahleGuideFields({ dahleAlignmentMarks, dahleCutGuides }) {
  return {
    ...(dahleAlignmentMarks === true ? { dahleAlignmentMarks: true } : {}),
    ...(dahleCutGuides === true ? { dahleCutGuides: true } : {}),
  };
}

export function printPaperRequest(choice, guides = {}) {
  return { paperSize: PRINT_PAPER[choice].paperSize,
    ...(isPrintPreset(choice) ? { printPreset: choice } : {}),
    ...(isDahlePrintPreset(choice) ? dahleGuideFields(guides) : {}) };
}

export const printPaperLabel = batch => batch?.recipeId === CROWNED_A4_LANDSCAPE_V1_RECIPE
  ? 'Crowned A4 · Landscape 2×4 (shifted)' : PRINT_PAPER[printPaperChoice(batch)].label;

export function printMarksLabel(batch) {
  if (isDahlePrintPreset(printPaperChoice(batch))) {
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
  if (isDahlePrintPreset(choice)) return 'Print this layout from the downloaded PDF.';
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
