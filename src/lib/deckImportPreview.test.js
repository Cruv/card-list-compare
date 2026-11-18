import { describe, expect, it } from 'vitest';
import { inspectDeckImport, inspectDeckPaste, parse } from './parser.js';
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

  it('replaces only the selected range in a CRLF draft and shows the selected and skipped text', () => {
    const previous = '1 Opt (ELD) [59]';
    const draft = `// keep these spaces   \r\nDeck\r\n${previous}\r\nMaybeboard\n1 Island\n`;
    const selectionStart = draft.replace(/\r\n/g, '\n').indexOf(previous);
    const selected = '2 Counterspell (SLD) [DDO-20] *F*';
    const preview = inspectDeckPaste(draft, `${selected}\n1 Sol Ring (C21) [263] *E*\n0 Ash Barrens`,
      selectionStart, selectionStart + previous.length);
    expect(preview.text).toBe(draft.replace(previous, selected));
    expect(preview.replacedText).toBe(previous);
    expect(preview.skipped).toMatchObject([
      { raw: '1 Sol Ring (C21) [263] *E*', reason: 'Unsupported finish (*E*)' },
      { raw: '0 Ash Barrens', reason: 'Invalid card row or quantity' },
    ]);
    expect(preview.accepted).toMatchObject([
      { displayName: 'Counterspell', quantity: 2, section: 'main', setCode: 'SLD', collectorNumber: 'DDO-20', isFoil: true },
    ]);
  });

  it('shows the same board and commander assignments as the applied list', () => {
    const draft = 'Commander\n1 Atraxa (2XM) [190]\n\nDeck\n1 Sol Ring';
    const selected = '1 Sol Ring';
    const pasted = '1 Thalia (SLD) [DDO-20] *F* (Commander)\nSB: 1 Negate';
    const preview = inspectDeckPaste(draft, pasted, draft.indexOf(selected), draft.length);
    expect(preview.accepted.map(row => [row.displayName, row.section])).toEqual([
      ['Atraxa', 'commander'], ['Thalia', 'main'], ['Negate', 'sideboard'],
    ]);
    expect(parse(preview.text).commanders).toEqual(['Atraxa']);
    const inline = inspectDeckPaste('Deck\n', pasted, 5, 5);
    expect(inline.accepted.map(row => [row.displayName, row.section])).toEqual([
      ['Thalia', 'commander'], ['Negate', 'sideboard'],
    ]);
    expect(parse(inline.text).commanders).toEqual(['Thalia']);
  });

  it('preserves the draft when rejected rows leave only pasted separators', () => {
    const preview = inspectDeckPaste('1 Island', '0 Invalid\n\n', 0, 0);
    expect(preview.text).toBe('1 Island');
    expect(preview.accepted).toMatchObject([{ displayName: 'Island', section: 'main' }]);
    expect(preview.skipped).toMatchObject([{ raw: '0 Invalid' }]);
    expect(parse(preview.text).sideboard.size).toBe(0);
  });

  it('omits only the clipboard portion of a rejected row shared with untouched text', () => {
    const draft = '1 Forest (M10) [249]\r\n1 Negate';
    const delimiter = draft.indexOf('\r');
    const preview = inspectDeckPaste(draft, ' *E*', delimiter, delimiter);
    expect(preview.text).toBe(draft);
    expect(preview.skipped).toEqual([{ line: 1, raw: ' *E*', reason: 'Unsupported finish (*E*)' }]);
    expect(preview.replacedText).toBe('');
  });

  it.each(['\n', '\r\n'])('drops a pasted separator left solely by a rejected partial row (%j)', separator => {
    const draft = '// Existing note  \r\n1 Sol Ring (C21) [263] *F*\r\n1 Island';
    const caret = draft.replace(/\r\n/g, '\n').indexOf('*F*');
    const beforeSeparator = inspectDeckPaste(draft, `*E*${separator}`, caret, caret);
    const afterSeparator = inspectDeckPaste(draft, `${separator}0 `, caret, caret);
    expect(beforeSeparator.skipped).toEqual([{ line: 2, raw: '*E*', reason: 'Unsupported finish (*E*)' }]);
    expect(afterSeparator.skipped).toEqual([{ line: 3, raw: '0 ', reason: 'Invalid card row or quantity' }]);
    for (const preview of [beforeSeparator, afterSeparator]) {
      expect(preview.text).toBe(draft);
      expect(preview.replacedText).toBe('');
      expect(preview.accepted.map(row => [row.displayName, row.section, row.setCode, row.collectorNumber, row.isFoil]))
        .toEqual([['Sol Ring', 'main', 'C21', '263', true], ['Island', 'main', '', '', false]]);
      expect([...parse(preview.text).mainboard.keys()]).toEqual(['sol ring|c21|263|foil', 'island']);
    }
  });

  it.each(['\n', '\r\n'])('keeps separators needed by accepted rows next to rejected boundary text (%j)', separator => {
    const original = '1 Sol Ring (C21) [263] *F*';
    const accepted = '2 Opt (ELD) [59] *F*';
    const leading = inspectDeckPaste(`${original}\r\n1 Island`, ` *E*${separator}${accepted}`, original.length, original.length);
    expect(leading.text).toBe(`${original}${separator}${accepted}\r\n1 Island`);
    expect(leading.skipped).toMatchObject([{ raw: ' *E*' }]);
    const trailing = inspectDeckPaste(`${original}\r\n1 Island`, `${accepted}${separator}0 `, 0, 0);
    expect(trailing.text).toBe(`${accepted}${separator}${original}\r\n1 Island`);
    expect(trailing.skipped).toMatchObject([{ raw: '0 ' }]);
    for (const preview of [leading, trailing]) {
      expect([...parse(preview.text).mainboard.keys()].sort()).toEqual(['island', 'opt|eld|59|foil', 'sol ring|c21|263|foil']);
    }
  });

  it('restores the selected text when the entire replacement is rejected', () => {
    const draft = '1 Sol Ring (C21) [263] *F*\r\n1 Island';
    const marker = draft.indexOf('*F*');
    const partial = inspectDeckPaste(draft, '*E*\r\n', marker, marker + '*F*'.length);
    const whole = inspectDeckPaste(draft, '0 Opt\r\n\r\n', 0, draft.indexOf('\r'));
    for (const preview of [partial, whole]) {
      expect(preview.text).toBe(draft);
      expect(preview.replacedText).toBe('');
      expect(preview.accepted[0]).toMatchObject({ displayName: 'Sol Ring', isFoil: true });
    }
    expect(partial.skipped).toMatchObject([{ raw: '*E*' }]);
    expect(whole.skipped).toMatchObject([{ raw: '0 Opt' }]);
  });

  it('reports retained clipboard rows that would split a saved printing after filtering', () => {
    const draft = '// Keep this note  \r\n1 Sol Ring (C21) [263] *F*\r\nMaybeboard\n1 Island';
    const marker = draft.replace(/\r\n/g, '\n').indexOf('*F*');
    const preview = inspectDeckPaste(draft, '*E*\r\n1 Opt (ELD) [59]\r\n', marker, marker);
    expect(preview.text).toBe(draft);
    expect(preview.accepted).toMatchObject([{ displayName: 'Sol Ring', isFoil: true }]);
    expect(preview.skipped).toMatchObject([
      { raw: '*E*', reason: 'Unsupported finish (*E*)' },
      { raw: '1 Opt (ELD) [59]', reason: expect.stringContaining('Would split an existing card printing') },
    ]);
  });

  it('keeps existing CSV notes and maybeboard rows byte for byte', () => {
    const header = 'Name,Count,Section,Set,Collector Number,Finish,Notes';
    const retained = 'Island,1,Maybeboard,ABC,123,Normal,"keep, exact"';
    const draft = `${header}\r\n${retained}\r\n`;
    const valid = `"Atraxa, Praetors' Voice",1,Commander,2XM,190,Foil,"keep, comma"\n`;
    const preview = inspectDeckPaste(draft, `Sol Ring,1,Main,C21,263,Etched,skip\n${valid}`, header.length + 1, header.length + 1);
    expect(preview.text).toBe(`${header}\r\n${valid}${retained}\r\n`);
    expect(preview.accepted).toMatchObject([{ displayName: "Atraxa, Praetors' Voice", section: 'commander', isFoil: true }]);
    expect(preview.skipped).toMatchObject([{ raw: 'Sol Ring,1,Main,C21,263,Etched,skip' }]);
  });
});
