/**
 * Shared analytics utilities for deck analysis.
 * Extracted from DeckListView.jsx for reuse across components.
 */

/** Parse a mana cost string like "{2}{U}{B}" into CMC (number). */
export function parseCMC(manaCost) {
  if (!manaCost) return 0;
  let cmc = 0;
  const symbols = manaCost.match(/\{([^}]+)\}/g) || [];
  for (const sym of symbols) {
    const inner = sym.slice(1, -1); // strip { }
    if (inner === 'X' || inner === 'Y' || inner === 'Z') continue;
    const num = parseInt(inner, 10);
    if (!isNaN(num)) {
      cmc += num;
    } else {
      // Each colored/hybrid symbol counts as 1
      cmc += 1;
    }
  }
  return cmc;
}

/** Extract color symbols from a mana cost string. */
export function extractColors(manaCost) {
  if (!manaCost) return [];
  const colors = new Set();
  const symbols = manaCost.match(/\{([^}]+)\}/g) || [];
  for (const sym of symbols) {
    const inner = sym.slice(1, -1);
    if (inner.includes('W')) colors.add('W');
    if (inner.includes('U')) colors.add('U');
    if (inner.includes('B')) colors.add('B');
    if (inner.includes('R')) colors.add('R');
    if (inner.includes('G')) colors.add('G');
  }
  return [...colors];
}

export const COLOR_LABELS = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };
export const COLOR_CSS = { W: '#f9faf4', U: '#0e68ab', B: '#150b00', R: '#d3202a', G: '#00733e', C: '#ccc2c0' };
