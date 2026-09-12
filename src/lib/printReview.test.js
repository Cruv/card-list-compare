import { describe, expect, it } from 'vitest';
import { loadPrintCreationIntent, loadStandalonePrintDraft, printReviewIndexes, printReviewReady, printReviewSummary, rejectedPrintCreation } from './printReview';
import { manaPoolLink, shoppingText } from './manasync';

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
    expect(loadPrintCreationIntent(storage, 'user1:deck2')).toEqual({ ...request, excludeBasicLands: false });
    expect(loadPrintCreationIntent(storage, 'user2:deck2')).toBeNull();
    expect(loadPrintCreationIntent(storage, 'user1:deck3')).toBeNull();
  });
  it('does not replay malformed or incomplete locally stored requests', () => {
    for (const raw of ['bad json', '{}', JSON.stringify({ ...request, idempotencyKey: null }),
      JSON.stringify({ ...request, baselineSnapshotId: null }), JSON.stringify({ ...request, queueOnReady: 'true' })]) {
      expect(loadPrintCreationIntent({ getItem: () => raw }, 'key')).toBeNull();
    }
  });
  it('recovers standalone text and reviewed edits without a snapshot or hidden deck', () => {
    const adhoc = { mode: 'adhoc', listName: 'Friday extras', cardText: '2 Lightning Bolt', artSource: 'scryfall',
      includeSideboard: false, replacePrintings: false, excludeBasicLands: true,
      additionalCardText: '1 Sol Ring', excludedCards: ['lightning bolt'], queueOnReady: true,
      expectedPlanHash: 'c'.repeat(64), idempotencyKey: 'd'.repeat(48) };
    expect(loadPrintCreationIntent({ getItem: () => JSON.stringify(adhoc) }, 'key')).toEqual(adhoc);
    for (const invalid of [{ cardText: '' }, { cardText: 'x'.repeat(100001) }, { listName: 'x'.repeat(121) },
      { artSource: 'saved-mpc' }, { additionalCardText: 'x'.repeat(100001) }, { additionalCardText: [] },
      { excludedCards: 'Lightning Bolt' }, { excludedCards: [''] }, { excludedCards: [null] },
      { excludedCards: ['x'.repeat(1001)] }, { excludedCards: Array(1001).fill('key') },
      { excludeBasicLands: 'false' }]) {
      expect(loadPrintCreationIntent({ getItem: () => JSON.stringify({ ...adhoc, ...invalid }) }, 'key')).toBeNull();
    }
  });
  it('keeps the legacy inclusion of basic lands instead of adopting the new form default', () => {
    const recovered = loadPrintCreationIntent({ getItem: () => JSON.stringify(request) }, 'key');
    expect(recovered.excludeBasicLands).toBe(false);
    expect(recovered.replacePrintings).toBe(true);
    expect(recovered.expectedPlanHash).toBe(request.expectedPlanHash);
    expect(recovered.idempotencyKey).toBe(request.idempotencyKey);
  });
  it('retains intent when transport or authorization can prevent an accepted receipt from being read', () => {
    for (const error of [new Error('offline'), { status: 401 }, { status: 403 }, { status: 408 }, { status: 429 }, { status: 500 }, { status: 503 }]) {
      expect(rejectedPrintCreation(error)).toBe(false);
    }
    for (const status of [400, 404, 409]) expect(rejectedPrintCreation({ status })).toBe(true);
  });
});

describe('standalone print drafts', () => {
  const draft = { listName: 'Extras', cardText: '2 Lightning Bolt', includeSideboard: false,
    excludeBasicLands: true, additionalCardText: '1 Sol Ring', excludedCards: ['lightning bolt'],
    removedCards: [{ key: 'lightning bolt', name: 'Lightning Bolt', quantity: 2 }] };
  it('restores edits only for the requested account storage key', () => {
    const storage = { getItem: key => key === 'user:1' ? JSON.stringify(draft) : null };
    expect(loadStandalonePrintDraft(storage, 'user:1')).toEqual(draft);
    expect(loadStandalonePrintDraft(storage, 'user:2')).toBeNull();
  });
  it('allows an empty draft while rejecting corrupt, oversized, or mistyped data', () => {
    expect(loadStandalonePrintDraft({ getItem: () => JSON.stringify({ ...draft, cardText: '' }) }, 'key').cardText).toBe('');
    for (const raw of ['bad json', '{}', JSON.stringify({ ...draft, cardText: 'x'.repeat(100001) }),
      JSON.stringify({ ...draft, includeSideboard: 1 }), JSON.stringify({ ...draft, excludedCards: [1] }),
      JSON.stringify({ ...draft, additionalCardText: 'x'.repeat(100001) })]) {
      expect(loadStandalonePrintDraft({ getItem: () => raw }, 'key')).toBeNull();
    }
    expect(loadStandalonePrintDraft({ getItem() { throw new Error('Blocked storage'); } }, 'key')).toBeNull();
  });
  it('drops malformed removed-card labels while retaining validated selection keys', () => {
    const recovered = loadStandalonePrintDraft({ getItem: () => JSON.stringify({ ...draft, removedCards: [null, { name: 'oops' }, ...draft.removedCards] }) }, 'key');
    expect(recovered.removedCards).toEqual(draft.removedCards);
  });
});

describe('print review filters and shopping', () => {
  const selection = { totalCopies: 11, cards: [
    { displayName: 'Fire // Ice', quantity: 3, setCode: 'MH2', collectorNumber: '290' },
    { displayName: 'Delver of Secrets', quantity: 2 },
    { displayName: 'Lightning Bolt', quantity: 4 },
    { displayName: 'Sol Ring', quantity: 1 },
    { displayName: 'Lightning Bolt', quantity: 1, setCode: 'M10' },
  ], resolvedCards: [{ isDFC: false }, { isDFC: true }, { isDFC: false }, { isDFC: null }, { isDFC: false }] };
  const ownership = [
    { ownership: { hasOriginal: true, incomingOnly: false } },
    { ownership: { hasOriginal: true, incomingOnly: true } },
    { ownership: { hasOriginal: false } },
    { ownership: null },
    { ownership: { hasOriginal: false } },
  ].map((row, index) => ({ ...row, key: `row:${index}`, card: { name: selection.cards[index].displayName }, shoppingKey: selection.cards[index].displayName }));
  it('filters physical faces, metadata and ownership without changing printable copies', () => {
    const original = structuredClone(selection);
    expect(printReviewIndexes(selection, { sides: 'double' }, ownership)).toEqual([1]);
    expect(printReviewIndexes(selection, { sides: 'single' }, ownership)).toEqual([0, 2, 4]);
    expect(printReviewIndexes(selection, { sides: 'unresolved' }, ownership)).toEqual([3]);
    expect(printReviewIndexes(selection, { query: 'mh2 290' }, ownership)).toEqual([0]);
    expect(printReviewIndexes(selection, { query: ' bolt ', ownership: 'missing' }, ownership)).toEqual([2, 4]);
    expect(printReviewIndexes(selection, { ownership: 'owned' }, ownership)).toEqual([0]);
    expect(printReviewIndexes(selection, { ownership: 'incoming' }, ownership)).toEqual([1]);
    expect(printReviewIndexes(selection, { ownership: 'unknown' }, ownership)).toEqual([3]);
    expect(printReviewIndexes(selection, { ownership: 'missing' }, [])).toEqual([]);
    expect(printReviewIndexes(selection, { ownership: 'unknown' }, [])).toEqual([0, 1, 2, 3, 4]);
    expect(selection).toEqual(original);
  });
  it('sorts names, counts or double-faced cards while retaining original row identities', () => {
    expect(printReviewIndexes(selection, { sort: 'name' })).toEqual([1, 0, 2, 4, 3]);
    expect(printReviewIndexes(selection, { sort: 'name-desc' })).toEqual([3, 4, 2, 0, 1]);
    expect(printReviewIndexes(selection, { sort: 'quantity-desc' })).toEqual([2, 0, 1, 4, 3]);
    expect(printReviewIndexes(selection, { sort: 'quantity-asc' })).toEqual([4, 3, 1, 0, 2]);
    expect(printReviewIndexes(selection, { sort: 'double-first' })).toEqual([1, 0, 2, 4, 3]);
  });
  it('buys one missing original per name in the filtered view, excluding incoming and unknown', () => {
    const indexes = printReviewIndexes(selection, { sides: 'single' }, ownership);
    const text = shoppingText(indexes.map(index => ownership[index]));
    expect(text).toBe('1 Lightning Bolt');
    const link = new URL(manaPoolLink(text));
    expect(link.origin + link.pathname).toBe('https://manapool.com/add-deck');
    expect(atob(link.searchParams.get('deck'))).toBe('1 Lightning Bolt');
    expect(shoppingText(printReviewIndexes(selection, { ownership: 'incoming' }, ownership).map(index => ownership[index]))).toBe('');
    expect(shoppingText(printReviewIndexes(selection, { ownership: 'unknown' }, ownership).map(index => ownership[index]))).toBe('');
  });
});
