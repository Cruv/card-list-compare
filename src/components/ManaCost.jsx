import { memo } from 'react';
import './ManaCost.css';

/**
 * Mana symbol color mapping for CSS classes.
 * Scryfall format: {W}, {U}, {B}, {R}, {G}, {C}, {1}, {2}, etc.
 * Hybrid: {W/U}, {2/W}, etc.
 * Phyrexian: {W/P}, {U/P}, etc.
 * Generic: {0}, {1}, {2}, ..., {X}, {Y}, {Z}
 */
const SYMBOL_CLASSES = {
  W: 'mana--w',
  U: 'mana--u',
  B: 'mana--b',
  R: 'mana--r',
  G: 'mana--g',
  C: 'mana--c',
  S: 'mana--c', // Snow
  X: 'mana--x',
  Y: 'mana--x',
  Z: 'mana--x',
};

function getSymbolClass(symbol) {
  // Generic numbers
  if (/^\d+$/.test(symbol)) return 'mana--generic';
  // Hybrid mana (e.g. "W/U", "2/W")
  if (symbol.includes('/')) return 'mana--hybrid';
  return SYMBOL_CLASSES[symbol] || 'mana--generic';
}

function getSymbolLabel(symbol) {
  // Clean display for common symbols
  if (symbol.includes('/')) {
    return symbol.replace('/', '');
  }
  return symbol;
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

export default memo(function ManaCost({ cost }) {
  if (!cost) return null;

  const symbols = parseManaCost(cost);
  if (symbols.length === 0) return null;

  return (
    <span className="mana-cost" aria-label={`Mana cost: ${cost}`}>
      {symbols.map((sym, i) => (
        <span
          key={i}
          className={`mana-symbol ${getSymbolClass(sym)}`}
          title={`{${sym}}`}
        >
          {getSymbolLabel(sym)}
        </span>
      ))}
    </span>
  );
});
