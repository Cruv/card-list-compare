const printError = (message, status = 400) => Object.assign(new Error(message), { status });

export const PRINT_PAPER_RECIPES = Object.freeze({ letter: 'household-letter-v6', a4: 'household-a4-v5' });
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

export function printJobPaper(plan, manifest) {
  const paperSize = plan.paperSize ?? 'letter';
  const recipeId = PRINT_PAPER_RECIPES[validatePaperSize(paperSize)];
  if (manifest && ((manifest.recipe?.id ?? PRINT_PAPER_RECIPES.letter) !== recipeId
    || (manifest.recipe?.paperSize ?? 'letter') !== paperSize)) {
    throw printError('The saved print recipe does not match the batch paper size', 409);
  }
  return { paperSize, recipeId };
}

export function stationPaperInput(body = {}) {
  const { loadedPaperSize = 'letter', supportedRecipeIds = LEGACY_STATION_PAPER.supportedRecipeIds } = body;
  validatePaperSize(loadedPaperSize);
  const available = Object.values(PRINT_PAPER_RECIPES);
  if (!Array.isArray(supportedRecipeIds) || !supportedRecipeIds.length
    || supportedRecipeIds.length > available.length || new Set(supportedRecipeIds).size !== supportedRecipeIds.length
    || supportedRecipeIds.some(recipe => !available.includes(recipe))
    || !supportedRecipeIds.includes(PRINT_PAPER_RECIPES[loadedPaperSize])) {
    throw printError('Invalid station paper recipes');
  }
  return { loadedPaperSize, supportedRecipeIds };
}

export function stationCanPrintPaper(station, { paperSize, recipeId }) {
  return station.loadedPaperSize === paperSize && station.supportedRecipeIds.includes(recipeId);
}
