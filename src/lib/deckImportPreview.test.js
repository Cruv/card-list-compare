import { describe, expect, it } from 'vitest';
import { inspectDeckImport, parse } from './parser.js';
import { _archidektToText, _moxfieldToText } from './fetcher.js';

describe('deck import preview', () => {
  it('retains the whole supported export and reports each exact printing', () => {
    const text = '# Commander\r\n1 Thalia, Guardian of Thraben (SLD) [DDO-20] *F*\r\n\r\nDeck\r\n1 Sol Ring\r\n';
    const preview = inspectDeckImport(text);
    expect(preview.text).toBe(text);
    expect(preview.skipped).toEqual([]);
    expect(preview.accepted).toMatchObject([
      { line: 2, displayName: 'Thalia, Guardian of Thraben', section: 'commander', setCode: 'SLD', collectorNumber: 'DDO-20', isFoil: true },
      { line: 5, displayName: 'Sol Ring', section: 'main', setCode: '', collectorNumber: '' },
    ]);
  });

  it('omits invalid, etched and maybeboard lines without reclassifying the implicit sideboard', () => {
    const text = '1 Sol Ring (C21) [263] *E*\r\n0 Island\r\n\r\n2 Negate (M20) [69]\r\nConsidering\r\n1 Island';
    const preview = inspectDeckImport(text);
    expect(preview.skipped.map(row => [row.line, row.reason])).toEqual([
      [1, 'Unsupported finish (*E*)'], [2, 'Invalid card row or quantity'], [6, 'Maybeboard'],
    ]);
    expect(preview.text).toBe('Sideboard\r\n2 Negate (M20) [69]');
    expect(parse(preview.text).mainboard.size).toBe(0);
    expect([...parse(preview.text).sideboard.values()]).toMatchObject([{ displayName: 'Negate', quantity: 2, setCode: 'M20', collectorNumber: '69' }]);
  });

  it('reports unsupported CSV finishes while preserving quoted names and every supported cell', () => {
    const header = 'Name,Count,Section,Set,Collector Number,Finish,Notes';
    const foil = '"Atraxa, Praetors\' Voice",1,Commander,2XM,190,Foil,"mine, keep"';
    const etched = 'Sol Ring,2,Main,C21,263,Etched,causes a wrong art choice';
    const preview = inspectDeckImport([header, foil, etched].join('\r\n'));
    expect(preview.text).toBe([header, foil].join('\r\n'));
    expect(preview.accepted).toMatchObject([{ displayName: "Atraxa, Praetors' Voice", section: 'commander', isFoil: true }]);
    expect(preview.skipped).toEqual([{ line: 3, raw: etched, reason: 'Unsupported finish (Etched)' }]);
  });

  it('reviews omitted provider board rows and never substitutes foil for an etched printing', () => {
    const skipped = { card: { name: 'Arcane Signet', set: 'cmr', cn: '297' }, quantity: 1, finish: 'etched' };
    const accepted = { card: { name: 'Sol Ring', set: 'c21', cn: '263' }, quantity: 2, finish: 'foil' };
    const data = { boards: { mainboard: { cards: { skipped, accepted } }, maybeboard: { cards: { skipped } } } };
    expect(_moxfieldToText(data, { review: true })).toMatchObject({ text: '2 Sol Ring (c21) [263] *F*', skipped: [
      { raw: '1 Arcane Signet (cmr) [297]', reason: 'Unsupported finish (etched)' },
      { raw: '1 Arcane Signet (cmr) [297]', reason: 'Maybeboard' },
    ] });
    expect(_archidektToText({ cards: [{ card: { name: 'Sol Ring', edition: { editioncode: 'C21' }, collectorNumber: '263' }, quantity: 1, modifier: 'Etched' }] }, { review: true }))
      .toMatchObject({ text: '', skipped: [{ raw: '1 Sol Ring (C21) [263]', reason: 'Unsupported finish (Etched)' }] });
  });
});
