/** Durable queue announcements. The native station owns Discord credentials and delivery. */
import crypto from 'node:crypto';
import { all, get } from '../db.js';
import { printError } from './printQueuePlan.js';

const STATION = 'household';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const RECEIPT_STATUSES = new Set(['attempted', 'failed', 'disabled', 'ignored']);
const TERMINAL_STATES = new Set(['completed', 'canceled', 'failed', 'expired']);
const statement = (sql, params = []) => ({ sql, params });
const timestamp = () => new Date().toISOString();
function displayText(value, max, fallback) {
  if (typeof value !== 'string') return fallback;
  const cleaned = Array.from(value, character => {
    const code = character.codePointAt(0);
    return code < 32 || (code >= 127 && code <= 159) || (code >= 0xd800 && code <= 0xdfff) ? ' ' : character;
  }).join('').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, max).join('') || fallback;
}

// Include this statement in the same transaction that queues the PDF. A unique
// job identity prevents retries or later back-side reservations from announcing
// a second physical batch. Existing jobs are deliberately never backfilled.
export function queuedPrintNotificationStatement(row, queuedAt) {
  const plan = JSON.parse(row.plan_json);
  const label = displayText(plan.deckName, 200, 'Card batch');
  const requester = displayText(plan.requesterName, 120,
    displayText(get('SELECT username FROM users WHERE id = ?', [row.user_id])?.username, 120, 'Unknown requester'));
  if (!Number.isSafeInteger(plan.totalCopies) || plan.totalCopies < 1 || plan.totalCopies > 250) throw printError('Invalid queued print copy count', 500);
  return statement(`INSERT OR IGNORE INTO print_queue_notifications
    (id, job_id, station_id, deck_name, requester_name, total_copies, queued_at)
    SELECT ?, id, ?, ?, ?, ?, ? FROM print_jobs WHERE id = ? AND state = 'queued' AND queued_at = ?`,
  [crypto.randomUUID(), STATION, label, requester, plan.totalCopies, queuedAt, row.id, queuedAt]);
}

export function queueNotificationInput(body) {
  if (body.queueNotifications !== undefined && typeof body.queueNotifications !== 'boolean') throw printError('queueNotifications must be true or false');
  const supported = body.queueNotifications === true;
  const receipts = body.queueNotificationReceipts === undefined ? [] : body.queueNotificationReceipts;
  if (!Array.isArray(receipts) || receipts.length > 20) throw printError('Heartbeat supports at most 20 queue notification receipts');
  if (receipts.length && !supported) throw printError('Queue notification receipts require queueNotifications support');
  const ids = new Set();
  return { supported, receipts: receipts.map(receipt => {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || !UUID.test(receipt.id)
      || Object.keys(receipt).some(key => !['id', 'status'].includes(key))) throw printError('Invalid queue notification receipt');
    if (!RECEIPT_STATUSES.has(receipt.status)) throw printError('Invalid queue notification receipt status');
    if (ids.has(receipt.id)) throw printError('Duplicate queue notification receipt');
    ids.add(receipt.id);
    return { id: receipt.id, status: receipt.status };
  }) };
}

// A restored server backup may predate delivery even though the native ledger
// still has its attempted receipt. Quarantine that row as ignored and preserve
// any existing terminal outcome; optional notices must never wedge controls or
// printing. Unknown IDs are acknowledged without recreating deleted job data.
export function queueNotificationReceiptChanges(input) {
  const changes = [], acknowledgedIds = [];
  for (const receipt of input.receipts) {
    const row = get('SELECT * FROM print_queue_notifications WHERE id = ? AND station_id = ?', [receipt.id, STATION]);
    if (row) {
      if (!row.status) changes.push(statement('UPDATE print_queue_notifications SET status = ?, acknowledged_at = ? WHERE id = ?',
        [row.delivered_at ? receipt.status : 'ignored', timestamp(), row.id]));
    }
    acknowledgedIds.push(receipt.id);
  }
  return { changes, acknowledgedIds };
}

export function queueNotificationDelivery() {
  const changes = [], notifications = [];
  for (const row of all(`SELECT n.*, j.state AS job_state FROM print_queue_notifications n
    JOIN print_jobs j ON j.id = n.job_id WHERE n.station_id = ? AND n.status IS NULL
    ORDER BY n.queued_at, n.id`, [STATION])) {
    if (!row.delivered_at && TERMINAL_STATES.has(row.job_state)) {
      changes.push(statement("UPDATE print_queue_notifications SET status = 'ignored', acknowledged_at = ? WHERE id = ?", [timestamp(), row.id]));
      continue;
    }
    if (!row.delivered_at) changes.push(statement('UPDATE print_queue_notifications SET delivered_at = ? WHERE id = ?', [timestamp(), row.id]));
    notifications.push({ id: row.id, jobId: row.job_id, deckName: row.deck_name, requesterName: row.requester_name, totalCopies: row.total_copies, queuedAt: row.queued_at });
    break;
  }
  return { changes, notifications };
}
