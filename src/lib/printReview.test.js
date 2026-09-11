import { describe, expect, it } from 'vitest';
import { loadPrintCreationIntent, printReviewReady, printReviewSummary, rejectedPrintCreation } from './printReview';

const face = (side, source = 'scryfall') => ({ face: side, source, identifier: `selected-${side}`, status: 'ready' });
const plan = () => ({ totalCopies: 8, ordinaryCopies: 1, doubleFacedCopies: 7,
  readyToGenerate: true, missingArtwork: [], cards: [{ quantity: 1 }, { quantity: 7 }],
  resolvedCards: [{ isDFC: false, faces: [face('front')], errors: [] },
    { isDFC: true, faces: [face('front', 'saved-mpc'), face('back', 'saved-mpc')], errors: [] }] });

describe('physical artwork review', () => {
  it('counts each double-sided copy once, with a separate front/back packet', () => {
    expect(printReviewSummary(plan())).toEqual({ ordinary: 1, doubleFaced: 7, ordinarySheets: 1, packets: 1, sheets: 2, pages: 3 });
    expect(printReviewReady(plan())).toBe(true);
  });
  it('keeps partially empty DFC sheets separate at the seven-card boundary', () => {
    expect(printReviewSummary({ totalCopies: 9, ordinaryCopies: 1, doubleFacedCopies: 8 })).toEqual({
      ordinary: 1, doubleFaced: 8, ordinarySheets: 1, packets: 2, sheets: 3, pages: 5,
    });
  });
  it('does not infer two printed sides from a split-card name', () => {
    const split = { readyToGenerate: true, totalCopies: 1, ordinaryCopies: 1, doubleFacedCopies: 0,
      cards: [{}], resolvedCards: [{ displayName: 'Fire // Ice', isDFC: false, faces: [face('front')] }] };
    expect(printReviewReady(split)).toBe(true);
    expect(printReviewSummary(split).packets).toBe(0);
  });
  it('blocks generation when an MPC back is missing, unresolved, or errored', () => {
    for (const faces of [[face('front')], [face('front'), { ...face('back'), status: 'missing' }],
      [face('front'), { ...face('back'), identifier: null }]]) {
      const missing = plan(); missing.resolvedCards[1].faces = faces;
      expect(printReviewReady(missing)).toBe(false);
    }
    const failed = plan(); failed.resolvedCards[1].errors = ['Unsupported layout'];
    expect(printReviewReady(failed)).toBe(false);
    const unknown = plan(); unknown.resolvedCards[1].isDFC = null;
    expect(printReviewReady(unknown)).toBe(false);
  });
  it('does not enable an old, incomplete, or explicitly rejected server review', () => {
    expect(printReviewReady({ cards: [{ quantity: 1 }], totalCopies: 1 })).toBe(false);
    expect(printReviewReady({ ...plan(), readyToGenerate: false })).toBe(false);
    expect(printReviewReady({ ...plan(), missingArtwork: [{ face: 'back' }] })).toBe(false);
    expect(printReviewReady({ ...plan(), resolvedCards: [] })).toBe(false);
  });
  it('leaves sheet counts unknown for unresolved identities and inconsistent totals', () => {
    expect(printReviewSummary({ totalCopies: 8, ordinaryCopies: null, doubleFacedCopies: null })).toBeNull();
    expect(printReviewSummary({ totalCopies: 8, ordinaryCopies: 1, doubleFacedCopies: 6 })).toBeNull();
    expect(printReviewSummary({ totalCopies: 8, ordinaryCopies: -1, doubleFacedCopies: 9 })).toBeNull();
  });
});

describe('durable print creation recovery', () => {
  const request = { mode: 'changes', targetSnapshotId: 2, baselineSnapshotId: 1,
    artSource: 'saved-mpc', includeSideboard: false, replacePrintings: true, queueOnReady: true,
    expectedPlanHash: 'a'.repeat(64), idempotencyKey: 'b'.repeat(48) };

  it('recovers the exact request, including queue intent and snapshot/artwork binding after remount', () => {
    const saved = new Map([['user1:deck2', JSON.stringify(request)]]);
    const storage = { getItem: key => saved.get(key) || null };
    expect(loadPrintCreationIntent(storage, 'user1:deck2')).toEqual(request);
    expect(loadPrintCreationIntent(storage, 'user2:deck2')).toBeNull();
    expect(loadPrintCreationIntent(storage, 'user1:deck3')).toBeNull();
  });
  it('does not replay malformed or incomplete locally stored requests', () => {
    for (const raw of ['bad json', '{}', JSON.stringify({ ...request, idempotencyKey: null }),
      JSON.stringify({ ...request, baselineSnapshotId: null }), JSON.stringify({ ...request, queueOnReady: 'true' })]) {
      expect(loadPrintCreationIntent({ getItem: () => raw }, 'key')).toBeNull();
    }
  });
  it('retains intent when transport or authorization can prevent an accepted receipt from being read', () => {
    for (const error of [new Error('offline'), { status: 401 }, { status: 403 }, { status: 408 }, { status: 429 }, { status: 500 }, { status: 503 }]) {
      expect(rejectedPrintCreation(error)).toBe(false);
    }
    for (const status of [400, 404, 409]) expect(rejectedPrintCreation({ status })).toBe(true);
  });
});
