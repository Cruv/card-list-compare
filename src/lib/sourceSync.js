import { integrationApi } from './integrationApi';
import { parse, parseLine } from './parser';
import { computeDiff } from './differ';
import { deckBridgeLines } from './deckBridgeLines';
import { COMMANDER_HEADER, MAINBOARD_HEADER, SIDEBOARD_HEADER } from './constants';

export const sourceReviewKey = (userId, deckId) => `clc-source-review:${userId}:${deckId}`;
export const sourceStatusLabel = status => ({
  synced: 'Up to date with Archidekt',
  local_changes: 'Local edits protected',
  pending_review: 'Archidekt changes need review',
  unknown: 'Archidekt source not checked',
}[status] || 'Archidekt source not checked');

export function sourceRefreshFeedback(result) {
  if (result.pendingReview) return { message: result.message || 'Archidekt changes need review. Your current CLC deck was preserved.', tone: 'info' };
  if (result.changed) return { message: result.message || 'New snapshot saved!', tone: 'success' };
  return { message: result.message || 'No changes detected.', tone: 'info' };
}

export function sourceReviewStale(basis, current) {
  return !!basis && !!current && (basis.revision !== current.revision ||
    basis.currentSnapshotId !== current.currentSnapshotId || basis.currentTextHash !== current.currentTextHash);
}
export function sourceBatchFeedback({ summary = {}, results = [] }) {
  const updated = summary.updated ?? summary.changed ?? results.filter(result => result.changed).length;
  const failed = summary.errors ?? summary.failed ?? results.filter(result => result.error).length;
  const pending = summary.pendingReview ?? results.filter(result => result.pendingReview).length;
  if (!updated && !failed && !pending) return { message: 'No new Archidekt changes found.', tone: 'info' };
  return { message: [
    `${updated} deck${updated === 1 ? '' : 's'} updated`,
    ...(pending ? [`${pending} need source review; current CLC decks preserved`] : []),
    ...(failed ? [`${failed} failed`] : []),
  ].join(', '), tone: failed ? 'error' : pending ? 'info' : 'success' };
}
export function newSourceWork(state) {
  return { basis: state, mergedText: state.currentText ?? '', action: 'keep', dirty: false, operation: null };
}
export function mergeSourceWork(work, current) {
  return work?.dirty || work?.operation ? work : newSourceWork(current);
}
export function sourceTextDiff(before, after) {
  if (before === null || after === null) return null;
  const left = parse(before), right = parse(after);
  const exactRows = exactSourceRows(before, after);
  return { ...computeDiff(left, right), beforeCommanders: left.commanders || [], afterCommanders: right.commanders || [],
    exactRows, textChanged: before !== after };
}

// Source decisions must display finish and set changes that the legacy
// name/collector comparison intentionally merges. Keep each printing separate.
function exactSourceRows(before, after) {
  const beforeLines = sourceLines(before);
  const afterLines = sourceLines(after);
  if (!beforeLines || !afterLines) return null;
  const rows = new Map();
  for (const [side, entries] of [['beforeQuantity', beforeLines], ['afterQuantity', afterLines]]) {
    for (const entry of entries) {
      const card = entry.card;
      const key = JSON.stringify([entry.section, card.name.toLowerCase(), card.setCode.toLowerCase(), card.collectorNumber.toLowerCase(), card.finish]);
      const row = rows.get(key) ?? { key, section: entry.section, ...card, beforeQuantity: 0, afterQuantity: 0 };
      row[side] += entry.quantity;
      rows.set(key, row);
    }
  }
  return [...rows.values()].filter(row => row.beforeQuantity !== row.afterQuantity)
    .sort((a, b) => a.section.localeCompare(b.section) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

function sourceLines(text) {
  if (!text.trim()) return [];
  const entries = deckBridgeLines(text);
  if (!entries) return null;
  // The comparison parser counts all preceding content in a board, including
  // before repeated headers. Its blank separator semantics must also govern
  // where these exact printing rows appear in the reviewed deck.
  let target = 'mainboard', seen = false, explicitSideboard = false;
  const content = { mainboard: 0, sideboard: 0, commander: 0 };
  const lines = text.split(/\r?\n/);
  const effectiveSections = lines.map(line => {
    const trimmed = line.trim();
    if (COMMANDER_HEADER.test(trimmed)) target = 'commander';
    else if (SIDEBOARD_HEADER.test(trimmed)) { target = 'sideboard'; explicitSideboard = true; }
    else if (MAINBOARD_HEADER.test(trimmed)) target = 'mainboard';
    else if (!trimmed) {
      if (seen && !explicitSideboard && target === 'mainboard' && content.mainboard) target = 'sideboard';
      else if (target === 'commander' && content.commander) target = 'mainboard';
    } else { seen = true; content[target]++; }
    return target;
  });
  return entries.map(entry => {
    const lineIndex = Number(entry.key.split(':').at(-1)) - 1;
    const parsed = parseLine(lines[lineIndex]);
    const effective = effectiveSections[lineIndex];
    const section = parsed?.isSB ? 'sideboard' : parsed?.isCommander ?
      (effective === 'sideboard' ? 'sideboard (Commander tag)' : 'commander') : effective;
    return { ...entry, section };
  });
}
export function readSourceWork(storage, key) {
  const raw = storage.getItem(key);
  if (!raw) return null;
  const work = JSON.parse(raw);
  if (!work || typeof work.mergedText !== 'string' || !work.basis || !Number.isInteger(work.basis.revision) ||
      !['keep', 'source', 'merge'].includes(work.action))
    throw new Error('Saved source review could not be read. Keep this browser data and retry before starting another review.');
  return work;
}
export function saveSourceWork(storage, key, work) {
  const existing = readSourceWork(storage, key);
  if (existing?.operation && existing.operation.operationId !== work.operation?.operationId)
    throw new Error('Another source decision is awaiting confirmation. Reload source status to recover it.');
  storage.setItem(key, JSON.stringify(work));
}
export function settleSourceWork(storage, key, operationId, work) {
  const existing = readSourceWork(storage, key);
  if (existing?.operation?.operationId !== operationId) return false;
  storage.setItem(key, JSON.stringify(work));
  return true;
}

export async function sourceSyncRequest(userId, deckId, body, isActive = () => true) {
  // Capture a single credential for the identity check and request. Another tab
  // replacing localStorage must not redirect a prepared decision to its account.
  const token = localStorage.getItem('clc-auth-token');
  if (!token) throw new Error('Sign in to review this deck.');
  const headers = { Authorization: `Bearer ${token}` };
  const identity = await integrationApi('/auth/me', { headers });
  if (String(identity.user?.id) !== String(userId)) throw new Error('The signed-in CLC account changed. Reopen this deck in the correct account.');
  if (!isActive()) throw new Error('This source review is no longer open.');
  return integrationApi(`/decks/${encodeURIComponent(deckId)}/source-sync${body ? '/review' : ''}`, {
    headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
}
