import { all, get } from '../db.js';
import { printError } from './printQueuePlan.js';
import { isDeferred, canCancelRemaining, hasPendingBacks, canCancelUnstartedBacks, workflowSummary } from './printWorkflow.js';
import { printCapabilities } from './printQueue.js';

const STATES = new Set(['all', 'preparing', 'ready', 'queued', 'claimed', 'submitting', 'submitted', 'awaiting_refeed', 'backs_pending', 'awaiting_paper_reset', 'uncertain', 'completed', 'failed', 'canceled', 'expired']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const number = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : 0;

export function canCancelHouseholdBatch(row) {
  return (row.station_id === 'household' || (row.station_id === null && (row.queue_requested || row.queued_at)))
    && (isDeferred(row) ? canCancelRemaining(row) : ['preparing', 'ready', 'queued', 'claimed'].includes(row.state)
      && JSON.parse(row.steps_json || '[]').every(step => step.state === 'pending'));
}

function publicProgress(raw) {
  const value = raw && JSON.parse(raw);
  if (value?.phase === 'images') return { phase: 'images', completed: number(value.downloaded) + number(value.cached), total: number(value.total) };
  if (value?.phase === 'generating') return { phase: 'generating', completed: number(value.completedSheets), total: number(value.totalSheets) };
  return null;
}

export function listPrintBatches(userId, query = {}, { deferredBacks = false } = {}) {
  const user = get('SELECT is_admin, suspended FROM users WHERE id = ?', [userId]);
  if (!user || user.suspended) throw printError('An active account is required', 403);
  const admin = !!user.is_admin;
  const canControl = printCapabilities(userId).canQueue;
  const state = query.state ?? 'all';
  if (typeof state !== 'string' || !STATES.has(state)) throw printError('Invalid print batch state');
  const order = query.order ?? 'queue';
  if (!['queue', 'newest'].includes(order)) throw printError('Invalid batch order');
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if ((query.limit !== undefined && (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit))) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw printError('Batch page size must be between 1 and 100');
  const clauses = ['1 = 1'], params = [];
  if (!admin) { clauses.push('p.user_id = ?'); params.push(userId); }
  if (state !== 'all') { clauses.push('p.state = ?'); params.push(state); }
  const totalCount = get(`SELECT COUNT(*) AS count FROM print_jobs p WHERE ${clauses.join(' AND ')}`, params).count;
  let cursorClause = '';
  const cursorParams = [];
  if (query.cursor !== undefined) {
    let cursor;
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!cursor || typeof cursor.sortAt !== 'string' || cursor.sortAt.length > 64 || !cursor.sortAt
        || typeof cursor.createdAt !== 'string' || cursor.createdAt.length > 64 || !cursor.createdAt
        || typeof cursor.id !== 'string' || !UUID.test(cursor.id) || cursor.state !== state || cursor.order !== order
        || !Number.isSafeInteger(cursor.rank) || cursor.rank < 0 || cursor.rank > 4) throw new Error();
    } catch { throw printError('Invalid print batch cursor; start again from the first page'); }
    const direction = order === 'queue' && cursor.rank <= 2 ? '>' : '<';
    cursorClause = `WHERE (sort_rank > ? OR (sort_rank = ? AND (sort_at ${direction} ? OR (sort_at = ? AND (created_at ${direction} ? OR (created_at = ? AND id ${direction} ?))))))`;
    cursorParams.push(cursor.rank, cursor.rank, cursor.sortAt, cursor.sortAt, cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const rank = order === 'newest' ? '0' : "CASE WHEN p.state IN ('claimed', 'submitting', 'submitted', 'awaiting_refeed', 'awaiting_paper_reset', 'uncertain') THEN 0 WHEN p.state = 'queued' THEN 1 WHEN p.state = 'preparing' THEN 2 WHEN p.state IN ('ready', 'backs_pending') THEN 3 ELSE 4 END";
  const sortAt = order === 'newest' ? 'p.created_at' : "CASE WHEN p.state IN ('claimed', 'submitting', 'submitted', 'awaiting_refeed', 'awaiting_paper_reset', 'uncertain', 'queued', 'preparing') THEN COALESCE(p.queued_at, p.created_at) ELSE p.created_at END";
  // Match claimPrintJob's queued_at, created_at, id ordering even when several
  // batches enter the queue in the same millisecond. Keep every key in cursors.
  const sort = order === 'newest' ? 'sort_at DESC, id DESC' : 'sort_rank ASC, CASE WHEN sort_rank <= 2 THEN sort_at END ASC, CASE WHEN sort_rank > 2 THEN sort_at END DESC, CASE WHEN sort_rank <= 2 THEN created_at END ASC, CASE WHEN sort_rank > 2 THEN created_at END DESC, CASE WHEN sort_rank <= 2 THEN id END ASC, CASE WHEN sort_rank > 2 THEN id END DESC';
  const rows = all(`SELECT * FROM (SELECT p.*, u.username AS requester_name, ${rank} AS sort_rank, ${sortAt} AS sort_at
    FROM print_jobs p LEFT JOIN users u ON u.id = p.user_id WHERE ${clauses.join(' AND ')})
    ${cursorClause} ORDER BY ${sort} LIMIT ?`, [...params, ...cursorParams, limit + 1]);
  const page = rows.slice(0, limit), last = page.at(-1);
  return { scope: admin ? 'all' : 'mine', totalCount,
    nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ sortAt: last.sort_at, createdAt: last.created_at, id: last.id, rank: last.sort_rank, state, order })).toString('base64url') : null,
    jobs: page.map(row => {
      const plan = JSON.parse(row.plan_json), manifest = row.manifest_json && JSON.parse(row.manifest_json), canOpen = row.user_id === userId;
      return { id: row.id, deckName: typeof plan.deckName === 'string' ? plan.deckName.slice(0, 200) : 'Card batch',
        totalCopies: number(plan.totalCopies), state: row.state, createdAt: row.created_at, updatedAt: row.updated_at,
        queueOnReady: !!row.queue_requested, sourceKind: row.tracked_deck_id === null ? 'list' : 'deck',
        canOpen, canCancel: canControl && (admin || canOpen) && (!!canCancelHouseholdBatch(row)
          || (deferredBacks === true && row.station_id === 'household' && canCancelRemaining(row))),
        canCancelBacks: canControl && (admin || canOpen) && (isDeferred(row) || canCancelUnstartedBacks(row)
          || (deferredBacks === true && row.station_id === 'household')) && hasPendingBacks(row) && !row.cancel_requested,
        canPrepareBacks: canControl && (admin || canOpen) && isDeferred(row) && row.state === 'backs_pending' && !row.back_request_json && !row.cancel_requested,
        ...workflowSummary(row),
        ...(canOpen ? { deckId: row.tracked_deck_id } : {}),
        ...(admin ? { requesterName: typeof row.requester_name === 'string' ? row.requester_name.slice(0, 120) : 'Deleted account' } : {}),
        progress: publicProgress(row.progress_json), artifactsCount: row.state === 'expired' ? 0 : Math.min(manifest?.artifacts?.length || 0, 37),
        error: !row.error ? null : row.state === 'uncertain' ? 'The submission needs review at the Mac.' : 'This batch reported an error. Its owner can open the batch for details.',
      };
    }),
  };
}
