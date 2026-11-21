const printError = (message, status = 400) => Object.assign(new Error(message), { status });

export const PRINT_PAPER_RECIPES = Object.freeze({ letter: 'household-letter-v6', a4: 'household-a4-v5' });
export const CROWNED_PRESET = 'crowned-a4';
export const CROWNED_PORTRAIT_SIX_PRESET = 'crowned-a4-portrait-six';
export const CROWNED_LANDSCAPE_PRESET = 'crowned-a4-landscape';
export const CROWNED_LANDSCAPE_V1_RECIPE = 'household-crowned-a4-landscape-v1';
export const DAHLE_A4_PRESET = 'dahle-a4-punch';
export const DAHLE_LETTER_PRESET = 'dahle-letter-punch';
export const isDahlePrintPreset = value => value === DAHLE_A4_PRESET || value === DAHLE_LETTER_PRESET;
export const FOIL_PROFILES = Object.freeze(['rainbow-v1', 'surge-v1']);
export const PRINT_PRESETS = Object.freeze({
  [CROWNED_PRESET]: Object.freeze({ paperSize: 'a4', recipeId: 'household-crowned-a4-v2', cardsPerSheet: 9, label: 'Crowned A4 · Portrait 3×3' }),
  [CROWNED_PORTRAIT_SIX_PRESET]: Object.freeze({ paperSize: 'a4', recipeId: 'household-crowned-a4-portrait-six-v1', cardsPerSheet: 6, label: 'Crowned A4 · Portrait 3×2' }),
  [CROWNED_LANDSCAPE_PRESET]: Object.freeze({ paperSize: 'a4', recipeId: 'household-crowned-a4-landscape-v2', cardsPerSheet: 8, label: 'Crowned A4 · Landscape 2×4' }),
  [DAHLE_A4_PRESET]: Object.freeze({ paperSize: 'a4', recipeId: 'household-dahle-a4-punch-v1', cardsPerSheet: 9, label: 'A4 3×3 · Dahle 550 + 63×88 R3 Punch' }),
  [DAHLE_LETTER_PRESET]: Object.freeze({ paperSize: 'letter', recipeId: 'household-dahle-letter-punch-v1', cardsPerSheet: 9, label: 'US Letter 3×3 · Dahle 550 + 63×88 R3 Punch' }),
});
export const NEW_PRINT_PAPER_SIZES = Object.freeze(['letter']);
export const NEW_PRINT_PRESETS = Object.freeze([CROWNED_PRESET, CROWNED_PORTRAIT_SIX_PRESET, DAHLE_A4_PRESET, DAHLE_LETTER_PRESET]);
export const LEGACY_STATION_PAPER = Object.freeze({
  loadedPaperSize: 'letter',
  supportedRecipeIds: Object.freeze([PRINT_PAPER_RECIPES.letter]),
});

export function validatePaperSize(size) {
  if (typeof size !== 'string' || !Object.hasOwn(PRINT_PAPER_RECIPES, size)) {
    throw printError('Paper size must be US Letter or A4');
  }
  return size;
}

export function printPaperSelection(paperSize = 'letter', printPreset) {
  validatePaperSize(paperSize);
  if (printPreset === undefined) return { paperSize, recipeId: PRINT_PAPER_RECIPES[paperSize] };
  if (typeof printPreset !== 'string' || !Object.hasOwn(PRINT_PRESETS, printPreset) || PRINT_PRESETS[printPreset].paperSize !== paperSize) {
    throw printError('Select a supported preset for this paper size');
  }
  return { paperSize, printPreset, recipeId: PRINT_PRESETS[printPreset].recipeId };
}

export function newPrintPaperSelection(paperSize, printPreset) {
  const selection = printPaperSelection(paperSize, printPreset);
  const allowed = selection.printPreset ? NEW_PRINT_PRESETS.includes(selection.printPreset)
    : NEW_PRINT_PAPER_SIZES.includes(selection.paperSize);
  if (!allowed) throw printError('This A4 layout has been retired. Choose an A4 portrait layout and review the print list again.');
  return selection;
}

// Alignment marks preserve the saved strip indexing strokes. Cut guides add
// horizontal strip cut lines and R3 corner guides together.
export function dahleGuideOptions(printPreset, { dahleAlignmentMarks = false, dahleCutGuides = false } = {}) {
  if (typeof dahleAlignmentMarks !== 'boolean') throw printError('dahleAlignmentMarks must be true or false');
  if (typeof dahleCutGuides !== 'boolean') throw printError('dahleCutGuides must be true or false');
  if ((dahleAlignmentMarks || dahleCutGuides) && !isDahlePrintPreset(printPreset)) throw printError('Die-cutter guides require a Dahle layout');
  if (dahleAlignmentMarks && dahleCutGuides) throw printError('Choose one Dahle guide style');
  return { ...(dahleAlignmentMarks ? { dahleAlignmentMarks } : {}), ...(dahleCutGuides ? { dahleCutGuides } : {}) };
}

export function foilProfileOptions(printPreset, { foilProfile } = {}) {
  if (foilProfile === undefined) return {};
  if (!FOIL_PROFILES.includes(foilProfile)) throw printError('Choose a supported foil color profile');
  if (!isDahlePrintPreset(printPreset)) throw printError('Foil color profiles require a Dahle layout');
  return { foilProfile };
}

export function printJobPaper(plan, manifest) {
  const selection = printPaperSelection(plan.paperSize, plan.printPreset);
  if (selection.printPreset === CROWNED_LANDSCAPE_PRESET && manifest?.recipe?.id === CROWNED_LANDSCAPE_V1_RECIPE) {
    selection.recipeId = CROWNED_LANDSCAPE_V1_RECIPE;
  }
  if (manifest && ((manifest.recipe?.id ?? PRINT_PAPER_RECIPES.letter) !== selection.recipeId
    || (manifest.recipe?.paperSize ?? 'letter') !== selection.paperSize
    || manifest.recipe?.printPreset !== selection.printPreset)) {
    throw printError('The saved print recipe does not match the batch paper and preset', 409);
  }
  return selection;
}

export function stationPaperInput(body = {}) {
  const { loadedPaperSize = 'letter', loadedPrintPreset, supportedRecipeIds = LEGACY_STATION_PAPER.supportedRecipeIds } = body;
  const { recipeId } = printPaperSelection(loadedPaperSize, loadedPrintPreset);
  const available = [...Object.values(PRINT_PAPER_RECIPES), ...Object.entries(PRINT_PRESETS)
    .filter(([preset]) => !isDahlePrintPreset(preset)).map(([, preset]) => preset.recipeId), CROWNED_LANDSCAPE_V1_RECIPE];
  if (!Array.isArray(supportedRecipeIds) || !supportedRecipeIds.length
    || supportedRecipeIds.length > available.length || new Set(supportedRecipeIds).size !== supportedRecipeIds.length
    || supportedRecipeIds.some(recipe => !available.includes(recipe))
    || !(supportedRecipeIds.includes(recipeId)
      || (loadedPrintPreset === CROWNED_LANDSCAPE_PRESET && supportedRecipeIds.includes(CROWNED_LANDSCAPE_V1_RECIPE)))) {
    throw printError('Invalid station paper recipes');
  }
  return { loadedPaperSize, ...(loadedPrintPreset ? { loadedPrintPreset } : {}), supportedRecipeIds };
}

export function stationCanPrintPaper(station, { paperSize, printPreset, recipeId }) {
  return station.loadedPaperSize === paperSize && station.loadedPrintPreset === printPreset
    && station.supportedRecipeIds.includes(recipeId);
}
