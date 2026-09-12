import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db.js', () => ({ get: vi.fn() }));
vi.mock('./scryfallImages.js', () => ({ fetchCardImageUrls: vi.fn() }));
import { get } from '../db.js';
import { fetchCardImageUrls } from './scryfallImages.js';
import { buildPrintPlan, publicPrintPlan, planPhysicalCopies } from './printQueuePlan.js';
import { printCardKey } from '../../src/lib/printSelection.js';

describe('physical print copy planning', () => {
  it('plans positive increases, never removed or already-present copies', () => {
    expect(planPhysicalCopies('5 Lightning Bolt\n1 Sol Ring', '2 Lightning Bolt\n1 Counterspell'))
      .toEqual([expect.objectContaining({ displayName: 'Lightning Bolt', quantity: 3 }), expect.objectContaining({ displayName: 'Sol Ring', quantity: 1 })]);
  });
  it('counts commanders once and excludes sideboard unless requested', () => {
    const text = 'Commander\n1 Atraxa, Praetors\nMainboard\n1 Sol Ring\nSideboard\n2 Counterspell';
    expect(planPhysicalCopies(text).reduce((sum, card) => sum + card.quantity, 0)).toBe(2);
    expect(planPhysicalCopies(text, '', { includeSideboard: true }).reduce((sum, card) => sum + card.quantity, 0)).toBe(4);
  });
  it('aggregates zones before comparing so moving a copy requires no reprint', () => {
    expect(planPhysicalCopies('Sideboard\n1 Sol Ring', 'Mainboard\n1 Sol Ring', { includeSideboard: true })).toEqual([]);
  });
  it('treats changed printing as a new copy only when requested', () => {
    const target = '1 Lightning Bolt (M10) [146]', before = '1 Lightning Bolt (LEA) [161]';
    expect(planPhysicalCopies(target, before)).toEqual([expect.objectContaining({ setCode: 'M10', collectorNumber: '146', quantity: 1 })]);
    expect(planPhysicalCopies(target, before, { replacePrintings: false })).toEqual([]);
  });
  it('keeps exact existing art before allocating interchangeable copies', () => {
    const target = '3 Lightning Bolt (M10) [146]\n1 Lightning Bolt (LEA) [161]';
    expect(planPhysicalCopies(target, '2 Lightning Bolt (LEA) [161]', { replacePrintings: false }))
      .toEqual([expect.objectContaining({ setCode: 'M10', quantity: 2 })]);
  });
  it('does not reprint finish changes, DFC aliases, or newly supplied metadata alone', () => {
    expect(planPhysicalCopies('1 Sol Ring (C21) [263] *F*', '1 Sol Ring (C21) [263]')).toEqual([]);
    expect(planPhysicalCopies('1 Malakir Rebirth // Malakir Mire (ZNR) [111]', '1 Malakir Rebirth (ZNR) [111]')).toEqual([]);
    expect(planPhysicalCopies('1 Sol Ring (C21) [263]', '1 Sol Ring')).toEqual([]);
  });
  it('aggregates multiple finish lines and rejects more than 250 planned copies', () => {
    expect(planPhysicalCopies('2 Sol Ring (C21) [263]\n1 Sol Ring (C21) [263] *F*'))
      .toEqual([expect.objectContaining({ quantity: 3, isFoil: false })]);
    expect(() => planPhysicalCopies('251 Sol Ring')).toThrow('at most 250');
    expect(planPhysicalCopies('1000 Sol Ring', '999 Sol Ring')[0].quantity).toBe(1);
  });
});

describe('resolved artwork review', () => {
  let deck, target, baseline;
  const resolved = card => ({ ...card, scryfallId: 'printing-id', oracleId: 'oracle-id', layout: 'normal',
    faceNames: [card.displayName], isDFC: false, imageUrls: { front: 'https://cards.scryfall.io/front.png' },
    thumbnailUrls: { front: 'https://cards.scryfall.io/front.jpg' }, lookupFailures: [] });
  const dfc = card => ({ ...resolved(card), layout: 'modal_dfc', isDFC: true,
    faceNames: ['Malakir Rebirth', 'Malakir Mire'], imageUrls: { front: 'front.png', back: 'back.png' },
    thumbnailUrls: { front: 'front.jpg', back: 'back.jpg' } });
  beforeEach(() => {
    vi.clearAllMocks();
    deck = { id: 1, deck_name: 'Deck', user_id: 1, paper_snapshot_id: 1, mpc_art_overrides: null };
    baseline = { id: 1, created_at: '2026-01-01', deck_text: '1 Lightning Bolt' };
    target = { id: 2, created_at: '2026-01-02', deck_text: '2 Lightning Bolt\n1 Malakir Rebirth // Malakir Mire' };
    get.mockImplementation((sql, params) => sql.includes('tracked_decks') ? deck : params[0] === 1 && params.length === 2 ? baseline : target);
    fetchCardImageUrls.mockImplementation(async cards => cards.map(card => card.displayName.startsWith('Malakir') ? dfc(card) : resolved(card)));
  });

  it('accounts for all 100 Jin Sakai copies, including foil and hyphenated printing metadata', async () => {
    const text = readFileSync(new URL('./fixtures/jin-sakai-print-list.txt', import.meta.url), 'utf8');
    expect(text.trim().split(/\r?\n/)).toHaveLength(95);
    const all = await buildPrintPlan(9, null, { mode: 'adhoc', cardText: text, excludeBasicLands: false });
    expect(all).toMatchObject({ totalCopies: 100, readyToGenerate: true });
    expect(all.cards).toHaveLength(95);
    expect(all.cards.find(card => card.displayName === "Sigarda's Aid")).toMatchObject({ setCode: 'sld', collectorNumber: '731', quantity: 1 });
    expect(all.cards.find(card => card.displayName === 'Rhystic Study')).toMatchObject({ setCode: 'j18', collectorNumber: '7', quantity: 1 });
    expect(all.cards.filter(card => card.collectorNumber.includes('-')).map(card => card.collectorNumber)).toEqual(['2XM-32', 'THB-236', 'KLD-247']);
    const filtered = await buildPrintPlan(9, null, { mode: 'adhoc', cardText: text });
    expect(filtered).toMatchObject({ totalCopies: 92, ordinaryCopies: 92, readyToGenerate: true });
    expect(filtered.cards).toHaveLength(92);
    expect(filtered.excludedBasicLands.map(card => [card.displayName, card.quantity])).toEqual([['Plains', 4], ['Island', 2], ['Swamp', 2]]);
    expect(filtered.totalCopies + filtered.excludedBasicLands.reduce((sum, card) => sum + card.quantity, 0)).toBe(100);
    const beforeText = '1 Arcane Signet\n1 Sol Ring\n1 Command Tower\n1 Exotic Orchard\n7 Island';
    const changes = await buildPrintPlan(9, null, { mode: 'adhoc', cardText: text, excludeBasicLands: false, comparison: { mode: 'changes', beforeText } });
    expect(changes).toMatchObject({ totalCopies: 94, readyToGenerate: true });
    expect(changes.cards).toHaveLength(90);
    expect(changes.cards.some(card => ['Arcane Signet', 'Sol Ring', 'Command Tower', 'Exotic Orchard', 'Island'].includes(card.displayName))).toBe(false);

  });

  it('resolves a standalone list without a tracked deck and exposes only its label and text hash', async () => {
    const text = 'Commander\n1 Lightning Bolt (M10) [146]\nMainboard\n2 Malakir Rebirth // Malakir Mire (ZNR) [111]\nSideboard\n3 Sol Ring';
    const privatePlan = await buildPrintPlan(9, null, { mode: 'adhoc', listName: '  Saturday extras  ', cardText: text });
    expect(privatePlan).toMatchObject({ deckId: null, deckName: 'Saturday extras', requesterId: 9, mode: 'adhoc',
      source: null, target: null, totalCopies: 3, ordinaryCopies: 1, doubleFacedCopies: 2,
      readyToGenerate: true, list: { name: 'Saturday extras', text, textHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(get).not.toHaveBeenCalled();
    const publicPlan = publicPrintPlan(privatePlan);
    expect(publicPlan.list).toEqual({ name: 'Saturday extras', textHash: privatePlan.list.textHash });
    expect((await buildPrintPlan(9, null, { cardText: text, includeSideboard: true })).totalCopies).toBe(6);
    expect((await buildPrintPlan(9, null, { cardText: '1 Sol Ring' })).deckName).toBe('Print list');
    expect((await buildPrintPlan(9, null, { cardText: text, listName: 'Different batch' })).planHash).not.toBe(privatePlan.planHash);
  });
  it('pins selected Scryfall printings by original row key without changing copy counts or unselected MPC faces', async () => {
    const selectedId = 'a1111111-1111-4111-8111-111111111111';
    const selectionKey = printCardKey({ displayName: 'Malakir Rebirth // Malakir Mire' });
    deck.mpc_art_overrides = JSON.stringify([['Lightning Bolt', { identifier: 'keep-bolt-front-art' }]]);
    fetchCardImageUrls.mockImplementation(async cards => cards.map(card => card.requestedScryfallId
      ? { ...dfc(card), scryfallId: card.requestedScryfallId, setCode: 'newset', collectorNumber: '99' } : resolved(card)));
    const options = { artSource: 'saved-mpc', printingOverrides: [{ selectionKey, scryfallId: selectedId.toUpperCase() }], additionalCardText: '2 Malakir Rebirth // Malakir Mire' };
    const plan = await buildPrintPlan(1, 1, options);
    expect(plan).toMatchObject({ artSource: 'saved-mpc', totalCopies: 5, ordinaryCopies: 2, doubleFacedCopies: 3, readyToGenerate: true,
      printingOverrides: [{ selectionKey, scryfallId: selectedId }] });
    expect(plan.resolvedCards[0]).toMatchObject({ artSource: 'saved-mpc', faces: [{ source: 'saved-mpc', identifier: 'keep-bolt-front-art' }] });
    expect(plan.resolvedCards[1]).toMatchObject({ selectionKey, requestedScryfallId: selectedId, quantity: 3, baseQuantity: 1, additionalQuantity: 2,
      artSource: 'scryfall', setCode: 'newset', collectorNumber: '99', faces: [
        { face: 'front', source: 'scryfall', identifier: selectedId }, { face: 'back', source: 'scryfall', identifier: selectedId },
      ] });
    expect(plan.cards[1].selectionKey).toBe(selectionKey);
    expect(plan.target.text).toBe(target.deck_text);
    const otherId = 'b2222222-2222-4222-8222-222222222222';
    expect((await buildPrintPlan(1, 1, { ...options, printingOverrides: [{ selectionKey, scryfallId: otherId }] })).planHash).not.toBe(plan.planHash);
    const without = await buildPrintPlan(1, 1, { ...options, printingOverrides: [] });
    expect(without.planHash).not.toBe(plan.planHash);
    expect(without.readyToGenerate).toBe(false); // Restoring the default restores its missing MPC selection.
    const removed = await buildPrintPlan(1, 1, { ...options, excludedCards: [selectionKey] });
    expect(removed.resolvedCards[1]).toMatchObject({ quantity: 2, baseQuantity: 0, additionalQuantity: 2, requestedScryfallId: selectedId });
  });
  it.each([
    'invalid', Array(251).fill({}), [null], [{ selectionKey: 'invalid', scryfallId: 'a1111111-1111-4111-8111-111111111111' }],
    [{ selectionKey: '["sol ring","",""]', scryfallId: 'not-an-id' }],
    [{ selectionKey: '["sol ring","",""]', scryfallId: 'a1111111-1111-4111-8111-111111111111' }, { selectionKey: '["sol ring","",""]', scryfallId: 'b2222222-2222-4222-8222-222222222222' }],
  ])('rejects invalid or duplicate per-card printing choices before lookup: %j', async printingOverrides => {
    await expect(buildPrintPlan(1, null, { cardText: '1 Sol Ring', printingOverrides })).rejects.toThrow();
    expect(fetchCardImageUrls).not.toHaveBeenCalled();
  });
  it('keeps a missing selected printing visible and blocks generation instead of restoring earlier art', async () => {
    const selectionKey = printCardKey({ displayName: 'Lightning Bolt' });
    fetchCardImageUrls.mockImplementation(async cards => cards.map(card => ({ ...card, imageUrls: null,
      lookupFailures: [{ face: 'card', reason: 'Selected printing was not found or does not match this card' }] })));
    const plan = await buildPrintPlan(1, null, { cardText: '2 Lightning Bolt', printingOverrides: [{ selectionKey, scryfallId: 'a1111111-1111-4111-8111-111111111111' }] });
    expect(plan).toMatchObject({ readyToGenerate: false, totalCopies: 2, ordinaryCopies: null, doubleFacedCopies: null });
    expect(plan.resolvedCards[0]).toMatchObject({ selectionKey, scryfallId: null, errors: ['Selected printing was not found or does not match this card'] });
  });
  it('plans Compare changes from frozen before/after lists with the same zones, removals and extras', async () => {
    const beforeText = 'Commander\n1 Sol Ring\nMainboard\n2 Lightning Bolt (M10) [146]\n5 Island\nSideboard\n1 Counterspell';
    const cardText = 'Commander\n1 Sol Ring\nMainboard\n3 Lightning Bolt (M10) [146]\n2 Malakir Rebirth // Malakir Mire\n6 Island\nSideboard\n3 Counterspell';
    const comparison = { mode: 'changes', beforeText };
    const plan = await buildPrintPlan(1, null, { cardText, comparison });
    expect(plan).toMatchObject({ mode: 'adhoc', deckId: null, source: null, target: null, replacePrintings: false,
      totalCopies: 3, ordinaryCopies: 1, doubleFacedCopies: 2, readyToGenerate: true,
      list: { text: cardText }, comparison: { mode: 'changes', beforeText, beforeTextHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(plan.cards.map(card => [card.displayName, card.quantity])).toEqual([['Lightning Bolt', 1], ['Malakir Rebirth // Malakir Mire', 2]]);
    expect(plan.excludedBasicLands[0]).toMatchObject({ displayName: 'Island', quantity: 1 });
    expect(publicPrintPlan(plan).comparison).toEqual({ mode: 'changes', beforeTextHash: plan.comparison.beforeTextHash });
    expect((await buildPrintPlan(1, null, { cardText, comparison, includeSideboard: true })).totalCopies).toBe(5);
    const edited = await buildPrintPlan(1, null, { cardText, comparison,
      excludedCards: [printCardKey({ displayName: 'Lightning Bolt', setCode: 'M10', collectorNumber: '146' })], additionalCardText: '2 Sol Ring' });
    expect(edited).toMatchObject({ totalCopies: 4, ordinaryCopies: 2, doubleFacedCopies: 2 });
    expect(edited.cards.find(card => card.displayName === 'Sol Ring')).toMatchObject({ baseQuantity: 0, additionalQuantity: 2, quantity: 2 });
    expect(get).not.toHaveBeenCalled();
  });
  it('can print the full after list or replace changed printings while keeping comparison hashes distinct', async () => {
    const cardText = '1 Sol Ring (LTC) [284]';
    const comparison = { mode: 'changes', beforeText: '1 Sol Ring (C21) [263]' };
    const unchanged = await buildPrintPlan(1, null, { cardText, comparison });
    expect(unchanged).toMatchObject({ totalCopies: 0, readyToGenerate: false, replacePrintings: false });
    const replace = await buildPrintPlan(1, null, { cardText, comparison, replacePrintings: true });
    expect(replace.cards).toEqual([expect.objectContaining({ setCode: 'LTC', collectorNumber: '284', quantity: 1 })]);
    const full = await buildPrintPlan(1, null, { cardText, comparison: { ...comparison, mode: 'full' } });
    expect(full.totalCopies).toBe(1);
    expect(new Set([unchanged.planHash, replace.planHash, full.planHash]).size).toBe(3);
    const otherBaseline = await buildPrintPlan(1, null, { cardText, comparison: { mode: 'full', beforeText: '1 Counterspell' } });
    expect(otherBaseline.planHash).not.toBe(full.planHash);
    expect((await buildPrintPlan(1, null, { cardText, comparison: { mode: 'changes', beforeText: '' } })).totalCopies).toBe(1);
    expect((await buildPrintPlan(1, null, { cardText: '1000 Sol Ring', comparison: { mode: 'changes', beforeText: '999 Sol Ring' } })).totalCopies).toBe(1);
    const same = await buildPrintPlan(1, null, { cardText: '1 Sol Ring', comparison: { mode: 'changes', beforeText: '1 Sol Ring' } });
    expect(same).toMatchObject({ totalCopies: 0, readyToGenerate: false, cards: [], resolvedCards: [] });
  });
  it.each([
    null, [], {}, { mode: 'invalid', beforeText: '' }, { mode: 'changes' },
    { mode: 'full', beforeText: 4 }, { mode: 'changes', beforeText: 'x'.repeat(100001) },
    { mode: 'changes', beforeText: '1 Sol Ring\u0000' }, { mode: 'changes', beforeText: '1 Sol Ring\n0 Counterspell' },
    { mode: 'full', beforeText: 'Quantity,Name\n1,Sol Ring\n-2,Counterspell' },
  ])('rejects malformed comparison inputs before resolving artwork: %j', async comparison => {
    await expect(buildPrintPlan(1, null, { cardText: '2 Sol Ring', comparison })).rejects.toThrow();
    expect(fetchCardImageUrls).not.toHaveBeenCalled();
  });
  it('validates standalone printing-replacement flags and still rejects an empty after list', async () => {
    await expect(buildPrintPlan(1, null, { cardText: '1 Sol Ring', replacePrintings: 'true' })).rejects.toThrow('replacePrintings must be true or false');
    await expect(buildPrintPlan(1, null, { cardText: '', comparison: { mode: 'changes', beforeText: '1 Sol Ring' } })).rejects.toThrow('Add cards');
    expect(fetchCardImageUrls).not.toHaveBeenCalled();
  });
  it.each([
    [{ cardText: '' }, 'Add cards'], [{ cardText: [] }, 'Add cards'], [{ cardText: '1 Sol Ring\u0000' }, 'control characters'],
    [{ cardText: '1 Sol Ring\n0 Island' }, 'line 2'], [{ cardText: '1 Sol Ring\n-2 Island' }, 'line 2'],
    [{ cardText: '1 Sol Ring\n1.5 Island' }, 'line 2'], [{ cardText: '1 Sol Ring\n9007199254740992 Island' }, 'line 2'],
    [{ cardText: '1 Sol Ring\n42' }, 'line 2'], [{ cardText: 'Sideboard\n1 Island' }, 'No cards'],
    [{ cardText: '251 Island', excludeBasicLands: false }, 'at most 250'], [{ cardText: '1 Island', listName: 42 }, 'listName'],
    [{ cardText: '1 Island', listName: 'a'.repeat(121) }, '120'], [{ cardText: '1 Island', listName: 'Two\nlines' }, 'one line'],
    [{ cardText: '1 Island', mode: 'changes' }, 'mode adhoc'], [{ cardText: '1 Island', artSource: 'saved-mpc' }, 'Scryfall'],
    [{ cardText: '1 Island', targetSnapshotId: 1 }, 'snapshots'], [{ cardText: '1 Island', includeSideboard: 'yes' }, 'true or false'],
    [{ cardText: 'a'.repeat(100001) }, '100,000'],
  ])('rejects malformed standalone input before artwork lookup: %j', async (input, message) => {
    await expect(buildPrintPlan(1, null, input)).rejects.toThrow(message);
    expect(fetchCardImageUrls).not.toHaveBeenCalled();
  });
  it('retains valid CSV rows and refuses a partially invalid CSV print list', async () => {
    const csv = 'Quantity,Name,Set,Collector Number\n2,"Atraxa, Praetors Voice",ONE,196\n1,Sol Ring,C21,263';
    const plan = await buildPrintPlan(1, null, { cardText: csv });
    expect(plan.totalCopies).toBe(3);
    expect(plan.cards[0]).toMatchObject({ displayName: 'Atraxa, Praetors Voice', setCode: 'ONE', collectorNumber: '196' });
    await expect(buildPrintPlan(1, null, { cardText: `${csv}\n0,Island` })).rejects.toThrow('line 4');
    await expect(buildPrintPlan(1, null, { cardText: 'quantity,misspelled\n1,Island' })).rejects.toThrow('Name or Card column');
  });
  it('defaults to keeping existing art and excludes known basic lands before copy-limit checks', async () => {
    baseline.deck_text = '1 Sol Ring (C21) [263]'; target.deck_text = '1 Sol Ring (LTC) [284]';
    expect(await buildPrintPlan(1, 1, { mode: 'changes' })).toMatchObject({ replacePrintings: false, totalCopies: 0 });
    expect((await buildPrintPlan(1, 1, { mode: 'changes', replacePrintings: true })).totalCopies).toBe(1);
    const cardText = '240 Lightning Bolt\n30 Island\n20 Snow-Covered Forest\n1 Wastes';
    const plan = await buildPrintPlan(1, null, { cardText });
    expect(plan.totalCopies).toBe(240);
    expect(plan.excludedBasicLands.reduce((count, card) => count + card.quantity, 0)).toBe(51);
    expect(servicesCards()).not.toContain('Island');
    await expect(buildPrintPlan(1, null, { cardText, excludeBasicLands: false })).rejects.toThrow('at most 250');
    function servicesCards() { return fetchCardImageUrls.mock.calls.at(-1)[0].map(card => card.displayName); }
  });
  it('removes suggested rows before adding extras, freezes quantities, and preserves snapshot text', async () => {
    target.deck_text = '3 Lightning Bolt (M10) [146]\n2 Sol Ring\n30 Island';
    const key = printCardKey({ displayName: 'Lightning Bolt', setCode: 'M10', collectorNumber: '146' });
    const options = { excludedCards: [key], additionalCardText: '1 Lightning Bolt (M10) [146]\n2 Malakir Rebirth // Malakir Mire\n4 Sol Ring\n10 Plains' };
    const plan = await buildPrintPlan(1, 1, options);
    expect(plan).toMatchObject({ totalCopies: 9, ordinaryCopies: 7, doubleFacedCopies: 2,
      removedCards: [expect.objectContaining({ selectionKey: key, quantity: 3 })],
      additionalCardText: options.additionalCardText, additionalTextHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(plan.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ displayName: 'Sol Ring', quantity: 6, baseQuantity: 2, additionalQuantity: 4 }),
      expect.objectContaining({ displayName: 'Lightning Bolt', quantity: 1, baseQuantity: 0, additionalQuantity: 1 }),
      expect.objectContaining({ displayName: 'Malakir Rebirth // Malakir Mire', quantity: 2, baseQuantity: 0, additionalQuantity: 2 }),
    ]));
    expect(plan.target.text).toBe(target.deck_text);
    expect(publicPrintPlan(plan).additionalCardText).toBeUndefined();
    expect((await buildPrintPlan(1, 1, { ...options, excludedCards: [] })).planHash).not.toBe(plan.planHash);
    expect((await buildPrintPlan(1, 1, { ...options, additionalCardText: '1 Sol Ring' })).planHash).not.toBe(plan.planHash);
    expect((await buildPrintPlan(1, 1, { ...options, excludeBasicLands: false })).planHash).not.toBe(plan.planHash);
  });
  it('keeps request selection identities when metadata fills printing details and recognizes Basic Land types', async () => {
    fetchCardImageUrls.mockImplementation(async cards => cards.map(card => ({ ...resolved(card), setCode: 'resolved', collectorNumber: '42',
      typeLine: card.displayName === 'New basic' ? 'Basic Snow Land — Plains' : 'Land' })));
    const plan = await buildPrintPlan(1, null, { cardText: '1 New basic\n1 Academy Ruins\n1 Malakir Mire' });
    expect(plan.totalCopies).toBe(2);
    expect(plan.excludedBasicLands[0]).toMatchObject({ displayName: 'New basic', quantity: 1 });
    expect(plan.resolvedCards[0].selectionKey).toBe(printCardKey({ displayName: 'Academy Ruins' }));
    expect(plan.resolvedCards[0]).toMatchObject({ setCode: 'resolved', collectorNumber: '42', baseQuantity: 1 });
  });
  it.each([
    { excludedCards: 'not-array' }, { excludedCards: ['bad-key'] }, { excludedCards: ['["Island","",""]'] },
    { excludedCards: Array(1001).fill('["island","",""]') }, { additionalCardText: [] },
    { additionalCardText: '1 Sol Ring\n-1 Counterspell' }, { additionalCardText: 'x'.repeat(100001) },
    { additionalCardText: '251 Sol Ring' }, { excludeBasicLands: 'yes' },
  ])('rejects invalid edit options before image resolution: %j', async options => {
    await expect(buildPrintPlan(1, null, { cardText: '1 Lightning Bolt', ...options })).rejects.toThrow();
    expect(fetchCardImageUrls).not.toHaveBeenCalled();
  });
  it('shows exact selected faces and positive diff quantities without downloading images', async () => {
    const plan = publicPrintPlan(await buildPrintPlan(1, 1, { mode: 'changes' }));
    expect(plan).toMatchObject({ totalCopies: 2, ordinaryCopies: 1, doubleFacedCopies: 1, readyToGenerate: true });
    expect(plan.resolvedCards[1]).toMatchObject({ quantity: 1, isDFC: true, layout: 'modal_dfc', oracleId: 'oracle-id',
      faces: [{ face: 'front', name: 'Malakir Rebirth', identifier: 'printing-id', thumbnailUrl: 'front.jpg', status: 'ready' },
        { face: 'back', name: 'Malakir Mire', identifier: 'printing-id', thumbnailUrl: 'back.jpg', status: 'ready' }] });
    expect(plan.target.text).toBeUndefined();
    expect(plan.savedArtwork).toBeUndefined();
    expect(fetchCardImageUrls).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ displayName: 'Lightning Bolt', quantity: 1 })]), { allowIncomplete: true, signal: expect.any(AbortSignal) });
  });
  it('includes every whole-deck copy and ordinary split/adventure cards stay one-sided', async () => {
    target.deck_text = '2 Fire // Ice\n1 Bonecrusher Giant // Stomp';
    fetchCardImageUrls.mockImplementation(async cards => cards.map((card, index) => ({ ...resolved(card), layout: index ? 'adventure' : 'split', faceNames: card.displayName.split(' // ') })));
    const plan = await buildPrintPlan(1, 1);
    expect(plan).toMatchObject({ totalCopies: 3, ordinaryCopies: 3, doubleFacedCopies: 0, readyToGenerate: true });
    expect(plan.resolvedCards.every(card => card.faces.length === 1)).toBe(true);
  });
  it('retains unresolved rows and blocks generation instead of omitting requested cards', async () => {
    fetchCardImageUrls.mockImplementation(async cards => [resolved(cards[0]), { ...cards[1], imageUrls: null,
      lookupFailures: [{ face: 'card', reason: 'Card/printing not found on Scryfall' }] }]);
    const plan = await buildPrintPlan(1, 1);
    expect(plan).toMatchObject({ totalCopies: 3, readyToGenerate: false, ordinaryCopies: null, doubleFacedCopies: null });
    expect(plan.resolvedCards[1]).toMatchObject({ quantity: 1, isDFC: null, errors: ['Card/printing not found on Scryfall'] });
    expect(plan.missingArtwork[0]).toMatchObject({ displayName: 'Malakir Rebirth // Malakir Mire', quantity: 1, face: 'front' });
  });
  it('shows saved MPC fronts and missing backs before generation, using IDs rather than stored thumbnail URLs', async () => {
    deck.mpc_art_overrides = JSON.stringify([
      ['Lightning Bolt', { identifier: 'bolt-art-0123456789', thumbnailUrl: 'https://untrusted.invalid/other-art.png' }],
      ['Malakir Rebirth', { identifier: 'front-art-0123456789' }],
    ]);
    const plan = await buildPrintPlan(1, 1, { artSource: 'saved-mpc' });
    expect(plan.readyToGenerate).toBe(false);
    expect(plan.resolvedCards[0].faces[0]).toMatchObject({ identifier: 'bolt-art-0123456789', thumbnailUrl: '/api/mpc/thumbnail/bolt-art-0123456789', status: 'ready' });
    expect(plan.resolvedCards[1].faces[0].identifier).toBe('front-art-0123456789');
    expect(plan.missingArtwork).toEqual([expect.objectContaining({ face: 'back', name: 'Malakir Mire' })]);
    const firstHash = plan.planHash;
    deck.mpc_art_overrides = JSON.stringify([...JSON.parse(deck.mpc_art_overrides), ['Malakir Mire', { identifier: 'back-art-0123456789' }]]);
    const complete = await buildPrintPlan(1, 1, { artSource: 'saved-mpc' });
    expect(complete.readyToGenerate).toBe(true);
    expect(complete.planHash).not.toBe(firstHash);
  });
  it('blocks meld even when its front image and a saved choice exist', async () => {
    target.deck_text = '1 Bruna, the Fading Light';
    fetchCardImageUrls.mockImplementation(async cards => cards.map(card => ({ ...resolved(card), layout: 'meld' })));
    const plan = await buildPrintPlan(1, 1);
    expect(plan.readyToGenerate).toBe(false);
    expect(plan.ordinaryCopies).toBeNull();
    expect(plan.resolvedCards[0].errors[0]).toContain('Meld cards need a special paired back');
  });
  it('uses canonical front artwork when the requested deck line is a DFC back alias', async () => {
    target.deck_text = '1 Malakir Mire (ZNR) [111]';
    deck.mpc_art_overrides = JSON.stringify([
      ['Malakir Rebirth', { identifier: 'selected-front-image' }], ['Malakir Mire', { identifier: 'selected-back-image' }],
    ]);
    const plan = await buildPrintPlan(1, 1, { artSource: 'saved-mpc' });
    expect(plan.readyToGenerate).toBe(true);
    expect(plan.resolvedCards[0].faces.map(face => [face.name, face.identifier])).toEqual([
      ['Malakir Rebirth', 'selected-front-image'], ['Malakir Mire', 'selected-back-image'],
    ]);
  });
  it('changes the review hash when the resolved printing changes and rejects changes during lookup', async () => {
    const first = await buildPrintPlan(1, 1);
    fetchCardImageUrls.mockImplementation(async cards => cards.map(card => ({ ...resolved(card), scryfallId: 'new-printing-id' })));
    expect((await buildPrintPlan(1, 1)).planHash).not.toBe(first.planHash);
    fetchCardImageUrls.mockImplementation(async cards => { target = { ...target, deck_text: '1 Sol Ring' }; return cards.map(resolved); });
    await expect(buildPrintPlan(1, 1)).rejects.toThrow('changed during preview');
  });
  it('bounds all preview metadata work to 60 seconds and returns visible unresolved rows', async () => {
    vi.useFakeTimers();
    try {
      const real = await vi.importActual('./scryfallImages.js');
      fetchCardImageUrls.mockImplementation(real.fetchCardImageUrls);
      const transport = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
      vi.stubGlobal('fetch', transport);
      const pending = buildPrintPlan(1, 1);
      await vi.advanceTimersByTimeAsync(60_000);
      const plan = await pending;
      expect(transport).toHaveBeenCalledOnce();
      expect(plan.readyToGenerate).toBe(false);
      expect(plan.resolvedCards).toHaveLength(2);
      expect(plan.resolvedCards.every(card => card.errors[0].includes('exceeded 60 seconds'))).toBe(true);
      expect(plan.missingArtwork).toHaveLength(2);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
});
