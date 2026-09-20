/** Household station controls. No executable paths, printer options or arbitrary commands. */
import crypto from 'node:crypto';
import { all, get, runTransaction } from '../db.js';
import { printCapabilities, claimPrintJob, formatPrintJob } from './printQueue.js';
import { printError, sha256 } from './printQueuePlan.js';

const STATION = 'household';
export const STATION_ONLINE_MS = 20_000;
export const STATION_COMMAND_TTL_MS = 5 * 60_000;
const COMMANDS = new Set(['pause', 'unpause', 'resume', 'check_update', 'update', 'rollback']);
const ADMIN_COMMANDS = new Set(['check_update', 'update', 'rollback']);
const UPDATE_STATES = new Set(['unsupported', 'idle', 'checking', 'available', 'updating', 'rollback', 'failed']);
const ACTIVE_STATES = ['claimed', 'submitting', 'submitted', 'awaiting_refeed', 'uncertain'];
const LOCAL_STATES = new Set([...ACTIVE_STATES, 'active', 'intent', 'completed', 'failed', 'canceled']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const OPAQUE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
let latest = null;
let lastSeen = null;
const timestamp = () => new Date().toISOString();
const online = () => lastSeen !== null && Date.now() - lastSeen <= STATION_ONLINE_MS;
const statement = (sql, params = []) => ({ sql, params });

export function resetPrintStationManagement() { latest = null; lastSeen = null; }

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw printError(`${field} must be an object`);
  return value;
}
function bool(value, field) {
  if (typeof value !== 'boolean') throw printError(`${field} must be true or false`);
  return value;
}
function text(value, field, max, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || value.length > max || !value.trim()) throw printError(`${field} must be a nonempty string of at most ${max} characters`);
  return value.trim();
}
function id(value, field) {
  if (typeof value !== 'string' || !OPAQUE.test(value)) throw printError(`Invalid ${field}`);
  return value;
}
function artifactId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw printError('Invalid artifact ID');
  return value;
}
function version(value, nullable = false) {
  const result = text(value, 'version', 64, nullable);
  if (result !== null && !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(result)) throw printError('Invalid version');
  return result;
}
function message(value, nullable = false) {
  let result = text(value, 'message', 1000, nullable);
  if (result === null) return null;
  // Native code sends controlled summaries, never subprocess output. Redact
  // common credential forms again before persistence or browser exposure.
  for (const secret of [process.env.PRINT_STATION_TOKEN, process.env.JWT_SECRET]) {
    if (secret) result = result.split(secret).join('[redacted]');
  }
  result = Array.from(result, character => {
    const point = character.codePointAt(0);
    return point < 32 || point === 127 ? ' ' : character;
  }).join('');
  return result.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:token|password|secret|authorization|api[_-]?key)\s*[:=]\s*["']?[^\s,;"']+/gi, '[credential redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .replace(/\s+/g, ' ').slice(0, 240);
}

function permissions(userId) {
  const user = get('SELECT is_admin, suspended FROM users WHERE id = ?', [userId]);
  const canControl = !!(user && !user.suspended && (user.is_admin || printCapabilities(userId).canQueue));
  return { canControl, canUpdate: !!(canControl && user.is_admin) };
}
function requireControl(userId, type) {
  const access = permissions(userId);
  if (!access.canControl || (ADMIN_COMMANDS.has(type) && !access.canUpdate)) throw printError('Station management is restricted to authorized household users; updates require an administrator', 403);
  return access;
}
function activeServerJob() {
  return get(`SELECT * FROM print_jobs WHERE station_id = ? AND state IN (${ACTIVE_STATES.map(() => '?').join(',')}) ORDER BY queued_at, created_at, id LIMIT 1`, [STATION, ...ACTIVE_STATES]);
}
function firstBack(jobId, snapshot) {
  if (!snapshot?.activeJob || snapshot.activeJob.id !== jobId || snapshot.activeJob.state !== 'awaiting_refeed') return null;
  const row = get("SELECT steps_json FROM print_jobs WHERE id = ? AND station_id = ? AND state = 'awaiting_refeed'", [jobId, STATION]);
  if (!row) return null;
  const step = JSON.parse(row.steps_json).find(item => item.state !== 'completed');
  if (snapshot.activeJob.artifactId && snapshot.activeJob.artifactId !== step?.artifactId) return null;
  if (snapshot.activeJob.phase && snapshot.activeJob.phase !== 'backs') return null;
  return step?.phase === 'backs' && step.state === 'pending' && !step.refeedConfirmed ? step.artifactId : null;
}
function eventStatement(level, value) {
  const event = { id: crypto.randomUUID(), at: timestamp(), level, message: message(value) };
  return statement('INSERT INTO print_station_events(id, at, level, message, event_hash, received_at) VALUES (?, ?, ?, ?, ?, ?)',
    [event.id, event.at, event.level, event.message, sha256(JSON.stringify(event)), event.at]);
}
function commit(changes) {
  if (!changes.length) return;
  changes.push(statement('DELETE FROM print_station_events WHERE id NOT IN (SELECT id FROM print_station_events ORDER BY received_at DESC, rowid DESC LIMIT 200)'));
  runTransaction(changes);
}
function expireCommands() {
  const expired = all("SELECT id FROM print_station_commands WHERE station_id = ? AND status = 'pending' AND expires_at <= ?", [STATION, timestamp()]);
  if (!expired.length) return;
  commit([
    statement("UPDATE print_station_commands SET status = 'expired', message = ? WHERE station_id = ? AND status = 'pending' AND expires_at <= ?", ['Command expired before acknowledgement', STATION, timestamp()]),
    eventStatement('warning', 'A station command expired before acknowledgement'),
  ]);
}
function publicCommand(row) {
  const payload = JSON.parse(row.payload_json);
  return { id: row.id, idempotencyKey: row.request_key, type: payload.type,
    jobId: payload.jobId || null, artifactId: payload.artifactId || null,
    ...(payload.type === 'resume' ? { paperReloaded: true } : {}), targetVersion: payload.targetVersion || null,
    requesterId: row.requester_id, status: row.status, createdAt: row.created_at, expiresAt: row.expires_at,
    deliveredAt: row.delivered_at, acknowledgedAt: row.acknowledged_at, message: row.message };
}

export function printStationStatus(userId) {
  const access = requireControl(userId);
  expireCommands();
  const live = online();
  const active = latest?.activeJob ? { ...latest.activeJob } : null;
  if (active) {
    if (active.state === 'awaiting_refeed') active.artifactId = firstBack(active.id, latest);
    const row = get('SELECT plan_json FROM print_jobs WHERE id = ? AND station_id = ?', [active.id, STATION]);
    const deckName = row && JSON.parse(row.plan_json).deckName;
    if (typeof deckName === 'string') active.deckName = deckName.slice(0, 200);
  }
  return { station: {
    stationId: STATION, online: live, lastSeenAt: lastSeen === null ? null : new Date(lastSeen).toISOString(),
    version: latest?.version || null, paused: latest?.paused ?? !!get('SELECT paused FROM print_station_controls WHERE station_id = ?', [STATION])?.paused,
    queue: latest?.queue || null, recipeVerified: latest?.recipeVerified || false, duplexVerified: latest?.duplexVerified || false,
    recipeFingerprint: latest?.recipeFingerprint || null, activeJob: active,
    health: live ? latest.health : { ok: false, message: lastSeen === null ? 'Station has not connected since server startup' : 'Station is offline' },
    update: latest?.update || null,
  }, permissions: access,
  commands: all('SELECT * FROM print_station_commands WHERE station_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20', [STATION]).map(publicCommand),
  events: all('SELECT id, at, level, message FROM print_station_events ORDER BY received_at DESC, rowid DESC LIMIT 50') };
}

function commandInput(body) {
  object(body, 'command');
  if (typeof body.idempotencyKey !== 'string' || !UUID.test(body.idempotencyKey)) throw printError('idempotencyKey must be a UUID');
  if (!COMMANDS.has(body.type)) throw printError('Unsupported station command');
  const allowed = new Set(['idempotencyKey', 'type', ...(body.type === 'resume' ? ['jobId', 'artifactId', 'paperReloaded'] : []), ...(['update', 'rollback'].includes(body.type) ? ['targetVersion'] : [])]);
  if (Object.keys(body).some(key => !allowed.has(key))) throw printError('Unexpected station command field');
  const payload = { type: body.type };
  if (body.type === 'resume') {
    payload.jobId = id(body.jobId, 'job ID');
    payload.artifactId = artifactId(body.artifactId);
    if (body.paperReloaded !== true) throw printError('Confirm that this batch has been flipped and reloaded');
    payload.paperReloaded = true;
  }
  if (['update', 'rollback'].includes(body.type)) payload.targetVersion = version(body.targetVersion);
  return { key: body.idempotencyKey.toLowerCase(), payload };
}

export function createStationCommand(userId, body) {
  const { key, payload } = commandInput(body);
  requireControl(userId, payload.type);
  const hash = sha256(JSON.stringify(payload));
  const existing = get('SELECT * FROM print_station_commands WHERE requester_id = ? AND request_key = ?', [userId, key]);
  // A lost HTTP acknowledgement must remain retrievable after a refeed or update
  // changes eligibility. Never turn a retry into a second command.
  if (existing) {
    if (existing.request_hash !== hash) throw printError('This request key belongs to a different station command', 409);
    expireCommands();
    return { command: publicCommand(get('SELECT * FROM print_station_commands WHERE id = ?', [existing.id])) };
  }
  expireCommands();
  if (!online()) throw printError('The print station is offline', 409);
  if (get("SELECT id FROM print_station_commands WHERE station_id = ? AND status = 'pending'", [STATION])) throw printError('A station command is already awaiting acknowledgement', 409);
  if (payload.type === 'resume') {
    if (payload.artifactId !== firstBack(payload.jobId, latest) || latest.paused) throw printError('This station is not waiting for that paper refeed, or is paused', 409);
  }
  if (ADMIN_COMMANDS.has(payload.type) && !latest.update?.supported) throw printError('Managed updates are not supported by this station installation', 409);
  if (['update', 'rollback'].includes(payload.type)) {
    if (latest.activeJob || activeServerJob() || ['updating', 'rollback', 'checking'].includes(latest.update.status)) throw printError('Wait until the station has finished its active job or update', 409);
    const expected = latest.update[payload.type === 'update' ? 'availableVersion' : 'previousVersion'];
    if (!expected || payload.targetVersion !== expected) throw printError('The requested update version is no longer available; refresh station status', 409);
  }
  const commandId = crypto.randomUUID(), createdAt = timestamp();
  commit([
    statement('INSERT INTO print_station_commands(id, station_id, requester_id, request_key, request_hash, payload_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [commandId, STATION, userId, key, hash, JSON.stringify(payload), createdAt, new Date(Date.now() + STATION_COMMAND_TTL_MS).toISOString()]),
    eventStatement('info', `Station command requested: ${payload.type}`),
  ]);
  return { command: publicCommand(get('SELECT * FROM print_station_commands WHERE id = ?', [commandId])) };
}

function heartbeatInput(body) {
  object(body, 'heartbeat');
  const queue = text(body.queue, 'queue', 96);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(queue)) throw printError('Invalid queue name');
  if (typeof body.recipeFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(body.recipeFingerprint)) throw printError('Invalid recipe fingerprint');
  const health = object(body.health, 'health');
  let activeJob = null;
  if (body.activeJob !== null && body.activeJob !== undefined) {
    object(body.activeJob, 'activeJob');
    if (!LOCAL_STATES.has(body.activeJob.state)) throw printError('Invalid active job state');
    activeJob = { id: id(body.activeJob.id, 'active job ID'), state: body.activeJob.state };
    if (body.activeJob.artifactId !== null && body.activeJob.artifactId !== undefined) activeJob.artifactId = artifactId(body.activeJob.artifactId);
    if (body.activeJob.phase !== null && body.activeJob.phase !== undefined) {
      if (!['fronts', 'backs'].includes(body.activeJob.phase)) throw printError('Invalid active job phase');
      activeJob.phase = body.activeJob.phase;
    }
  }
  let update = null;
  if (body.update !== null && body.update !== undefined) {
    object(body.update, 'update');
    if (!UPDATE_STATES.has(body.update.status)) throw printError('Invalid update status');
    update = { supported: bool(body.update.supported, 'update.supported'),
      currentVersion: version(body.update.currentVersion, true), previousVersion: version(body.update.previousVersion, true),
      availableVersion: version(body.update.availableVersion, true), status: body.update.status, error: message(body.update.error, true) };
  }
  const events = body.events ?? [], receipts = body.receipts ?? [];
  if (!Array.isArray(events) || events.length > 50 || !Array.isArray(receipts) || receipts.length > 20) throw printError('Heartbeat supports at most 50 events and 20 receipts');
  const eventIds = new Set(), receiptIds = new Set();
  return { snapshot: { version: version(body.version), paused: bool(body.paused, 'paused'), queue,
    recipeVerified: bool(body.recipeVerified, 'recipeVerified'), duplexVerified: bool(body.duplexVerified, 'duplexVerified'),
    recipeFingerprint: body.recipeFingerprint.toLowerCase(), activeJob,
    health: { ok: bool(health.ok, 'health.ok'), message: message(health.message) }, update },
  events: events.map(event => {
    object(event, 'event'); const eventId = id(event.id, 'event ID');
    if (eventIds.has(eventId)) throw printError('Duplicate heartbeat event ID'); eventIds.add(eventId);
    if (!['info', 'warning', 'error'].includes(event.level)) throw printError('Invalid event level');
    if (typeof event.at !== 'string' || event.at.length > 40 || !Number.isFinite(Date.parse(event.at))) throw printError('Invalid event timestamp');
    return { id: eventId, at: new Date(event.at).toISOString(), level: event.level, message: message(event.message) };
  }), receipts: receipts.map(receipt => {
    object(receipt, 'receipt'); const commandId = id(receipt.commandId, 'command ID');
    if (receiptIds.has(commandId)) throw printError('Duplicate heartbeat receipt'); receiptIds.add(commandId);
    if (!['applied', 'rejected'].includes(receipt.status)) throw printError('Invalid command receipt status');
    return { commandId, status: receipt.status, message: message(receipt.message, true) };
  }) };
}

function invalidDelivery(row, snapshot) {
  const payload = JSON.parse(row.payload_json), access = permissions(row.requester_id);
  if (!access.canControl || (ADMIN_COMMANDS.has(payload.type) && !access.canUpdate)) return 'Requester is no longer authorized';
  if (payload.type === 'resume' && (snapshot.paused || firstBack(payload.jobId, snapshot) !== payload.artifactId)) return 'Paper refeed no longer matches the current batch';
  if (ADMIN_COMMANDS.has(payload.type) && !snapshot.update?.supported) return 'Station no longer supports managed updates';
  if (['update', 'rollback'].includes(payload.type)) {
    if (snapshot.activeJob || activeServerJob()) return 'Station acquired a physical job before the update';
    if (snapshot.update[payload.type === 'update' ? 'availableVersion' : 'previousVersion'] !== payload.targetVersion) return 'The requested version is no longer available';
  }
  return null;
}

export function stationManagementHeartbeat(body) {
  const input = heartbeatInput(body);
  expireCommands();
  const changes = [], acknowledgedCommandIds = [];
  for (const receipt of input.receipts) {
    const row = get('SELECT * FROM print_station_commands WHERE id = ? AND station_id = ?', [receipt.commandId, STATION]);
    if (!row || !row.delivered_at) throw printError('Unknown or undelivered command receipt', 409);
    const hash = sha256(JSON.stringify(receipt));
    if (row.receipt_hash && row.receipt_hash !== hash) throw printError('This command already has a different receipt', 409);
    if (!row.receipt_hash) {
      // Expiry stops delivery, not acknowledgement of an action that already
      // started. Updates may finish after their five-minute delivery deadline.
      changes.push(statement('UPDATE print_station_commands SET status = ?, acknowledged_at = ?, message = ?, receipt_hash = ? WHERE id = ?',
        [receipt.status, timestamp(), receipt.message, hash, row.id]),
      eventStatement(receipt.status === 'applied' ? 'info' : 'warning', `Station command ${JSON.parse(row.payload_json).type}: ${receipt.status}`));
    }
    acknowledgedCommandIds.push(row.id);
  }
  for (const event of input.events) {
    const hash = sha256(JSON.stringify(event)), existing = get('SELECT event_hash FROM print_station_events WHERE id = ?', [event.id]);
    if (existing && existing.event_hash !== hash) throw printError('This event ID already belongs to a different station event', 409);
    if (!existing) changes.push(statement('INSERT INTO print_station_events(id, at, level, message, event_hash, received_at) VALUES (?, ?, ?, ?, ?, ?)',
      [event.id, event.at, event.level, event.message, hash, timestamp()]));
  }
  const paused = get('SELECT paused FROM print_station_controls WHERE station_id = ?', [STATION]);
  if (!!paused?.paused !== input.snapshot.paused) changes.push(statement('UPDATE print_station_controls SET paused = ? WHERE station_id = ?', [input.snapshot.paused ? 1 : 0, STATION]));
  commit(changes);
  latest = input.snapshot; lastSeen = Date.now();
  const deliveryChanges = [], commands = [];
  for (const row of all("SELECT * FROM print_station_commands WHERE station_id = ? AND status = 'pending' ORDER BY created_at, id", [STATION])) {
    const invalid = invalidDelivery(row, latest);
    if (invalid) {
      deliveryChanges.push(statement("UPDATE print_station_commands SET status = 'rejected', acknowledged_at = ?, message = ? WHERE id = ?", [timestamp(), invalid, row.id]));
      continue;
    }
    if (!row.delivered_at) {
      row.delivered_at = timestamp();
      deliveryChanges.push(statement('UPDATE print_station_commands SET delivered_at = ? WHERE id = ?', [row.delivered_at, row.id]));
    }
    commands.push(publicCommand(row));
  }
  commit(deliveryChanges);
  return { commands, acknowledgedCommandIds, serverTime: timestamp() };
}

/** Pause blocks only fresh claims; existing durable claims remain recoverable. */
export function claimForManagedStation() {
  expireCommands();
  const paused = !!get('SELECT paused FROM print_station_controls WHERE station_id = ?', [STATION])?.paused;
  const pendingPause = get("SELECT id FROM print_station_commands WHERE station_id = ? AND status = 'pending' AND json_extract(payload_json, '$.type') = 'pause'", [STATION]);
  if (paused || pendingPause || latest?.recipeVerified === false) {
    const active = activeServerJob();
    return active ? formatPrintJob(active, true) : null;
  }
  return claimPrintJob();
}
