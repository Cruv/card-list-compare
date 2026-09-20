import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  proposalReviewKey, proposalBasis, proposalBasisStale, newProposalDraft, mergeProposalDraft,
  readProposalDraft, saveProposalDraft, readPendingProposalReviews, savePendingProposalReview,
  settlePendingProposalReview, readRecoveredProposalTexts, isDefiniteProposalRejection, proposalReviewRequest,
} from './proposalReview';

function memoryStorage() {
  const entries = new Map();
  return {
    get length() { return entries.size; },
    key: index => [...entries.keys()][index] ?? null,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: key => entries.delete(key),
  };
}
const key = proposalReviewKey(1, 7);
const proposal = {
  proposalId: 'abf5206b-a25f-46ce-9471-f17ea9c32f10', proposalRevision: 3,
  status: 'pending_review', currentLatestSnapshotId: '8', currentLatestTextHash: 'hash8',
  baseSnapshotId: '8', baseText: '1 Sol Ring', proposedText: '4 Sol Ring',
  currentLatestText: '1 Sol Ring', createdAt: '2026-09-10T12:00:00.000Z',
};
const otherProposal = { ...proposal, proposalId: 'e7f8e42e-72b4-4018-a743-026e397c53c4', proposedText: '1 Island' };
const operation = {
  proposalId: proposal.proposalId,
  body: { operationId: 'e53e15e4-0424-48e7-aacb-85701acf1c71', expectedProposalRevision: 3,
    expectedLatestSnapshotId: '8', expectedLatestTextHash: 'hash8', action: 'revise', reviewedText: '  3 Sol Ring\n\n' },
};
const otherOperation = { proposalId: otherProposal.proposalId, body: { ...operation.body,
  operationId: '0711f770-9101-49eb-bba8-e2ea987f020e', reviewedText: '2 Island' } };
const receipt = { ...proposal, proposalRevision: 4, status: 'revised', reviewedText: operation.body.reviewedText };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
afterEach(() => vi.unstubAllGlobals());

describe('proposal drafts', () => {
  it('keeps exact independent drafts when switching proposals, decks, or accounts', () => {
    const storage = memoryStorage();
    const first = saveProposalDraft(storage, key, { ...newProposalDraft(proposal),
      replacement: operation.body.reviewedText, dirty: true });
    saveProposalDraft(storage, key, { ...newProposalDraft(otherProposal), replacement: '2 Island\n', dirty: true });
    expect(readProposalDraft(storage, key, proposal.proposalId)).toEqual(first);
    expect(readProposalDraft(storage, key, otherProposal.proposalId).replacement).toBe('2 Island\n');
    expect(readProposalDraft(storage, proposalReviewKey(2, 7), proposal.proposalId)).toBeNull();
    expect(readProposalDraft(storage, proposalReviewKey(1, 8), proposal.proposalId)).toBeNull();
    expect(first.replacement).toBe('  3 Sol Ring\n\n');
  });

  it('preserves edited text and its reviewed basis through refresh until explicit rebase', () => {
    const storage = memoryStorage();
    const draft = saveProposalDraft(storage, key, { ...newProposalDraft(proposal), replacement: '  3 Sol Ring\n\n', dirty: true });
    const current = { ...proposal, proposalRevision: 4, status: 'needs_rebase', currentLatestSnapshotId: '9', currentLatestTextHash: 'hash9' };
    const refreshed = mergeProposalDraft(readProposalDraft(storage, key, proposal.proposalId), current);
    expect(refreshed).toEqual(draft);
    expect(proposalBasisStale(refreshed.basis, current)).toBe(true);
    const rebased = saveProposalDraft(storage, key, { ...refreshed, basis: proposalBasis(current) });
    expect(rebased.replacement).toBe(draft.replacement);
    expect(proposalBasisStale(rebased.basis, current)).toBe(false);
    expect(mergeProposalDraft(newProposalDraft(proposal), current).basis).toEqual(proposalBasis(current));
  });

  it.each(['proposalRevision', 'status', 'currentLatestSnapshotId', 'currentLatestTextHash'])('requires review after %s changes', field => {
    expect(proposalBasisStale(proposalBasis(proposal), { ...proposal, [field]: 'changed' })).toBe(true);
  });

  it('does not replace another window’s saved draft with a stale editor revision', () => {
    const storage = memoryStorage();
    const original = saveProposalDraft(storage, key, { ...newProposalDraft(proposal), replacement: '2 Sol Ring', dirty: true });
    const newer = saveProposalDraft(storage, key, { ...original, replacement: '3 Sol Ring' });
    const stillOpen = { ...original, replacement: '4 Sol Ring', unsaved: true };
    expect(() => saveProposalDraft(storage, key, stillOpen)).toThrow('Another window changed');
    expect(readProposalDraft(storage, key, proposal.proposalId)).toEqual(newer);
    expect(stillOpen.replacement).toBe('4 Sol Ring');
  });

  it('leaves unreadable saved work intact and fails before replacing it', () => {
    const storage = memoryStorage();
    const storageKey = `${key}:draft:${proposal.proposalId}`;
    storage.setItem(storageKey, '{important broken draft');
    expect(() => saveProposalDraft(storage, key, newProposalDraft(proposal))).toThrow('could not be read');
    expect(storage.getItem(storageKey)).toBe('{important broken draft');
  });
});

describe('immutable proposal decision recovery', () => {
  it('keeps a legacy uncertain revision exact and blocks a second proposal from overwriting it', () => {
    const storage = memoryStorage();
    storage.setItem(key, JSON.stringify(operation));
    expect(readPendingProposalReviews(storage, key)).toEqual([operation]);
    expect(() => savePendingProposalReview(storage, key, otherOperation)).toThrow('awaiting confirmation');
    savePendingProposalReview(storage, key, operation);
    expect(readPendingProposalReviews(storage, key)).toEqual([operation]);
    expect(storage.getItem(key)).toBe(JSON.stringify(operation));
    expect(() => savePendingProposalReview(storage, key, { ...operation, body: { ...operation.body, reviewedText: 'new text' } })).toThrow('cannot be changed');
  });

  it('preserves both requests if two tabs race and settling one cannot clear the other', () => {
    const storage = memoryStorage();
    const setItem = storage.setItem;
    let racing = true;
    storage.setItem = (name, value) => {
      if (racing) {
        racing = false;
        // The other tab also passed its empty-pending check before our write.
        savePendingProposalReview(storage, key, otherOperation);
      }
      return setItem(name, value);
    };
    savePendingProposalReview(storage, key, operation);
    expect(readPendingProposalReviews(storage, key)).toEqual(expect.arrayContaining([operation, otherOperation]));
    expect(settlePendingProposalReview(storage, key, operation)).toBe(true);
    expect(readPendingProposalReviews(storage, key)).toEqual([otherOperation]);
    expect(settlePendingProposalReview(storage, key, operation)).toBe(false);
    expect(readRecoveredProposalTexts(storage, key)).toEqual([operation]);
    savePendingProposalReview(storage, key, otherOperation);
    expect(readPendingProposalReviews(storage, key)).toEqual([otherOperation]);
  });

  it('archives a legacy reviewed replacement before clearing its request without overwriting a newer draft', () => {
    const storage = memoryStorage();
    const newer = saveProposalDraft(storage, key, { ...newProposalDraft(proposal), replacement: '5 Sol Ring', dirty: true });
    storage.setItem(key, JSON.stringify(operation));
    expect(settlePendingProposalReview(storage, key, operation)).toBe(true);
    expect(readProposalDraft(storage, key, proposal.proposalId)).toEqual(newer);
    expect(readRecoveredProposalTexts(storage, key)[0].body.reviewedText).toBe('  3 Sol Ring\n\n');
    expect(readPendingProposalReviews(storage, key)).toEqual([]);
  });

  it('does not clear an uncertain request if preserving its reviewed text exceeds browser storage', () => {
    const storage = memoryStorage();
    savePendingProposalReview(storage, key, operation);
    storage.setItem = () => { throw new Error('Quota exceeded'); };
    expect(() => settlePendingProposalReview(storage, key, operation)).toThrow('Quota exceeded');
    expect(readPendingProposalReviews(storage, key)).toEqual([operation]);
  });

  it('settles without duplicating text already preserved in the proposal draft', () => {
    const storage = memoryStorage();
    saveProposalDraft(storage, key, { ...newProposalDraft(proposal), replacement: operation.body.reviewedText, dirty: true });
    savePendingProposalReview(storage, key, operation);
    expect(settlePendingProposalReview(storage, key, operation)).toBe(true);
    expect(readRecoveredProposalTexts(storage, key)).toEqual([]);
    expect(readProposalDraft(storage, key, proposal.proposalId).replacement).toBe(operation.body.reviewedText);
  });

  it('blocks decisions when another pending record is unreadable without deleting either record', () => {
    const storage = memoryStorage();
    savePendingProposalReview(storage, key, operation);
    storage.setItem(`${key}:operation:broken`, 'broken');
    expect(() => savePendingProposalReview(storage, key, otherOperation)).toThrow('could not be read');
    expect(() => settlePendingProposalReview(storage, key, operation)).toThrow('could not be read');
    expect(storage.getItem(`${key}:operation:${operation.body.operationId}`)).toBe(JSON.stringify(operation));
  });
});

describe('authenticated proposal dispatch and receipt recovery', () => {
  function signedIn() {
    const storage = memoryStorage();
    storage.setItem('clc-auth-token', 'account-one');
    savePendingProposalReview(storage, key, operation);
    vi.stubGlobal('localStorage', storage);
    return storage;
  }

  it('pins the verified token and sends the exact saved body after credentials rotate in another tab', async () => {
    const storage = signedIn();
    const fetcher = vi.fn().mockImplementationOnce(async () => {
      storage.setItem('clc-auth-token', 'account-two');
      return json({ user: { id: 1 } });
    }).mockResolvedValueOnce(json(receipt));
    vi.stubGlobal('fetch', fetcher);
    await expect(proposalReviewRequest(1, '7', operation)).resolves.toEqual(receipt);
    expect(fetcher.mock.calls.map(([, options]) => options.headers.Authorization)).toEqual(['Bearer account-one', 'Bearer account-one']);
    expect(fetcher.mock.calls[1][0]).toBe(`/api/decks/7/proposals/${proposal.proposalId}/review`);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(operation.body);
  });

  it.each([
    ['wrong account', { id: 2 }, () => true, () => true, 'account changed'],
    ['closed review', { id: 1 }, () => false, () => true, 'no longer open'],
    ['settled in another tab', { id: 1 }, () => true, () => false, 'changed in another window'],
  ])('does not POST when %s is detected before dispatch', async (_, user, active, dispatch, message) => {
    signedIn();
    const fetcher = vi.fn().mockResolvedValue(json({ user }));
    vi.stubGlobal('fetch', fetcher);
    await expect(proposalReviewRequest(1, '7', operation, active, dispatch)).rejects.toThrow(message);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['expired preflight', 401, 'unauthorized', true],
    ['forbidden preflight', 403, 'forbidden', true],
    ['expired POST', 401, 'unauthorized', false],
    ['forbidden POST', 403, 'forbidden', false],
    ['proxy conflict', 409, 'upstream_error', false],
    ['operation mismatch', 409, 'operation_conflict', false],
    ['missing proposal', 404, 'proposal_not_found', false],
    ['request timeout', 408, 'timeout', false],
    ['rate limit', 429, 'rate_limited', false],
    ['server error', 500, 'server_error', false],
  ])('preserves an uncertain original decision on %s', async (_, status, code, preflight) => {
    const storage = signedIn();
    const fetcher = vi.fn();
    if (!preflight) fetcher.mockResolvedValueOnce(json({ user: { id: 1 } }));
    fetcher.mockResolvedValueOnce(json({ error: code }, status));
    vi.stubGlobal('fetch', fetcher);
    let caught;
    try { await proposalReviewRequest(1, '7', operation); }
    catch (error) {
      caught = error;
      if (isDefiniteProposalRejection(error)) settlePendingProposalReview(storage, key, operation);
    }
    expect(caught.status).toBe(status);
    expect(isDefiniteProposalRejection(caught)).toBe(false);
    expect(readPendingProposalReviews(storage, key)).toEqual([operation]);
  });

  it.each(['proposal_changed', 'latest_changed', 'needs_rebase'])('settles an actual %s rejection while preserving exact reviewed text', async code => {
    const storage = signedIn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ user: { id: 1 } }))
      .mockResolvedValueOnce(json({ error: code }, 409)));
    try { await proposalReviewRequest(1, '7', operation); }
    catch (error) {
      expect(isDefiniteProposalRejection(error)).toBe(true);
      settlePendingProposalReview(storage, key, operation);
    }
    expect(readPendingProposalReviews(storage, key)).toEqual([]);
    expect(readRecoveredProposalTexts(storage, key)[0].body.reviewedText).toBe(operation.body.reviewedText);
  });

  it('does not treat a known rejection code from auth preflight as a decision receipt', async () => {
    signedIn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ error: 'latest_changed' }, 409)));
    await expect(proposalReviewRequest(1, '7', operation).catch(error => isDefiniteProposalRejection(error))).resolves.toBe(false);
  });

  it.each([{}, { ...receipt, proposalId: otherProposal.proposalId }, { ...receipt, reviewedText: 'different text' },
    { ...receipt, status: 'pending_review' }, { ...receipt, proposalRevision: 5 }])('retains the request when HTTP 200 does not confirm the exact decision: %j', async invalid => {
    const storage = signedIn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ user: { id: 1 } })).mockResolvedValueOnce(json(invalid)));
    await expect(proposalReviewRequest(1, '7', operation)).rejects.toThrow('incomplete decision receipt');
    expect(readPendingProposalReviews(storage, key)).toEqual([operation]);
  });

  it.each([{}, { proposals: [{}] }, { proposals: [{ ...proposal, status: null }] },
    { proposals: [{ ...proposal, currentLatestTextHash: undefined }] }])('rejects incomplete list data before rendering while preserving recovery: %j', async invalid => {
    const storage = signedIn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ user: { id: 1 } })).mockResolvedValueOnce(json(invalid)));
    await expect(proposalReviewRequest(1, '7')).rejects.toThrow('incomplete proposal status');
    expect(readPendingProposalReviews(storage, key)).toEqual([operation]);
  });

  it('recovers the exact original request after a lost response even when refreshed proposal status is terminal', async () => {
    const storage = signedIn();
    const fetcher = vi.fn().mockResolvedValueOnce(json({ user: { id: 1 } }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ user: { id: 1 } })).mockResolvedValueOnce(json({ proposals: [receipt] }))
      .mockResolvedValueOnce(json({ user: { id: 1 } })).mockResolvedValueOnce(json({ ...receipt, replayed: true }));
    vi.stubGlobal('fetch', fetcher);
    await expect(proposalReviewRequest(1, '7', operation)).rejects.toThrow('Failed to fetch');
    expect((await proposalReviewRequest(1, '7')).proposals[0].status).toBe('revised');
    const original = readPendingProposalReviews(storage, key)[0];
    expect((await proposalReviewRequest(1, '7', original)).replayed).toBe(true);
    expect(fetcher.mock.calls[1][1].body).toBe(fetcher.mock.calls[5][1].body);
    settlePendingProposalReview(storage, key, original);
    expect(readPendingProposalReviews(storage, key)).toEqual([]);
  });
});
