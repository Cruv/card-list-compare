import { integrationApi } from './integrationApi';
import { createOperationId } from './operationId';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const proposalReviewKey = (userId, deckId) => `clc-proposal-review:${userId}:${deckId}`;
const draftKey = (key, proposalId) => `${key}:draft:${proposalId}`;
const operationKey = (key, operationId) => `${key}:operation:${operationId}`;
const unreadable = () => new Error('Saved proposal work could not be read. Keep this browser data and retry before making another decision.');
const validProposal = value => value && UUID.test(value.proposalId) &&
  Number.isSafeInteger(value.proposalRevision) && value.proposalRevision > 0 &&
  ['pending_review', 'needs_rebase', 'accepted', 'revised', 'rejected'].includes(value.status) &&
  typeof value.baseSnapshotId === 'string' && typeof value.baseText === 'string' &&
  typeof value.proposedText === 'string' && Number.isFinite(Date.parse(value.createdAt)) &&
  (value.currentLatestSnapshotId === null || typeof value.currentLatestSnapshotId === 'string') &&
  (value.currentLatestTextHash === null || typeof value.currentLatestTextHash === 'string') &&
  (value.currentLatestText === null || typeof value.currentLatestText === 'string');

export function proposalBasis(proposal) {
  return { proposalRevision: proposal.proposalRevision, status: proposal.status,
    currentLatestSnapshotId: proposal.currentLatestSnapshotId, currentLatestTextHash: proposal.currentLatestTextHash };
}

export function proposalBasisStale(basis, current) {
  return !!basis && !!current && Object.keys(proposalBasis(current)).some(key => basis[key] !== current[key]);
}

export function newProposalDraft(proposal) {
  return { proposalId: proposal.proposalId, basis: proposalBasis(proposal),
    replacement: proposal.proposedText, dirty: false, revision: null };
}

export function mergeProposalDraft(draft, current) {
  return draft?.dirty ? draft : { ...newProposalDraft(current), revision: draft?.revision ?? null };
}

export function readProposalDraft(storage, key, proposalId) {
  const raw = storage.getItem(draftKey(key, proposalId));
  if (raw === null) return null;
  let value;
  try { value = JSON.parse(raw); } catch { throw unreadable(); }
  if (!value || value.proposalId !== proposalId || typeof value.replacement !== 'string' ||
      !value.basis || !Number.isInteger(value.basis.proposalRevision) ||
      typeof value.dirty !== 'boolean' || typeof value.revision !== 'string') throw unreadable();
  return value;
}

export function saveProposalDraft(storage, key, draft) {
  const previous = readProposalDraft(storage, key, draft.proposalId);
  if ((previous?.revision ?? null) !== draft.revision) {
    throw new Error('Another window changed this proposal draft. Your text remains open here; copy it before reopening the saved draft.');
  }
  const saved = { proposalId: draft.proposalId, basis: draft.basis, replacement: draft.replacement,
    dirty: draft.dirty, revision: createOperationId() };
  storage.setItem(draftKey(key, draft.proposalId), JSON.stringify(saved));
  return saved;
}

function validateOperation(value) {
  const body = value?.body;
  if (!value || typeof value.proposalId !== 'string' || !UUID.test(value.proposalId) ||
      !body || typeof body.operationId !== 'string' || !UUID.test(body.operationId) ||
      !Number.isInteger(body.expectedProposalRevision) ||
      !['accept', 'revise', 'reject'].includes(body.action) ||
      (body.action === 'revise' && typeof body.reviewedText !== 'string')) throw unreadable();
  return value;
}

export function readPendingProposalReviews(storage, key) {
  const values = [];
  const legacy = storage.getItem(key);
  if (legacy !== null) values.push(legacy);
  const prefix = `${key}:operation:`;
  for (let index = 0; index < storage.length; index += 1) {
    const name = storage.key(index);
    if (name?.startsWith(prefix)) values.push(storage.getItem(name));
  }
  const operations = new Map();
  for (const raw of values) {
    let value;
    try { value = validateOperation(JSON.parse(raw)); } catch { throw unreadable(); }
    const previous = operations.get(value.body.operationId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw unreadable();
    operations.set(value.body.operationId, value);
  }
  return [...operations.values()];
}

export function savePendingProposalReview(storage, key, operation) {
  validateOperation(operation);
  const pending = readPendingProposalReviews(storage, key);
  const same = pending.find(item => item.body.operationId === operation.body.operationId);
  if (same && JSON.stringify(same) !== JSON.stringify(operation)) throw new Error('The saved review request cannot be changed. Retry its original decision.');
  if (!same && pending.length) throw new Error('Another proposal decision is awaiting confirmation. Recover the saved decision before starting another.');
  // Separate immutable records also preserve both intents if tabs race between
  // the check and write. Server version pins arbitrate; neither tab loses its retry.
  storage.setItem(operationKey(key, operation.body.operationId), JSON.stringify(operation));
  return operation;
}

export function settlePendingProposalReview(storage, key, operation) {
  const pending = readPendingProposalReviews(storage, key);
  const same = pending.find(item => item.body.operationId === operation.body.operationId);
  if (!same || JSON.stringify(same) !== JSON.stringify(operation)) return false;
  // Keep the reviewed replacement recoverable even for a rejected legacy request.
  // This is separate from the user's potentially newer draft of the same proposal.
  if (operation.body.action === 'revise' && readProposalDraft(storage, key, operation.proposalId)?.replacement !== operation.body.reviewedText) {
    storage.setItem(`${key}:reviewed:${operation.body.operationId}`, JSON.stringify(operation));
  }
  const legacy = storage.getItem(key);
  if (legacy && JSON.parse(legacy).body.operationId === operation.body.operationId) storage.removeItem(key);
  storage.removeItem(operationKey(key, operation.body.operationId));
  return true;
}

export function readRecoveredProposalTexts(storage, key) {
  const values = [];
  const prefix = `${key}:reviewed:`;
  for (let index = 0; index < storage.length; index += 1) {
    const name = storage.key(index);
    if (!name?.startsWith(prefix)) continue;
    try { values.push(validateOperation(JSON.parse(storage.getItem(name)))); }
    catch { throw unreadable(); }
  }
  return values;
}

export function isDefiniteProposalRejection(error) {
  // Authentication, proxies, missing proposals, or a conflicting operation ID
  // cannot establish whether an earlier attempt committed. Keep those retries.
  return error.reviewRequest === true && (
    (error.status === 400 && error.code === 'invalid_review') ||
    (error.status === 409 && ['proposal_changed', 'latest_changed', 'needs_rebase'].includes(error.code))
  );
}

export async function proposalReviewRequest(userId, deckId, operation, isActive = () => true, canDispatch = () => true) {
  const token = localStorage.getItem('clc-auth-token');
  if (!token) throw new Error('Sign in to review this deck.');
  const headers = { Authorization: `Bearer ${token}` };
  const identity = await integrationApi('/auth/me', { headers });
  if (String(identity.user?.id) !== String(userId)) throw new Error('The signed-in CLC account changed. Reopen the deck in the correct account.');
  if (!isActive()) throw new Error('This proposal review is no longer open.');
  if (!canDispatch()) throw new Error('The saved decision changed in another window. Refresh before continuing.');
  const root = `/decks/${encodeURIComponent(deckId)}/proposals`;
  if (!operation) {
    const data = await integrationApi(root, { headers });
    if (!Array.isArray(data.proposals) || !data.proposals.every(validProposal)) {
      throw new Error('The server returned incomplete proposal status.');
    }
    return data;
  }
  let receipt;
  try {
    receipt = await integrationApi(`${root}/${encodeURIComponent(operation.proposalId)}/review`, {
      headers, method: 'POST', body: JSON.stringify(operation.body),
    });
  } catch (error) {
    error.reviewRequest = true;
    throw error;
  }
  const expectedStatus = { accept: 'accepted', revise: 'revised', reject: 'rejected' }[operation.body.action];
  if (!validProposal(receipt) || receipt.proposalId !== operation.proposalId || receipt.status !== expectedStatus ||
      receipt.proposalRevision !== operation.body.expectedProposalRevision + 1 ||
      typeof receipt.baseText !== 'string' || typeof receipt.proposedText !== 'string' ||
      (operation.body.action === 'revise' && receipt.reviewedText !== operation.body.reviewedText)) {
    throw new Error('The server returned an incomplete decision receipt.');
  }
  return receipt;
}
