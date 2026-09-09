import { describe, it, expect } from 'vitest';
import { deckBridgeLines } from './deckBridgeLines.js';

describe('raw deck identities for ownership and physical print reporting', () => {
  it('keeps separate quantities for the same printing in foil and nonfoil', () => {
    const cards = deckBridgeLines('1 Sol Ring (CMM) 410\n2 Sol Ring (CMM) 410 *F*');
    expect(cards.map(row => [row.quantity,row.card.setCode,row.card.collectorNumber,row.card.finish])).toEqual([
      [1,'CMM','410','nonfoil'],[2,'CMM','410','foil'],
    ]);
    expect(new Set(cards.map(row => row.key)).size).toBe(2);
  });

  it('keeps separate sets even when card names and collector numbers coincide', () => {
    const cards = deckBridgeLines('1 Island (M20) 265\n3 Island (M21) 265');
    expect(cards.map(row => [row.quantity,row.card.setCode])).toEqual([[1,'M20'],[3,'M21']]);
  });

  it('preserves commander, mainboard, sideboard, and double-face identity without duplication', () => {
    const cards = deckBridgeLines('Commander\r\nAtraxa, Praetors\u2019 Voice\r\n\r\nMainboard\r\n1 Delver of Secrets // Insectile Aberration (ISD) 51\r\nSB: 2 Negate\r\nSideboard\r\n1 Counterspell\r\n');
    expect(cards.map(row => [row.quantity,row.section,row.card.name])).toEqual([
      [1,'commander',"Atraxa, Praetors' Voice"],
      [1,'mainboard','Delver of Secrets // Insectile Aberration'],
      [2,'sideboard','Negate'],
      [1,'sideboard','Counterspell'],
    ]);
  });

  it('retains explicit sections and inline commander tags while ignoring comments and empty lines', () => {
    const cards = deckBridgeLines('# Note\n1 Test Commander (Commander)\n// Other note\nMainboard\n1 Sol Ring\nMaybeboard:\n2 Island');
    expect(cards.map(row => row.section)).toEqual(['commander','mainboard','maybeboard']);
    expect(cards.map(row => row.card.name)).toEqual(['Test Commander','Sol Ring','Island']);
  });

  it('keeps the existing blank-line sideboard convention and leaves table CSV to its parser', () => {
    expect(deckBridgeLines('2 Island\n\n1 Negate').map(row => row.section)).toEqual(['mainboard','sideboard']);
    expect(deckBridgeLines('Name,Quantity\n"Atraxa, Praetors Voice",1')).toBeNull();
    expect(deckBridgeLines(undefined)).toBeNull();
  });

  it('keeps spaced mainboard groups together whenever an explicit Commander block exists', () => {
    for (const text of ['Commander\n1 Partner\n\n1 Sol Ring\n\n2 Island', '1 Sol Ring\n\n2 Island\nCommander\n1 Partner']) {
      const cards = deckBridgeLines(text);
      expect(cards.filter(row => row.section === 'mainboard').map(row => row.card.name)).toEqual(['Sol Ring','Island']);
      expect(cards.filter(row => row.section === 'commander').map(row => row.card.name)).toEqual(['Partner']);
      expect(cards.some(row => row.section === 'sideboard')).toBe(false);
    }
  });

  it('recognizes the Archidekt comment-style sideboard header before skipping comments', () => {
    const cards = deckBridgeLines('Commander\n1 Partner\n\n1 Sol Ring\n# Sideboard\n2 Negate\n# Notes\n1 Dispel');
    expect(cards.map(row => row.section)).toEqual(['commander','mainboard','sideboard','sideboard']);
  });
});
