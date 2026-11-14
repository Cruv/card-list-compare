const printError = (message, status = 400) => Object.assign(new Error(message), { status });

export const PRINT_PAPER_RECIPES = Object.freeze({ letter: 'household-letter-v6', a4: 'household-a4-v5' });
export const CROWNED_PRESET = 'crowned-a4';
export const CROWNED_LANDSCAPE_PRESET = 'crowned-a4-landscape';
export const PRINT_PRESETS = Object.freeze({
  [CROWNED_PRESET]: Object.freeze({ recipeId: 'household-crowned-a4-v2', cardsPerSheet: 9, label: 'Crowned A4 · Portrait 3×3' }),
  [CROWNED_LANDSCAPE_PRESET]: Object.freeze({ recipeId: 'household-crowned-a4-landscape-v1', cardsPerSheet: 8, label: 'Crowned A4 · Landscape 2×4' }),
});
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
  if (typeof printPreset !== 'string' || !Object.hasOwn(PRINT_PRESETS, printPreset) || paperSize !== 'a4') {
    throw printError('Select a supported Crowned preset with A4 paper');
  }
  return { paperSize, printPreset, recipeId: PRINT_PRESETS[printPreset].recipeId };
}

export function printJobPaper(plan, manifest) {
  const selection = printPaperSelection(plan.paperSize, plan.printPreset);
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
  const available = [...Object.values(PRINT_PAPER_RECIPES), ...Object.values(PRINT_PRESETS).map(preset => preset.recipeId)];
  if (!Array.isArray(supportedRecipeIds) || !supportedRecipeIds.length
    || supportedRecipeIds.length > available.length || new Set(supportedRecipeIds).size !== supportedRecipeIds.length
    || supportedRecipeIds.some(recipe => !available.includes(recipe))
    || !supportedRecipeIds.includes(recipeId)) {
    throw printError('Invalid station paper recipes');
  }
  return { loadedPaperSize, ...(loadedPrintPreset ? { loadedPrintPreset } : {}), supportedRecipeIds };
}

export function stationCanPrintPaper(station, { paperSize, printPreset, recipeId }) {
  return station.loadedPaperSize === paperSize && station.loadedPrintPreset === printPreset
    && station.supportedRecipeIds.includes(recipeId);
}
