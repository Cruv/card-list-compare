import { describe, expect, it } from 'vitest';
import { printerHealthPresentation, printStationSummary, paperClearanceIdentity, printRecoveryIdentity } from './printStationStatus';

const current = { fresh: true, online: true, loading: false };
const reminder = 'Regularly check ink levels in the actual ink tanks.';
const ready = { ok: true, known: true, message: 'Printer is processing jobs', advisories: [reminder] };
const station = changes => ({ recipeVerified: true, duplexVerified: true, paused: false,
  activeJob: { state: 'submitted', deckName: 'Jin', id: 'batch-jin' }, health: ready, ...changes });

describe('printer status presentation', () => {
  it('binds a recovery acknowledgement to the exact spooler attempt and physical sheet order', () => {
    const job = { id: 'job', state: 'uncertain', recovery: { recoveryId: `recover-${'a'.repeat(24)}`,
      artifactId: 'ordinary', phase: 'fronts', spoolerId: 'EPSON-23', mode: 'reprint_remaining',
      cupsState: 7, physicalPages: [18, 17, 16], totalSheets: 3 } };
    const boundary = printRecoveryIdentity(job);
    expect(boundary).not.toBeNull();
    expect(boundary).toBe(printRecoveryIdentity(structuredClone(job)));
    for (const changed of [
      { spoolerId: 'EPSON-24' }, { recoveryId: `recover-${'b'.repeat(24)}` },
      { phase: 'backs' }, { artifactId: 'another-packet' }, { cupsState: 8 }, { physicalPages: [16, 17, 18] },
    ]) expect(printRecoveryIdentity({ ...job, recovery: { ...job.recovery, ...changed } })).not.toBe(boundary);
    expect(printRecoveryIdentity({ ...job, id: 'another-job' })).not.toBe(boundary);
    for (const invalid of [
      { mode: 'resume' }, { cupsState: 9 }, { totalSheets: 2 }, { physicalPages: [18, 18, 16] },
      { physicalPages: [18, 0, 16] }, { physicalPages: ['18', 17, 16] }, { recoveryId: '' },
    ]) expect(printRecoveryIdentity({ ...job, recovery: { ...job.recovery, ...invalid } })).toBeNull();
    expect(printStationSummary(station({ activeJob: job }), current)).toBe('Continue the interrupted print pass');
    expect(printStationSummary(station({ activeJob: job, paused: true }), current)).toBe('Printing is paused');
    const processing = { ...job, state: 'submitted', recovery: { ...job.recovery, mode: 'resume', cupsState: 5 } };
    expect(printStationSummary(station({ activeJob: processing }), current)).toBe('In the Epson queue');
    expect(printStationSummary(station({ activeJob: processing, health: { known: true, ok: false } }), current)).toBe('Continue the interrupted print pass');
  });
  it('binds paper acknowledgement to the exact job, state and clearance boundary', () => {
    const first = { id: 'same-job', state: 'awaiting_paper_reset', clearanceId: 'back:first-request' };
    const saved = paperClearanceIdentity(first);
    expect(saved).toBe(paperClearanceIdentity({ ...first }));
    for (const changed of [
      { ...first, clearanceId: 'back:second-request' },
      { ...first, state: 'awaiting_clearance' },
      { ...first, id: 'another-job' },
    ]) expect(paperClearanceIdentity(changed)).not.toBe(saved);
    for (const missing of [null, {}, { ...first, clearanceId: null }, { ...first, clearanceId: '' }, { ...first, id: null }, { ...first, state: 'submitted' }]) {
      expect(paperClearanceIdentity(missing)).toBeNull();
    }
  });
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

  it('treats selected-back paper handling as action while saved backs do not block the next job', () => {
    expect(printStationSummary(station({ activeJob: null }), current)).toBe('Ready for your next batch');
    expect(printStationSummary(station({ activeJob: { state: 'awaiting_paper_reset' } }), current)).toBe('Restore blank paper for the next job');
    expect(printStationSummary(station({ activeJob: { state: 'awaiting_clearance' } }), current)).toBe('Clear paper from the canceled pass');
  });

  it('deduplicates readable advisory text without changing the received report', () => {
    const health = { ...ready, advisories: [reminder, ` ${reminder} `, '', null, 4] };
    const original = structuredClone(health);
    expect(printerHealthPresentation(health, true).advisories).toEqual([reminder]);
    expect(health).toEqual(original);
  });
});
