import { describe, it, expect } from 'vitest';
import { parseQtyEdit } from './collectionQty.js';

describe('parseQtyEdit (audit H2)', () => {
  it('ignores an empty or whitespace field (does not delete)', () => {
    expect(parseQtyEdit('', 4)).toBe(null);
    expect(parseQtyEdit('   ', 4)).toBe(null);
  });

  it('ignores non-numeric input', () => {
    expect(parseQtyEdit('abc', 4)).toBe(null);
  });

  it('ignores zero and negatives (removal is a separate explicit action)', () => {
    expect(parseQtyEdit('0', 4)).toBe(null);
    expect(parseQtyEdit('-3', 4)).toBe(null);
  });

  it('returns null when unchanged', () => {
    expect(parseQtyEdit('4', 4)).toBe(null);
  });

  it('commits a valid new quantity', () => {
    expect(parseQtyEdit('12', 4)).toBe(12);
    expect(parseQtyEdit('1', 4)).toBe(1);
  });

  it('clamps a genuinely new value to 999', () => {
    expect(parseQtyEdit('100000', 4)).toBe(999);
  });

  it('does not truncate an existing above-clamp quantity on a no-op blur', () => {
    // A bulk import can legitimately hold >999; blurring the field unchanged
    // must not silently rewrite 1200 down to 999.
    expect(parseQtyEdit('1200', 1200)).toBe(null);
  });

  it('parses leading-int values the way <input type=number> yields them', () => {
    expect(parseQtyEdit('7', 2)).toBe(7);
  });
});
