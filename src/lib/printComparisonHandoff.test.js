import { describe, expect, it } from 'vitest';
import { PRINT_COMPARISON_KEY, consumePrintComparison, loadPrintComparison, savePrintComparison } from './printComparisonHandoff';

const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};

describe('comparison to print review handoff', () => {
  it('preserves both exact lists through login without touching a saved print draft', () => {
    const db = storage(); db.setItem('clc-print-list-draft:42', 'existing draft');
    const value = savePrintComparison(db, { beforeText: '1 Sol Ring (CMM) 410', afterText: '2 Sol Ring (CMM) 410\n1 Lightning Bolt' });
    expect(loadPrintComparison(db, null)).toBeNull();
    expect(loadPrintComparison(db, 42)).toEqual(value);
    expect(value.comparison).toEqual({ beforeText: '1 Sol Ring (CMM) 410', mode: 'changes' });
    expect(db.getItem('clc-print-list-draft:42')).toBe('existing draft');
  });
  it('isolates signed-in requests from other users and consumes only the matching operation', () => {
    const db = storage();
    const first = savePrintComparison(db, { afterText: '1 Sol Ring' }, 42);
    expect(loadPrintComparison(db, 43)).toBeNull();
    const newer = savePrintComparison(db, { afterText: '1 Lightning Bolt', mode: 'full' }, 42);
    consumePrintComparison(db, first.id);
    expect(loadPrintComparison(db, 42)).toEqual(newer);
    consumePrintComparison(db, newer.id);
    expect(loadPrintComparison(db, 42)).toBeNull();
  });
  it('allows an empty baseline but rejects empty targets and oversized or corrupted input', () => {
    const db = storage();
    expect(savePrintComparison(db, { afterText: '1 Sol Ring' }).comparison.beforeText).toBe('');
    for (const input of [{ afterText: '' }, { afterText: ' '.repeat(5) }, { afterText: 'x'.repeat(100001) },
      { afterText: '1 Sol Ring', beforeText: 'x'.repeat(100001) }, { afterText: '1 Sol Ring', mode: 'oops' }]) {
      expect(() => savePrintComparison(db, input)).toThrow();
    }
    for (const raw of ['invalid', '{}', JSON.stringify({ id: 'x', cardText: '1 Sol Ring' })]) {
      db.setItem(PRINT_COMPARISON_KEY, raw);
      expect(loadPrintComparison(db, 42)).toBeNull();
    }
    expect(loadPrintComparison({ getItem() { throw new Error('denied'); } }, 42)).toBeNull();
    expect(() => savePrintComparison({ setItem() { throw new Error('full'); } }, { afterText: '1 Sol Ring' })).toThrow('full');
  });
});
