import { randomUUID } from 'node:crypto';
import { get, all, run, transaction } from '../db.js';
import { latestSnapshot, textHash } from './structuredSnapshots.js';
import { pruneSnapshots } from './pruneSnapshots.js';
import { parse } from '../../src/lib/parser.js';
import { COMMANDER_HEADER } from '../../src/lib/constants.js';
import { validProposalText } from './proposalLimits.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const PENDING = ['pending_review', 'needs_rebase'];
const now = () => new Date().toISOString();

export class ProposalError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) { throw new ProposalError(status, code, message); }
const validText = validProposalText;
function validId(value) { return typeof value === 'string' && /^[1-9]\d*$/.test(value); }
function ownedDeck(userId, deckId) {
  const deck = get('SELECT * FROM tracked_decks WHERE id = ? AND user_id = ?', [deckId, userId]);
  if (!deck) fail(404, 'deck_not_found');
  return deck;
}
function ownedProposal(userId, deckId, proposalId) {
  ownedDeck(userId, deckId);
  const row = get('SELECT * FROM deck_proposals WHERE id = ? AND deck_id = ? AND user_id = ?', [proposalId, deckId, userId]);
  if (!row) fail(404, 'proposal_not_found');
  return row;
}
function latestMatches(latest, id, hash) {
  return (latest ? String(latest.id) : null) === id && (latest ? textHash(latest.deck_text) : null) === hash;
}
function basisAvailable(row, latest) {
  const base = get('SELECT * FROM deck_snapshots WHERE id = ? AND tracked_deck_id = ?', [row.base_snapshot_id, row.deck_id]);
  return !!base && textHash(base.deck_text) === row.base_text_hash && latestMatches(latest, row.base_snapshot_id, row.base_text_hash);
}

function updateReviewedCommanders(deckId, resultText, latestText) {
  const commanders = parse(resultText).commanders;
  const hasCommanderHeading = resultText.split(/\r?\n/).some(line => COMMANDER_HEADER.test(line));
  // Explicit reviewed commander information replaces the deck metadata, including
  // removal from a previously tagged latest or an explicitly empty command zone.
  // Untagged lists keep manually assigned commanders, as manual snapshots do.
  if (commanders.length || hasCommanderHeading || parse(latestText || '').commanders.length) {
    run('UPDATE tracked_decks SET commanders = ? WHERE id = ?', [JSON.stringify(commanders), deckId]);
  }
}

// Stale is sticky: even if a later deletion exposes the old snapshot again,
// the reviewer must explicitly consider the changed history.
function markStale(row, latest) {
  if (row.status === 'pending_review' && !basisAvailable(row, latest)) {
    run(`UPDATE deck_proposals SET status = 'needs_rebase', revision = revision + 1, updated_at = ? WHERE id = ?`, [now(), row.id]);
    return get('SELECT * FROM deck_proposals WHERE id = ?', [row.id]);
  }
  return row;
}

export function proposalReceipt(row, latest = latestSnapshot(row.deck_id)) {
  return { proposalId: row.id, operationId: row.operation_id, proposalRevision: row.revision,
    status: row.status, baseSnapshotId: row.base_snapshot_id, baseTextHash: row.base_text_hash,
    baseText: row.base_text, proposedText: row.proposed_text, reviewedText: row.reviewed_text,
    currentLatestSnapshotId: latest ? String(latest.id) : null,
    currentLatestTextHash: latest ? textHash(latest.deck_text) : null,
    currentLatestText: latest?.deck_text ?? null,
    resultSnapshotId: row.result_snapshot_id, resultTextHash: row.result_text_hash,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

export function submitProposal(userId, deckId, input) {
  ownedDeck(userId, deckId);
  const { operationId, baseSnapshotId, baseTextHash, baseText, proposedText } = input || {};
  const fields = ['operationId','baseSnapshotId','baseTextHash','baseText','proposedText'];
  const payloadHash = textHash(JSON.stringify({ deckId: String(deckId), operationId, baseSnapshotId, baseTextHash, baseText, proposedText }));
  // Check a saved operation before validating a changed body. Even changing its
  // base to text with a bad hash must conflict instead of becoming a new input.
  const prior = typeof operationId === 'string'
    ? get('SELECT * FROM deck_proposals WHERE user_id = ? AND deck_id = ? AND operation_id = ?', [userId,deckId,operationId]) : null;
  if (prior && (prior.payload_hash !== payloadHash || Object.keys(input).some(key => !fields.includes(key)))) {
    fail(409, 'operation_conflict');
  }
  if (typeof operationId !== 'string' || !UUID.test(operationId) || !validId(baseSnapshotId) ||
      typeof baseTextHash !== 'string' || !HASH.test(baseTextHash) || !validText(baseText) || !validText(proposedText) ||
      !proposedText.trim() || Object.keys(input).some(key => !fields.includes(key))) {
    fail(400, 'invalid_proposal');
  }
  if (textHash(baseText) !== baseTextHash) fail(400, 'base_hash_mismatch', 'The hash must match the exact saved base text.');
  return transaction(() => {
    const existing = get('SELECT * FROM deck_proposals WHERE user_id = ? AND deck_id = ? AND operation_id = ?', [userId, deckId, operationId]);
    if (existing) {
      if (existing.payload_hash !== payloadHash) fail(409, 'operation_conflict');
      const latest = latestSnapshot(deckId);
      return { replayed: true, receipt: proposalReceipt(markStale(existing, latest), latest) };
    }
    const base = get('SELECT * FROM deck_snapshots WHERE id = ? AND tracked_deck_id = ?', [baseSnapshotId, deckId]);
    if (base && textHash(base.deck_text) !== baseTextHash) fail(409, 'basis_changed', 'The supplied base differs from that saved snapshot.');
    const latest = latestSnapshot(deckId);
    const status = base && latestMatches(latest, baseSnapshotId, baseTextHash) ? 'pending_review' : 'needs_rebase';
    const id = randomUUID();
    const timestamp = now();
    run(`INSERT INTO deck_proposals (id,user_id,deck_id,operation_id,payload_hash,base_snapshot_id,base_text_hash,
      base_text,proposed_text,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id,userId,deckId,operationId,payloadHash,baseSnapshotId,baseTextHash,baseText,proposedText,status,timestamp,timestamp]);
    return { replayed: false, receipt: proposalReceipt(get('SELECT * FROM deck_proposals WHERE id = ?', [id]), latest) };
  });
}

export function readProposal(userId, deckId, proposalId) {
  const row = ownedProposal(userId, deckId, proposalId);
  return transaction(() => {
    const latest = latestSnapshot(deckId);
    return proposalReceipt(markStale(row, latest), latest);
  });
}

export function listProposals(userId, deckId) {
  ownedDeck(userId, deckId);
  return transaction(() => {
    const latest = latestSnapshot(deckId);
    return all('SELECT * FROM deck_proposals WHERE user_id = ? AND deck_id = ? ORDER BY created_at DESC, id DESC', [userId, deckId])
      .map(row => proposalReceipt(markStale(row, latest), latest));
  });
}

export function reviewProposal(userId, deckId, proposalId, input) {
  ownedProposal(userId, deckId, proposalId);
  const { operationId, expectedProposalRevision, expectedLatestSnapshotId, expectedLatestTextHash, action, reviewedText } = input || {};
  if (typeof operationId !== 'string' || !UUID.test(operationId) || !Number.isSafeInteger(expectedProposalRevision) || expectedProposalRevision < 1 ||
      !['accept','revise','reject'].includes(action) ||
      !(expectedLatestSnapshotId === null || validId(expectedLatestSnapshotId)) ||
      !(expectedLatestTextHash === null || (typeof expectedLatestTextHash === 'string' && HASH.test(expectedLatestTextHash))) ||
      (action === 'revise' ? !validText(reviewedText) || !reviewedText.trim() : reviewedText !== undefined) ||
      Object.keys(input).some(key => !['operationId','expectedProposalRevision','expectedLatestSnapshotId','expectedLatestTextHash','action','reviewedText'].includes(key))) {
    fail(400, 'invalid_review');
  }
  const payloadHash = textHash(JSON.stringify({ deckId: String(deckId), proposalId, operationId, expectedProposalRevision,
    expectedLatestSnapshotId, expectedLatestTextHash, action, reviewedText: reviewedText ?? null }));
  return transaction(() => {
    const previous = get('SELECT * FROM proposal_reviews WHERE user_id = ? AND operation_id = ?', [userId, operationId]);
    if (previous) {
      if (previous.payload_hash !== payloadHash) fail(409, 'operation_conflict');
      return { ...JSON.parse(previous.receipt), replayed: true };
    }
    const row = ownedProposal(userId, deckId, proposalId);
    if (row.revision !== expectedProposalRevision || !PENDING.includes(row.status)) fail(409, 'proposal_changed');
    const latest = latestSnapshot(deckId);
    if (!latestMatches(latest, expectedLatestSnapshotId, expectedLatestTextHash)) fail(409, 'latest_changed');
    if (action === 'accept' && (row.status === 'needs_rebase' || !basisAvailable(row, latest))) {
      fail(409, 'needs_rebase', 'The digital latest changed. Review all three texts and use Revise to commit explicitly reviewed text.');
    }
    let snapshotId = null;
    let resultHash = null;
    const resultText = action === 'revise' ? reviewedText : row.proposed_text;
    if (action !== 'reject') {
      const inserted = run(`INSERT INTO deck_snapshots (tracked_deck_id, deck_text, nickname, origin_proposal_id)
        VALUES (?, ?, ?, ?)`, [deckId, resultText, 'Reviewed ManaSync proposal', row.id]);
      snapshotId = String(inserted.lastInsertRowid);
      resultHash = textHash(resultText);
      updateReviewedCommanders(deckId, resultText, latest?.deck_text);
    }
    const status = { accept: 'accepted', revise: 'revised', reject: 'rejected' }[action];
    run(`UPDATE deck_proposals SET status = ?, revision = revision + 1, result_snapshot_id = ?, result_text_hash = ?,
      reviewed_text = ?, updated_at = ? WHERE id = ?`, [status, snapshotId, resultHash, action === 'revise' ? reviewedText : null, now(), row.id]);
    if (action !== 'reject') pruneSnapshots(deckId);
    const receipt = proposalReceipt(get('SELECT * FROM deck_proposals WHERE id = ?', [row.id]));
    run('INSERT INTO proposal_reviews (user_id,operation_id,proposal_id,payload_hash,receipt) VALUES (?,?,?,?,?)',
      [userId,operationId,row.id,payloadHash,JSON.stringify(receipt)]);
    return receipt;
  });
}
