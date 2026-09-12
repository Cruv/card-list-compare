import { describe, expect, it } from 'vitest';
import { loadPrintCreationIntent, loadStandalonePrintDraft, saveStandaloneDraftReplacement, printReviewIndexes, printCopyBreakdown, printSourceCopies, canCancelReviewedPrintJob, printReviewReady, printReviewSummary, rejectedPrintCreation } from './printReview';
import { manaPoolLink, shoppingText } from './manasync';

const face = (side, source = 'scryfall') => ({ face: side, source, identifier: `selected-${side}`, status: 'ready' });
const plan = () => ({ totalCopies: 8, ordinaryCopies: 1, doubleFacedCopies: 7,
  readyToGenerate: true, missingArtwork: [], cards: [{ quantity: 1 }, { quantity: 7 }],
  resolvedCards: [{ isDFC: false, faces: [face('front')], errors: [] },
    { isDFC: true, faces: [face('front', 'saved-mpc'), face('back', 'saved-mpc')], errors: [] }] });

describe('physical artwork review', () => {
  it('offers cancellation for untouched work, but never between printed packets or after an uncertain submission', () => {
    for (const state of ['preparing', 'ready', 'queued', 'claimed']) expect(canCancelReviewedPrintJob({ state, steps: [] })).toBe(true);
    const pending = { state: 'claimed', steps: [{ phase: 'fronts', state: 'pending' }, { phase: 'backs', state: 'pending' }] };
    expect(canCancelReviewedPrintJob(pending)).toBe(true);
    for (const state of ['submitting', 'submitted', 'completed', 'uncertain', 'failed']) {
      expect(canCancelReviewedPrintJob({ ...pending, steps: [{ state }, { state: 'pending' }] })).toBe(false);
    }
    expect(canCancelReviewedPrintJob({ state: 'claimed' })).toBe(false);
    expect(canCancelReviewedPrintJob({ ...pending, state: 'awaiting_refeed' })).toBe(false);
    expect(canCancelReviewedPrintJob({ ...pending, state: 'canceled' })).toBe(false);
  });
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
  it('replays the frozen comparison and selected artwork after a lost creation response', () => {
    const comparison = { mode: 'changes', beforeText: '1 Lightning Bolt' };
    const printingOverrides = [{ selectionKey: '["lightning bolt","",""]', scryfallId: '12345678-1234-1234-1234-123456789abc' }];
    const value = { ...request, mode: 'adhoc', artSource: 'scryfall', listName: 'Compared lists', cardText: '3 Lightning Bolt', comparison, printingOverrides };
    delete value.targetSnapshotId; delete value.baselineSnapshotId;
    const recovered = loadPrintCreationIntent({ getItem: () => JSON.stringify(value) }, 'key');
    expect(recovered.comparison).toEqual(comparison);
    expect(recovered.printingOverrides).toEqual(printingOverrides);
    expect(recovered.cardText).toBe('3 Lightning Bolt');
    for (const invalid of [{ comparison: { mode: 'remove', beforeText: '' } }, { comparison: { mode: 'changes', beforeText: 'x'.repeat(100001) } },
      { printingOverrides: [{ selectionKey: 'key', scryfallId: 'not-an-id' }] }, { printingOverrides: Array(251).fill(printingOverrides[0]) },
      { printingOverrides: [{ scryfallId: printingOverrides[0].scryfallId }] }]) {
      expect(loadPrintCreationIntent({ getItem: () => JSON.stringify({ ...value, ...invalid }) }, 'key')).toBeNull();
    }
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
  it('preserves comparison mode and art selections in a draft or recovery copy', () => {
    const value = { ...draft, comparison: { mode: 'full', beforeText: '1 Sol Ring' }, replacePrintings: true,
      printingOverrides: [{ selectionKey: 'sol ring', scryfallId: '12345678-1234-1234-1234-123456789abc' }] };
    expect(loadStandalonePrintDraft({ getItem: () => JSON.stringify(value) }, 'key')).toEqual(value);
    expect(loadStandalonePrintDraft({ getItem: () => JSON.stringify({ ...value, comparison: { mode: 'full', beforeText: null } }) }, 'key')).toBeNull();
  });
  it('preserves the current draft and prior recovery when comparison persistence fails', () => {
    const data = new Map([['draft', JSON.stringify(draft)], ['recovery', '{"older":true}']]);
    const storage = { getItem: key => data.get(key) ?? null, removeItem: key => data.delete(key),
      setItem(key, value) { if (key === 'draft') throw new Error('Quota exceeded'); data.set(key, value); } };
    expect(() => saveStandaloneDraftReplacement(storage, 'draft', 'recovery', draft, { ...draft, cardText: '1 Sol Ring' })).toThrow('Quota exceeded');
    expect(JSON.parse(data.get('draft'))).toEqual(draft);
    expect(data.get('recovery')).toBe('{"older":true}');
  });
  it('saves a recoverable old draft before accepting the next one', () => {
    const data = new Map([['draft', JSON.stringify(draft)]]);
    const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
    const next = { ...draft, listName: 'Compared lists', comparison: { mode: 'changes', beforeText: '1 Sol Ring' } };
    saveStandaloneDraftReplacement(storage, 'draft', 'recovery', draft, next);
    expect(JSON.parse(data.get('draft'))).toEqual(next);
    expect(JSON.parse(data.get('recovery'))).toEqual(draft);
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


describe('print copy accounting', () => {
  it('distinguishes physical copies from entries and honors the selected sections', () => {
    const text = 'Commander\n1 Jin Sakai, Ghost of Tsushima\n4 Plains\n2 Island\n2 Swamp\n1 Rhystic Study (j18) [7] F\nSideboard\n3 Sol Ring';
    expect(printSourceCopies(text)).toBe(10);
    expect(printSourceCopies(text, true)).toBe(13);
  });
  it('explains a comparison reduction before basic filtering or manual adjustments', () => {
    expect(printCopyBreakdown({ totalCopies: 94, cards: [{ quantity: 94 }] }, 100)).toEqual({
      sourceCopies: 100, suggestedCopies: 94, unchangedCopies: 6, extraCopies: 0, removedCopies: 0, basicCopies: 0, totalCopies: 94,
    });
  });
  it('accounts for removed suggestions, readded extras and skipped extra basics exactly once', () => {
    const result = printCopyBreakdown({ totalCopies: 5, cards: [{ quantity: 5, additionalQuantity: 2 }],
      removedCards: [{ quantity: 3 }], excludedBasicLands: [{ quantity: 6, additionalQuantity: 2 }] }, 15);
    expect(result).toEqual({ sourceCopies: 15, suggestedCopies: 10, unchangedCopies: 5, extraCopies: 4, removedCopies: 3, basicCopies: 6, totalCopies: 5 });
    expect(result.sourceCopies - result.unchangedCopies + result.extraCopies - result.removedCopies - result.basicCopies).toBe(result.totalCopies);
  });
});
