import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db.js', () => ({ get: vi.fn() }));
vi.mock('./scryfallImages.js', () => ({ fetchCardImageUrls: vi.fn() }));
import { get } from '../db.js';
import { fetchCardImageUrls } from './scryfallImages.js';
import { buildPrintPlan, publicPrintPlan, planPhysicalCopies } from './printQueuePlan.js';

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
