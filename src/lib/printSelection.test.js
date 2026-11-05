import { describe, expect, it } from 'vitest';
import { isBasicLand, printCardKey } from './printSelection.js';

describe('print selection identities and basic-land filter', () => {
  it('ignores quantity, finish and name aliases while keeping requested printings distinct', () => {
    const key = printCardKey({ displayName: 'Malakir Rebirth // Malakir Mire', setCode: 'ZNR', collectorNumber: '111', quantity: 2 });
    expect(printCardKey({ displayName: 'malakir rebirth', setCode: 'znr', collectorNumber: '111', isFoil: true })).toBe(key);
    expect(printCardKey({ displayName: 'Malakir Rebirth' })).not.toBe(key);
  });
  it('matches basic supertypes and exact English names including snow basics and Wastes', () => {
    for (const displayName of ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes', 'Snow-Covered Plains', 'Snow-Covered Island', 'Snow-Covered Swamp', 'Snow-Covered Mountain', 'Snow-Covered Forest']) {
      expect(isBasicLand({ displayName })).toBe(true);
    }
    expect(isBasicLand({ displayName: 'Localized land', typeLine: 'Basic Snow Land — Forest' })).toBe(true);
    for (const displayName of ['Badlands', 'Academy Ruins', 'Forest Bear', 'Snowfield Sinkhole', 'Malakir Rebirth // Malakir Mire']) expect(isBasicLand({ displayName, typeLine: 'Land' })).toBe(false);
  });
});
