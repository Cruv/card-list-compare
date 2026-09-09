import { describe, expect, it, vi } from 'vitest';
vi.mock('../db.js', () => ({ get: vi.fn() }));
import { planPhysicalCopies } from './printQueuePlan.js';

describe('physical print copy planning', () => {
  it('plans positive increases, never removed or already-present copies', () => {
    expect(planPhysicalCopies('5 Lightning Bolt\n1 Sol Ring', '2 Lightning Bolt\n1 Counterspell'))
      .toEqual([expect.objectContaining({ displayName: 'Lightning Bolt', quantity: 3 }), expect.objectContaining({ displayName: 'Sol Ring', quantity: 1 })]);
  });
  it('counts commanders once and excludes sideboard unless requested', () => {
    const text = 'Commander\n1 Atraxa, Praetors\nMainboard\n1 Sol Ring\nSideboard\n2 Counterspell';
    expect(planPhysicalCopies(text).reduce((sum, card) => sum + card.quantity, 0)).toBe(2);
    expect(planPhysicalCopies(text, '', { includeSideboard: true }).reduce((sum, card) => sum + card.quantity, 0)).toBe(4);
  });
  it('aggregates zones before comparing so moving a copy requires no reprint', () => {
    expect(planPhysicalCopies('Sideboard\n1 Sol Ring', 'Mainboard\n1 Sol Ring', { includeSideboard: true })).toEqual([]);
  });
  it('treats changed printing as a new copy only when requested', () => {
    const target = '1 Lightning Bolt (M10) [146]', before = '1 Lightning Bolt (LEA) [161]';
    expect(planPhysicalCopies(target, before)).toEqual([expect.objectContaining({ setCode: 'M10', collectorNumber: '146', quantity: 1 })]);
    expect(planPhysicalCopies(target, before, { replacePrintings: false })).toEqual([]);
  });
  it('keeps exact existing art before allocating interchangeable copies', () => {
    const target = '3 Lightning Bolt (M10) [146]\n1 Lightning Bolt (LEA) [161]';
    expect(planPhysicalCopies(target, '2 Lightning Bolt (LEA) [161]', { replacePrintings: false }))
      .toEqual([expect.objectContaining({ setCode: 'M10', quantity: 2 })]);
  });
  it('does not reprint finish changes, DFC aliases, or newly supplied metadata alone', () => {
    expect(planPhysicalCopies('1 Sol Ring (C21) [263] *F*', '1 Sol Ring (C21) [263]')).toEqual([]);
    expect(planPhysicalCopies('1 Malakir Rebirth // Malakir Mire (ZNR) [111]', '1 Malakir Rebirth (ZNR) [111]')).toEqual([]);
    expect(planPhysicalCopies('1 Sol Ring (C21) [263]', '1 Sol Ring')).toEqual([]);
  });
  it('aggregates multiple finish lines and rejects more than 250 planned copies', () => {
    expect(planPhysicalCopies('2 Sol Ring (C21) [263]\n1 Sol Ring (C21) [263] *F*'))
      .toEqual([expect.objectContaining({ quantity: 3, isFoil: false })]);
    expect(() => planPhysicalCopies('251 Sol Ring')).toThrow('at most 250');
    expect(planPhysicalCopies('1000 Sol Ring', '999 Sol Ring')[0].quantity).toBe(1);
  });
});
