import { describe, it, expect } from 'vitest';
import { parseCMC, extractColors, COLOR_LABELS } from './analytics';

describe('parseCMC', () => {
  it('returns 0 for null/empty/undefined', () => {
    expect(parseCMC(null)).toBe(0);
    expect(parseCMC('')).toBe(0);
    expect(parseCMC(undefined)).toBe(0);
  });

  it('parses generic mana', () => {
    expect(parseCMC('{3}')).toBe(3);
    expect(parseCMC('{0}')).toBe(0);
  });

  it('parses colored mana', () => {
    expect(parseCMC('{U}')).toBe(1);
    expect(parseCMC('{U}{B}')).toBe(2);
    expect(parseCMC('{W}{W}{W}')).toBe(3);
  });

  it('parses mixed generic + colored', () => {
    expect(parseCMC('{2}{U}{B}')).toBe(4);
    expect(parseCMC('{4}{R}{R}')).toBe(6);
    expect(parseCMC('{1}{G}')).toBe(2);
  });

  it('ignores X/Y/Z', () => {
    expect(parseCMC('{X}{R}')).toBe(1);
    expect(parseCMC('{X}{Y}{U}')).toBe(1);
    expect(parseCMC('{X}')).toBe(0);
  });

  it('handles hybrid mana as 1 each', () => {
    expect(parseCMC('{W/U}')).toBe(1);
    expect(parseCMC('{2}{W/U}{B}')).toBe(4);
  });

  it('handles phyrexian mana as 1 each', () => {
    expect(parseCMC('{W/P}')).toBe(1);
    expect(parseCMC('{U/P}{B/P}')).toBe(2);
  });
});

describe('extractColors', () => {
  it('returns empty for null/empty', () => {
    expect(extractColors(null)).toEqual([]);
    expect(extractColors('')).toEqual([]);
  });

  it('extracts single color', () => {
    expect(extractColors('{U}')).toEqual(['U']);
    expect(extractColors('{R}')).toEqual(['R']);
  });

  it('extracts multiple colors', () => {
    const colors = extractColors('{2}{U}{B}');
    expect(colors).toContain('U');
    expect(colors).toContain('B');
    expect(colors).toHaveLength(2);
  });

  it('deduplicates colors', () => {
    const colors = extractColors('{U}{U}{U}');
    expect(colors).toEqual(['U']);
  });

  it('extracts colors from hybrid mana', () => {
    const colors = extractColors('{W/U}');
    expect(colors).toContain('W');
    expect(colors).toContain('U');
  });

  it('returns empty for colorless-only costs', () => {
    expect(extractColors('{3}')).toEqual([]);
    expect(extractColors('{0}')).toEqual([]);
  });

  it('ignores generic in mixed costs', () => {
    const colors = extractColors('{4}{G}');
    expect(colors).toEqual(['G']);
  });
});

describe('COLOR_LABELS', () => {
  it('has all five colors plus colorless', () => {
    expect(Object.keys(COLOR_LABELS)).toEqual(['W', 'U', 'B', 'R', 'G', 'C']);
    expect(COLOR_LABELS.W).toBe('White');
    expect(COLOR_LABELS.U).toBe('Blue');
    expect(COLOR_LABELS.C).toBe('Colorless');
  });
});
