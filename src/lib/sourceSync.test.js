import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeSourceWork, newSourceWork, readSourceWork, saveSourceWork, settleSourceWork,
  sourceBatchFeedback, sourceRefreshFeedback, sourceReviewKey, sourceReviewStale, sourceSyncRequest, sourceTextDiff } from './sourceSync';

function memoryStorage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}
const basis = { revision: 3, currentSnapshotId: '8', currentTextHash: 'hash8', currentText: '  2 Sol Ring\n',
  baseText: '1 Sol Ring', sourceText: '4 Sol Ring', pending: true, status: 'pending_review' };
const operation = { operationId: 'e53e15e4-0424-48e7-aacb-85701acf1c71', expectedRevision: 3,
  expectedCurrentSnapshotId: '8', expectedCurrentTextHash: 'hash8', action: 'merge', reviewedText: '  3 Sol Ring\n\n' };
afterEach(() => vi.unstubAllGlobals());

describe('source review recovery', () => {
  it('keeps a frozen exact decision after a lost response even if the server is no longer pending', () => {
    const storage = memoryStorage(), key = sourceReviewKey(1, 7);
    const draft = { ...newSourceWork(basis), action: 'merge', mergedText: operation.reviewedText, dirty: true, operation };
    saveSourceWork(storage, key, draft);
    const restored = mergeSourceWork(readSourceWork(storage, key), { ...basis, revision: 4, pending: false });
    expect(restored.operation).toEqual(operation);
    expect(restored.mergedText).toBe('  3 Sol Ring\n\n');
    expect(restored.basis).toEqual(basis);
    expect(sourceReviewStale(restored.basis, { ...basis, revision: 4 })).toBe(true);
  });

  it('preserves unfinished merged text and review basis through polling while clean state follows the server', () => {
    const current = { ...basis, revision: 4, sourceText: '6 Sol Ring' };
    const dirty = { ...newSourceWork(basis), mergedText: '3 Sol Ring', dirty: true };
    expect(mergeSourceWork(dirty, current)).toBe(dirty);
    expect(mergeSourceWork(newSourceWork(basis), current).basis).toBe(current);
    expect(sourceReviewStale(basis, { ...basis, currentSnapshotId: '9' })).toBe(true);
    expect(sourceReviewStale(basis, { ...basis, currentTextHash: 'new-hash' })).toBe(true);
  });

  it('will not overwrite or clear another window’s pending decision', () => {
    const storage = memoryStorage(), key = sourceReviewKey(1, 7);
    const pending = { ...newSourceWork(basis), operation };
    saveSourceWork(storage, key, pending);
    expect(() => saveSourceWork(storage, key, newSourceWork(basis))).toThrow('awaiting confirmation');
    expect(settleSourceWork(storage, key, 'older-operation', newSourceWork(basis))).toBe(false);
    expect(readSourceWork(storage, key).operation).toEqual(operation);
    expect(settleSourceWork(storage, key, operation.operationId, newSourceWork(basis))).toBe(true);
    expect(readSourceWork(storage, key).operation).toBeNull();
  });

  it('isolates draft keys by account and deck and blocks unreadable recovery state', () => {
    const storage = memoryStorage();
    const key = sourceReviewKey(1, 7);
    saveSourceWork(storage, key, { ...newSourceWork(basis), operation });
    expect(readSourceWork(storage, sourceReviewKey(2, 7))).toBeNull();
    expect(readSourceWork(storage, sourceReviewKey(1, 8))).toBeNull();
    storage.setItem(key, JSON.stringify({ mergedText: 'important draft' }));
    expect(() => saveSourceWork(storage, key, newSourceWork(basis))).toThrow('could not be read');
    expect(storage.getItem(key)).toContain('important draft');
  });
});

describe('source review account and asynchronous dispatch guards', () => {
  it('uses the same verified token even if another tab rotates credentials during identity lookup', async () => {
    const storage = memoryStorage(); storage.setItem('clc-auth-token', 'account-one');
    vi.stubGlobal('localStorage', storage);
    const fetcher = vi.fn().mockImplementationOnce(async () => {
      storage.setItem('clc-auth-token', 'account-two');
      return new Response(JSON.stringify({ user: { id: 1 } }));
    }).mockResolvedValueOnce(new Response(JSON.stringify({ ...basis, pending: false })));
    vi.stubGlobal('fetch', fetcher);
    await sourceSyncRequest(1, '7', operation);
    expect(fetcher.mock.calls.map(([, options]) => options.headers.Authorization)).toEqual(['Bearer account-one', 'Bearer account-one']);
    expect(fetcher.mock.calls[1][0]).toBe('/api/decks/7/source-sync/review');
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(operation);
  });

  it('does not send a saved decision from the wrong account', async () => {
    const storage = memoryStorage(); storage.setItem('clc-auth-token', 'other-account');
    vi.stubGlobal('localStorage', storage);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { id: 2 } })));
    vi.stubGlobal('fetch', fetcher);
    await expect(sourceSyncRequest(1, '7', operation)).rejects.toThrow('account changed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch after the user closes the scoped review while identity is loading', async () => {
    const storage = memoryStorage(); storage.setItem('clc-auth-token', 'one');
    vi.stubGlobal('localStorage', storage);
    let active = true;
    const fetcher = vi.fn().mockImplementation(async () => {
      active = false;
      return new Response(JSON.stringify({ user: { id: 1 } }));
    });
    vi.stubGlobal('fetch', fetcher);
    await expect(sourceSyncRequest(1, '7', operation, () => active)).rejects.toThrow('no longer open');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('source review comparisons and refresh feedback', () => {
  it('compares card quantities, commander choices and sideboard without changing source text', () => {
    const diff = sourceTextDiff('1 Cloud, Ex-SOLDIER (Commander)\n2 Sol Ring\nSB: 1 Counterspell',
      '1 Tifa Lockhart (Commander)\n3 Sol Ring\nSB: 2 Counterspell');
    expect(diff.beforeCommanders).toEqual(['Cloud, Ex-SOLDIER']);
    expect(diff.afterCommanders).toEqual(['Tifa Lockhart']);
    expect(diff.mainboard.quantityChanges).toContainEqual(expect.objectContaining({ name: 'Sol Ring', oldQty: 2, newQty: 3 }));
    expect(diff.sideboard.quantityChanges).toContainEqual(expect.objectContaining({ name: 'Counterspell', oldQty: 1, newQty: 2 }));
    expect(sourceTextDiff(null, '1 Sol Ring')).toBeNull();
  });

  it('announces pending reviews instead of claiming refresh saved or synchronized a deck', () => {
    expect(sourceRefreshFeedback({ pendingReview: true, changed: false }).message).toContain('need review');
    const batch = sourceBatchFeedback({ summary: { updated: 0, unchanged: 2, errors: 0, pendingReview: 3 } });
    expect(batch.tone).toBe('info');
    expect(batch.message).toContain('3 need source review');
    expect(sourceBatchFeedback({ results: [{ changed: true }, { pendingReview: true }, { error: 'offline' }] })).toEqual({
      message: '1 deck updated, 1 need source review; current CLC decks preserved, 1 failed', tone: 'error',
    });
  });

  it('shows a foil-only source change as exact before and after quantities', () => {
    const diff = sourceTextDiff('1 Sol Ring (CMM) [396]', '1 Sol Ring (CMM) [396] *F*');
    expect(diff.exactRows).toHaveLength(2);
    expect(diff.exactRows).toContainEqual(expect.objectContaining({ name: 'Sol Ring', finish: 'nonfoil', beforeQuantity: 1, afterQuantity: 0 }));
    expect(diff.exactRows).toContainEqual(expect.objectContaining({ name: 'Sol Ring', finish: 'foil', beforeQuantity: 0, afterQuantity: 1 }));
  });

  it('preserves mixed finishes and different sets sharing collector numbers', () => {
    const diff = sourceTextDiff('2 Sol Ring (CMM) [396]\n1 Sol Ring (CMM) [396] *F*',
      '1 Sol Ring (CMM) [396]\n1 Sol Ring (CMM) [396] *F*\n1 Sol Ring (LTC) [396]');
    expect(diff.exactRows).toHaveLength(2);
    expect(diff.exactRows).toContainEqual(expect.objectContaining({ setCode: 'CMM', finish: 'nonfoil', beforeQuantity: 2, afterQuantity: 1 }));
    expect(diff.exactRows).toContainEqual(expect.objectContaining({ setCode: 'LTC', finish: 'nonfoil', beforeQuantity: 0, afterQuantity: 1 }));
    expect(diff.exactRows.some(row => row.finish === 'foil')).toBe(false);
  });

  it('shows commander and sideboard moves and aggregates only the same exact printing', () => {
    const diff = sourceTextDiff('1 Sol Ring (CMM) [396]\n1 Sol Ring (cmm) [396]',
      '1 Sol Ring (CMM) [396] (Commander)\nSB: 1 Sol Ring (CMM) [396]');
    expect(diff.exactRows).toHaveLength(3);
    expect(diff.exactRows).toContainEqual(expect.objectContaining({ section: 'mainboard', beforeQuantity: 2, afterQuantity: 0 }));
    expect(diff.exactRows).toContainEqual(expect.objectContaining({ section: 'commander', beforeQuantity: 0, afterQuantity: 1 }));
    expect(diff.exactRows).toContainEqual(expect.objectContaining({ section: 'sideboard', beforeQuantity: 0, afterQuantity: 1 }));
  });

  it('matches effective sideboard membership after a repeated mainboard header and blank line', () => {
    const before = '1 Sol Ring (CMM) [396]\n1 Island (DMU) [265]';
    const after = '1 Sol Ring (CMM) [396]\nMainboard\n\n1 Island (DMU) [265]';
    const diff = sourceTextDiff(before, after);
    expect(diff.exactRows).toHaveLength(2);
    expect(diff.exactRows).toContainEqual(expect.objectContaining({ name: 'Island', section: 'mainboard', beforeQuantity: 1, afterQuantity: 0 }));
    expect(diff.exactRows).toContainEqual(expect.objectContaining({ name: 'Island', section: 'sideboard', beforeQuantity: 0, afterQuantity: 1 }));
    expect(diff.sideboard.cardsIn).toContainEqual(expect.objectContaining({ name: 'Island', quantity: 1 }));
  });
});
