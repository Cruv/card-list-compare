import { describe, expect, it } from 'vitest';
import { batchDetailRefresh, loadPrintCreationIntent, loadStandalonePrintDraft, saveStandaloneDraftReplacement, printArtOverridesAfterSave, printReviewIndexes, printCopyBreakdown, printSourceCopies, canCancelReviewedPrintJob, mixedPrintCompanionWait, printPacketBackCountLabel, printReviewReady, printReviewSummary, rejectedPrintCreation, waitingPrintArtifact } from './printReview';
import { DAHLE_A4_PRESET, availablePrintPaperChoices, loadDefaultPrintPaper, newPrintPaperChoice, printPaperChoice, printPaperLabel, printPaperRequest, printPaperUnavailable, refeedSameShortEdge, selectAvailablePrintPaper } from './printPaper';
import { manaPoolLink, shoppingText } from './manasync';

const face = (side, source = 'scryfall') => ({ face: side, source, identifier: `selected-${side}`, status: 'ready' });
const plan = () => ({ totalCopies: 8, ordinaryCopies: 1, doubleFacedCopies: 7,
  readyToGenerate: true, missingArtwork: [], cards: [{ quantity: 1 }, { quantity: 7 }],
  resolvedCards: [{ isDFC: false, faces: [face('front')], errors: [] },
    { isDFC: true, faces: [face('front', 'saved-mpc'), face('back', 'saved-mpc')], errors: [] }] });

describe('print workspace batch refresh', () => {
  it('refreshes every changed row and keeps completed rows outside the active list', () => {
    const unchanged = { id: 'newest', state: 'preparing', updatedAt: '1' };
    const stillActive = { id: 'middle', state: 'preparing', updatedAt: '1' };
    const leftActive = { id: 'older', state: 'submitted', updatedAt: '1' };
    const jobs = [unchanged, stillActive, leftActive, { id: 'gone', state: 'ready', updatedAt: '1' }];
    const activity = { jobs: [unchanged, { ...stillActive, updatedAt: '2' }],
      watchedJobs: [{ ...leftActive, state: 'completed' }] };
    expect(batchDetailRefresh(jobs, activity)).toEqual({ changed: ['middle', 'older'], removed: ['gone'] });
  });

  it('loads an unopened newest batch and an older deep link once each', () => {
    const activity = { jobs: [{ id: 'newest' }], watchedJobs: [] };
    expect(batchDetailRefresh([], activity, 'older').changed).toEqual(['older', 'newest']);
    expect(batchDetailRefresh([], activity, 'newest').changed).toEqual(['newest']);
  });
});

describe('physical artwork review', () => {
  it('uses saved deck art by default and keeps the chosen art on matching extras and an MPC review', () => {
    const prior = { selectionKey: 'unchanged', scryfallId: 'other-art' };
    const original = '["lightning bolt","m10","146"]';
    const additionalText = '2 Lightning Bolt (M10) [146]';
    const extra = { selectionKey: original, scryfallId: 'chosen-art' };
    const saved = { selectionKey: 'saved', scryfallId: 'chosen-art' };
    const choices = [{ ...saved, previousSelectionKey: original }];
    expect(printArtOverridesAfterSave([prior], choices, 'scryfall', additionalText)).toEqual([prior, extra]);
    expect(printArtOverridesAfterSave([prior], choices, 'saved-mpc', additionalText)).toEqual([prior, saved, extra]);
    expect(printArtOverridesAfterSave([prior], [{ ...extra, previousSelectionKey: original }], 'saved-mpc', additionalText)).toEqual([prior, extra]);
    expect(printArtOverridesAfterSave([prior], choices, 'scryfall', '')).toEqual([prior]);
  });
  it('prioritizes the saved destinations and explicit batch-only choices when print rows share keys', () => {
    const oldKey = '["lightning bolt","m10","146"]';
    const newKey = '["lightning bolt","plst","m10-146"]';
    const scryfallA = { selectionKey: oldKey, scryfallId: 'printing-a' };
    const scryfallB = { selectionKey: newKey, scryfallId: 'printing-b' };
    const swap = [{ ...scryfallB, previousSelectionKey: oldKey }, { ...scryfallA, previousSelectionKey: newKey }];
    const batchOnly = { selectionKey: newKey, scryfallId: 'batch-printing' };
    const extraCopies = '1 Lightning Bolt (M10) [146]';
    expect(printArtOverridesAfterSave([], swap, 'scryfall', extraCopies)).toEqual([]);
    expect(printArtOverridesAfterSave([], swap, 'saved-mpc', extraCopies)).toEqual([scryfallB, scryfallA]);
    expect(printArtOverridesAfterSave([batchOnly], swap, 'saved-mpc', extraCopies)).toEqual([batchOnly, scryfallA]);
  });
  it('keeps legacy cancellation limited to untouched work when no server permission is supplied', () => {
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
  it('uses current server cancellation permissions for native cancellation and suppresses duplicate requests', () => {
    expect(canCancelReviewedPrintJob({ state: 'submitted', canCancel: true })).toBe(true);
    expect(canCancelReviewedPrintJob({ state: 'backs_pending', canCancel: true })).toBe(true);
    expect(canCancelReviewedPrintJob({ state: 'ready', steps: [], canCancel: false })).toBe(false);
    expect(canCancelReviewedPrintJob({ state: 'submitted', canCancel: true, cancelRequested: 'all' })).toBe(false);
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
  it('counts Crowned A4 singles packed with a double-sided card as part of one physical sheet', () => {
    expect(printReviewSummary({ ...printPaperRequest('crowned-a4'), sheetPacking: 'double-faced-first',
      totalCopies: 9, ordinaryCopies: 8, doubleFacedCopies: 1 })).toEqual({
      ordinary: 8, doubleFaced: 1, ordinarySheets: 0, packets: 1, sheets: 1, pages: 2,
    });
  });
  it('allocates front-only sheets only for the singles left beyond the refeed sheets', () => {
    expect(printReviewSummary({ sheetPacking: 'double-faced-first', totalCopies: 15,
      ordinaryCopies: 7, doubleFacedCopies: 8 })).toEqual({
      ordinary: 7, doubleFaced: 8, ordinarySheets: 1, packets: 2, sheets: 3, pages: 5,
    });
  });
  it('uses the true back count for a mixed packet and the card count for a legacy packet', () => {
    expect(printPacketBackCountLabel({ cardCount: 9, doubleFacedCardCount: 1 })).toBe('1 card with a back');
    expect(printPacketBackCountLabel({ cardCount: 2 })).toBe('2 cards with backs');
  });
  it('explains the companion wait specifically for queued mixed batches on an online older Mac', () => {
    const job = { state: 'queued', requiresMixedPrintSheets: true };
    const station = { online: true, mixedPrintSheets: false };
    expect(mixedPrintCompanionWait(job, station)).toBe('Waiting for Mac companion 2.59.0 or newer');
    expect(mixedPrintCompanionWait(job, { ...station, mixedPrintSheets: true })).toBe('');
    expect(mixedPrintCompanionWait(job, { ...station, online: false })).toBe('');
    expect(mixedPrintCompanionWait({ ...job, state: 'ready' }, station)).toBe('');
    expect(mixedPrintCompanionWait({ state: 'queued' }, station)).toBe('');
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
  it('preserves the reviewed paper size through an ambiguous creation and keeps legacy requests unchanged', () => {
    const original = { ...request, paperSize: 'a4' };
    expect(loadPrintCreationIntent({ getItem: () => JSON.stringify(original) }, 'key').paperSize).toBe('a4');
    const crowned = { ...original, printPreset: 'crowned-a4' };
    expect(loadPrintCreationIntent({ getItem: () => JSON.stringify(crowned) }, 'key').printPreset).toBe('crowned-a4');
    expect(loadPrintCreationIntent({ getItem: () => JSON.stringify({ ...crowned, paperSize: 'letter' }) }, 'key')).toBeNull();
    const landscape = { ...original, printPreset: 'crowned-a4-landscape' };
    expect(loadPrintCreationIntent({ getItem: () => JSON.stringify(landscape) }, 'key')).toMatchObject(landscape);
    expect(loadPrintCreationIntent({ getItem: () => JSON.stringify({ ...landscape, paperSize: 'letter' }) }, 'key')).toBeNull();
    const portraitSix = { ...original, printPreset: 'crowned-a4-portrait-six' };
    expect(loadPrintCreationIntent({ getItem: () => JSON.stringify(portraitSix) }, 'key')).toMatchObject(portraitSix);
    expect(loadPrintCreationIntent({ getItem: () => JSON.stringify({ ...portraitSix, paperSize: 'letter' }) }, 'key')).toBeNull();
    expect(loadPrintCreationIntent({ getItem: () => JSON.stringify(request) }, 'key')).not.toHaveProperty('paperSize');
    expect(loadPrintCreationIntent({ getItem: () => JSON.stringify({ ...request, paperSize: 'a3' }) }, 'key')).toBeNull();
  });
  it('replays PDFs without registration marks after a lost creation response', () => {
    const read = value => loadPrintCreationIntent({ getItem: () => JSON.stringify(value) }, 'key');
    expect(read({ ...request, registrationMarks: false })).toMatchObject({ registrationMarks: false, idempotencyKey: request.idempotencyKey });
    expect(read(request)).not.toHaveProperty('registrationMarks');
    expect(read({ ...request, registrationMarks: 'false' })).toBeNull();
  });
  it.each(['dahleAlignmentMarks', 'dahleCutGuides'])('replays the original %s Dahle request with its reviewed hash and key', flag => {
    const read = value => loadPrintCreationIntent({ getItem: () => JSON.stringify(value) }, 'key');
    const marked = { ...request, ...printPaperRequest(DAHLE_A4_PRESET, { [flag]: true }), registrationMarks: false };
    expect(marked[flag]).toBe(true);
    expect(read(marked)).toMatchObject(marked);
    expect(read({ ...marked, [flag]: false })).not.toHaveProperty(flag);
    expect(read({ ...marked, [flag]: 'true' })).toBeNull();
    expect(read({ ...marked, printPreset: 'crowned-a4' })).toBeNull();
    expect(read({ ...marked, dahleAlignmentMarks: true, dahleCutGuides: true })).toBeNull();
    expect(printPaperRequest('letter', { [flag]: true })).not.toHaveProperty(flag);
    expect(printPaperRequest(DAHLE_A4_PRESET)).not.toHaveProperty(flag);
  });
  it('retains intent when transport or authorization can prevent an accepted receipt from being read', () => {
    for (const error of [new Error('offline'), { status: 401 }, { status: 403 }, { status: 408 }, { status: 429 }, { status: 500 }, { status: 503 }]) {
      expect(rejectedPrintCreation(error)).toBe(false);
    }
    for (const status of [400, 404, 409]) expect(rejectedPrintCreation({ status })).toBe(true);
  });
});

it('keeps Crowned A4 distinct from standard A4 and plans nine cards per sheet', () => {
  const crowned = printPaperRequest('crowned-a4');
  const plan = { totalCopies: 18, ordinaryCopies: 9, doubleFacedCopies: 9 };
  const station = { online: true, loadedPaperSize: 'a4', supportedRecipeIds: ['household-a4-v5', 'household-crowned-a4-v2'] };
  expect(crowned).toEqual({ paperSize: 'a4', printPreset: 'crowned-a4' });
  expect(loadDefaultPrintPaper({ getItem: () => 'crowned-a4' }, 'key')).toBe('crowned-a4');
  expect(printReviewSummary({ ...plan, ...crowned })).toMatchObject({ ordinarySheets: 1, packets: 1, pages: 3 });
  expect(printReviewSummary({ ...plan, paperSize: 'a4' })).toMatchObject({ ordinarySheets: 2, packets: 2, pages: 6 });
  expect(printPaperUnavailable(crowned, station)).toMatch(/set up for A4/);
  expect(printPaperUnavailable(crowned, { ...station, loadedPrintPreset: 'crowned-a4' })).toBe('');
  expect(printPaperUnavailable({ paperSize: 'a4' }, { ...station, loadedPrintPreset: 'crowned-a4' })).toMatch(/set up for Crowned A4/);
});

it('only offers grain-aligned A4 layouts and keeps A4 as the preference on an older server', () => {
  const oldCapabilities = { paperSizes: ['letter', 'a4'], printPresets: ['crowned-a4', 'crowned-a4-landscape'] };
  const oldChoices = availablePrintPaperChoices(oldCapabilities);
  expect(oldChoices).toEqual(['letter', 'crowned-a4']);
  expect(selectAvailablePrintPaper('crowned-a4-portrait-six', oldChoices)).toBe('crowned-a4');
  expect(selectAvailablePrintPaper('letter', oldChoices)).toBe('letter');
  expect(selectAvailablePrintPaper('crowned-a4-portrait-six', availablePrintPaperChoices({}))).toBe('letter');
  expect(availablePrintPaperChoices({ ...oldCapabilities,
    printPresets: [...oldCapabilities.printPresets, 'crowned-a4-portrait-six'] })).toEqual(['letter', 'crowned-a4', 'crowned-a4-portrait-six']);
});

it.each(['a4', 'crowned-a4-landscape'])('moves the saved %s default to Crowned portrait 3×2', retiredChoice => {
  expect(loadDefaultPrintPaper({ getItem: () => retiredChoice }, 'key')).toBe('crowned-a4-portrait-six');
});

it('saves the advertised Dahle preset, counts nine fixed slots, and leaves printing to the PDF viewer', () => {
  const recipeId = 'household-dahle-a4-punch-v1';
  const selection = printPaperRequest(DAHLE_A4_PRESET);
  expect(availablePrintPaperChoices({ printPresets: ['crowned-a4', DAHLE_A4_PRESET] })).toEqual(['letter', 'crowned-a4', DAHLE_A4_PRESET]);
  expect(loadDefaultPrintPaper({ getItem: () => DAHLE_A4_PRESET }, 'key')).toBe(DAHLE_A4_PRESET);
  expect(selection).toEqual({ paperSize: 'a4', printPreset: DAHLE_A4_PRESET });
  expect(printPaperChoice({ recipeId })).toBe(DAHLE_A4_PRESET);
  expect(printReviewSummary({ ...selection, totalCopies: 10, ordinaryCopies: 10, doubleFacedCopies: 0 })).toMatchObject({ sheets: 2, pages: 2 });
  const station = { online: true, loadedPaperSize: 'a4', loadedPrintPreset: DAHLE_A4_PRESET, supportedRecipeIds: [recipeId] };
  expect(printPaperUnavailable(selection, station)).toMatch(/downloaded PDF/);
});

it('matches Crowned landscape jobs by exact loaded preset and supported recipe', () => {
  const portrait = printPaperRequest('crowned-a4');
  const landscape = printPaperRequest('crowned-a4-landscape');
  const recipeId = 'household-crowned-a4-landscape-v2';
  const station = { online: true, loadedPaperSize: 'a4', loadedPrintPreset: landscape.printPreset,
    supportedRecipeIds: ['household-a4-v5', 'household-crowned-a4-v2', recipeId] };
  expect(landscape).toEqual({ paperSize: 'a4', printPreset: 'crowned-a4-landscape' });
  expect(printPaperChoice({ recipeId })).toBe(landscape.printPreset);
  expect(printPaperLabel(landscape)).toBe('Crowned A4 · Landscape 2×4');
  expect(printPaperUnavailable(landscape, station)).toBe('');
  expect(printPaperUnavailable(landscape, { ...station, loadedPrintPreset: portrait.printPreset })).toMatch(/set up for Crowned A4 · Portrait 3×3/);
  expect(printPaperUnavailable(landscape, { ...station, loadedPrintPreset: undefined })).toMatch(/set up for A4/);
  expect(printPaperUnavailable(landscape, { ...station, loadedPaperSize: 'letter' })).toMatch(/set up for US Letter/);
  expect(printPaperUnavailable(landscape, { ...station, supportedRecipeIds: ['household-crowned-a4-v2'] })).toMatch(/Update and configure the Mac companion/);
  const shifted = { ...landscape, recipeId: 'household-crowned-a4-landscape-v1' };
  expect(printPaperLabel(shifted)).toMatch(/shifted/);
  expect(printPaperUnavailable(shifted, { ...station, supportedRecipeIds: [shifted.recipeId, recipeId] })).toBe('');
  expect(printPaperUnavailable(landscape, { ...station, supportedRecipeIds: [shifted.recipeId] })).toMatch(/Update and configure the Mac companion/);
  expect(printPaperUnavailable(landscape, { ...station, online: false })).toMatch(/must be online/);
  expect(printReviewSummary({ ...landscape, sheetPacking: 'double-faced-first', totalCopies: 8, ordinaryCopies: 7, doubleFacedCopies: 1 }))
    .toMatchObject({ ordinarySheets: 0, packets: 1, sheets: 1, pages: 2 });
  expect(printReviewSummary({ ...landscape, sheetPacking: 'double-faced-first', totalCopies: 9, ordinaryCopies: 8, doubleFacedCopies: 1 }))
    .toMatchObject({ ordinarySheets: 1, packets: 1, sheets: 2, pages: 3 });
});

it('counts six top-row slots and matches the Crowned 3×2 preset independently', () => {
  const six = printPaperRequest('crowned-a4-portrait-six');
  const recipeId = 'household-crowned-a4-portrait-six-v1';
  const fullPortraitRecipeId = 'household-crowned-a4-v2';
  const station = { online: true, loadedPaperSize: 'a4', loadedPrintPreset: six.printPreset,
    supportedRecipeIds: [fullPortraitRecipeId, recipeId] };
  expect(six).toEqual({ paperSize: 'a4', printPreset: 'crowned-a4-portrait-six' });
  expect(loadDefaultPrintPaper({ getItem: () => six.printPreset }, 'key')).toBe(six.printPreset);
  expect(printPaperChoice({ recipeId })).toBe(six.printPreset);
  expect(printPaperLabel(six)).toBe('Crowned A4 · Portrait 3×2');
  expect(printPaperUnavailable(six, station)).toBe('');
  expect(printPaperUnavailable(six, { ...station, loadedPrintPreset: 'crowned-a4' })).toMatch(/set up for Crowned A4 · Portrait 3×3/);
  expect(printPaperUnavailable(six, { ...station, supportedRecipeIds: [fullPortraitRecipeId] })).toMatch(/Update and configure the Mac companion/);
  expect(refeedSameShortEdge({ recipeId })).toBe(true);
  expect(refeedSameShortEdge({ recipeId: 'household-crowned-a4-landscape-v2' })).toBe(false);
  const mixed = { ...six, sheetPacking: 'double-faced-first', doubleFacedCopies: 1 };
  expect(printReviewSummary({ ...mixed, totalCopies: 6, ordinaryCopies: 5 })).toMatchObject({ sheets: 1, packets: 1, ordinarySheets: 0, pages: 2 });
  expect(printReviewSummary({ ...mixed, totalCopies: 7, ordinaryCopies: 6 })).toMatchObject({ sheets: 2, packets: 1, ordinarySheets: 1, pages: 3 });
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
  it.each(['crowned-a4-landscape', 'crowned-a4-portrait-six', DAHLE_A4_PRESET])('retains preset %s in the draft when A4 paper is specified', preset => {
    const value = { ...draft, ...printPaperRequest(preset) };
    expect(loadStandalonePrintDraft({ getItem: () => JSON.stringify(value) }, 'key')).toEqual(value);
    expect(loadStandalonePrintDraft({ getItem: () => JSON.stringify({ ...value, paperSize: 'letter' }) }, 'key')).toBeNull();
  });
  it.each(['a4', 'crowned-a4-landscape'])('moves an unsubmitted %s draft to Crowned portrait 3×2', retiredChoice => {
    const value = { ...draft, ...printPaperRequest(retiredChoice) };
    const restored = loadStandalonePrintDraft({ getItem: () => JSON.stringify(value) }, 'key');
    expect(printPaperChoice(restored)).toBe(retiredChoice);
    expect({ ...restored, ...printPaperRequest(newPrintPaperChoice(printPaperChoice(restored))) }).toMatchObject({
      ...draft, paperSize: 'a4', printPreset: 'crowned-a4-portrait-six',
    });
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
      printingOverrides: [{ selectionKey: 'sol ring', scryfallId: '12345678-1234-1234-1234-123456789abc' }], registrationMarks: false };
    expect(loadStandalonePrintDraft({ getItem: () => JSON.stringify(value) }, 'key')).toEqual(value);
    expect(loadStandalonePrintDraft({ getItem: () => JSON.stringify({ ...value, comparison: { mode: 'full', beforeText: null } }) }, 'key')).toBeNull();
  });
  it('keeps rounded Dahle guides in standalone draft recovery and leaves older drafts unmarked', () => {
    const read = value => loadStandalonePrintDraft({ getItem: () => JSON.stringify(value) }, 'key');
    const marked = { ...draft, ...printPaperRequest(DAHLE_A4_PRESET, { dahleCutGuides: true }) };
    expect(marked.dahleCutGuides).toBe(true);
    expect(read(marked)).toEqual(marked);
    expect(read(draft)).not.toHaveProperty('dahleCutGuides');
    expect(read({ ...marked, printPreset: 'crowned-a4' })).toBeNull();
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


describe('waiting back packet identity', () => {
  const artifacts = [{ id: 'packet-1', kind: 'dfc', label: 'First sheet' }, { id: 'packet-2', kind: 'dfc', label: 'Second sheet' }];
  const steps = [{ artifactId: 'packet-1', phase: 'fronts', state: 'completed' }, { artifactId: 'packet-1', phase: 'backs', state: 'pending' }, { artifactId: 'packet-2', phase: 'fronts', state: 'completed' }, { artifactId: 'packet-2', phase: 'backs', state: 'pending' }];
  it('keeps the matching margin label for an already-claimed legacy batch', () => {
    expect(waitingPrintArtifact({ state: 'awaiting_refeed', steps, artifacts })).toBe(artifacts[0]);
  });
  it('uses the selected later packet instead of the first saved back', () => {
    expect(waitingPrintArtifact({ state: 'awaiting_refeed', backRequest: { artifactId: 'packet-2' }, steps, artifacts })).toBe(artifacts[1]);
  });
  it('does not describe an unselected saved back or invent a missing selected packet', () => {
    expect(waitingPrintArtifact({ state: 'backs_pending', steps, artifacts })).toBeNull();
    expect(waitingPrintArtifact({ state: 'awaiting_refeed', backRequest: { artifactId: 'missing' }, steps, artifacts })).toBeNull();
  });
});
