import { describe, expect, it } from 'vitest';
import { printerHealthPresentation, printStationSummary } from './printStationStatus';

const current = { fresh: true, online: true, loading: false };
const reminder = 'Regularly check ink levels in the actual ink tanks.';
const ready = { ok: true, known: true, message: 'Printer is processing jobs', advisories: [reminder] };
const station = changes => ({ recipeVerified: true, duplexVerified: true, paused: false,
  activeJob: { state: 'submitted', deckName: 'Jin', id: 'batch-jin' }, health: ready, ...changes });

describe('printer status presentation', () => {
  it('keeps the current batch visible while an informational ink reminder is reported', () => {
    const value = station();
    expect(printStationSummary(value, current)).toBe('In the Epson queue');
    const health = printerHealthPresentation(value.health, true);
    expect(health.kind).toBe('ready');
    expect(health.tone).toBe('good');
    expect(health.message).toBe('Printer is processing jobs');
    expect(health.advisories).toEqual([reminder]);
    expect(printStationSummary(station({ activeJob: null }), current)).toBe('Ready for your next batch');
  });

  it('retains actual fault details even when the printer also has a routine reminder', () => {
    const fault = { ok: false, known: true, message: 'Rear feeder is out of paper', advisories: [reminder] };
    expect(printStationSummary(station({ health: fault }), current)).toBe('The printer needs attention');
    expect(printerHealthPresentation(fault, true)).toMatchObject({
      kind: 'fault', label: 'Reported problem', tone: 'warning', message: 'Rear feeder is out of paper', advisories: [reminder],
    });
  });

  it('does not claim an undecoded or missing report proves a printer problem or readiness', () => {
    const unknown = { ok: false, known: false, message: 'Printer reports an unrecognized status', advisories: [reminder] };
    expect(printerHealthPresentation(unknown, true)).toMatchObject({
      kind: 'unavailable', label: 'Status details', tone: 'neutral', message: unknown.message, advisories: [reminder],
    });
    expect(printStationSummary(station({ health: unknown }), current)).toBe('In the Epson queue');
    for (const health of [undefined, unknown, { ok: true, known: false }, { ok: false }, { known: true }]) {
      expect(printerHealthPresentation(health, true).kind).toBe('unavailable');
      expect(printStationSummary(station({ health, activeJob: null }), current)).toBe('Printer status unavailable');
    }
  });

  it('hides old faults and advisories when the station cannot provide current status', () => {
    const fault = { ok: false, known: true, message: 'Paper jam', advisories: [reminder] };
    const presentation = printerHealthPresentation(fault, false);
    expect(presentation.kind).toBe('unavailable');
    expect(presentation.tone).toBe('neutral');
    expect(presentation.message).not.toContain('Paper jam');
    expect(presentation.advisories).toEqual([]);
    expect(printStationSummary(station({ health: fault }), { ...current, fresh: false, online: false })).toBe('Waiting for a fresh status');
    expect(printStationSummary(station({ health: fault }), { ...current, online: false })).toBe('The Mac is offline');
  });

  it('keeps flip, reconciliation and pause instructions ahead of printer health', () => {
    const fault = { known: true, ok: false, message: 'Door open' };
    expect(printStationSummary(station({ health: fault, activeJob: { state: 'awaiting_refeed' } }), current)).toBe('Your paper needs flipping');
    expect(printStationSummary(station({ health: fault, activeJob: { state: 'uncertain' } }), current)).toBe('Review this batch on the Mac');
    expect(printStationSummary(station({ health: fault, paused: true }), current)).toBe('Printing is paused');
  });

  it('keeps unverified physical proofs separate from printer faults', () => {
    expect(printerHealthPresentation(ready, true).kind).toBe('ready');
    expect(printStationSummary(station({ activeJob: null, recipeVerified: false }), current)).toBe('Verify your print recipe on the Mac');
    expect(printStationSummary(station({ activeJob: null, recipeVerified: false, testPrintingEnabled: true }), current)).toBe('Ready for a test batch');
    expect(printStationSummary(station({ recipeVerified: false }), current)).toBe('In the Epson queue');
  });

  it('deduplicates readable advisory text without changing the received report', () => {
    const health = { ...ready, advisories: [reminder, ` ${reminder} `, '', null, 4] };
    const original = structuredClone(health);
    expect(printerHealthPresentation(health, true).advisories).toEqual([reminder]);
    expect(health).toEqual(original);
  });
});
