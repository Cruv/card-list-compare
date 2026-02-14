import { memo } from 'react';
import './ManaCost.css';

/**
 * Convert a mana symbol string (from Scryfall's {X} notation) to
 * the Scryfall SVG filename. Scryfall hosts official MTG mana symbols
 * at https://svgs.scryfall.io/card-symbols/{SYMBOL}.svg
 *
 * Examples:
 *   "W"   → "W.svg"
 *   "2"   → "2.svg"
 *   "W/U" → "WU.svg"   (hybrid — slash removed)
 *   "W/P" → "WP.svg"   (phyrexian — slash removed)
 *   "2/W" → "2W.svg"   (generic hybrid)
 */
function symbolToSvgUrl(symbol) {
  const filename = symbol.replace('/', '');
  return `https://svgs.scryfall.io/card-symbols/${filename}.svg`;
}

/**
 * Parse a mana cost string like "{2}{U}{B}" into an array of symbol strings.
 */
function parseManaCost(cost) {
  if (!cost) return [];
  const symbols = [];
  const regex = /\{([^}]+)\}/g;
  let match;
  while ((match = regex.exec(cost)) !== null) {
    symbols.push(match[1]);
  }
  return symbols;
}

/**
 * Prefetch common mana symbol SVGs so they're cached by the browser
 * before any changelog is opened. Uses <link rel="prefetch"> which
 * loads at idle priority — does not block rendering.
 */
const COMMON_SYMBOLS = ['W', 'U', 'B', 'R', 'G', 'C', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'X'];

export function preloadManaSymbols() {
  for (const sym of COMMON_SYMBOLS) {
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.as = 'image';
    link.href = symbolToSvgUrl(sym);
    document.head.appendChild(link);
  }
}

export default memo(function ManaCost({ cost }) {
  if (!cost) return null;

  const symbols = parseManaCost(cost);
  if (symbols.length === 0) return null;

  return (
    <span className="mana-cost" aria-label={`Mana cost: ${cost}`}>
      {symbols.map((sym, i) => (
        <img
          key={i}
          className="mana-symbol"
          src={symbolToSvgUrl(sym)}
          alt={`{${sym}}`}
          title={`{${sym}}`}
          width="16"
          height="16"
          loading="lazy"
        />
      ))}
    </span>
  );
});
