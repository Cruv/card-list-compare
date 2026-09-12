/** Household station controls. No executable paths, printer options or arbitrary commands. */
import crypto from 'node:crypto';
import { all, get, runTransaction } from '../db.js';
import { printCapabilities, claimPrintJob, formatPrintJob, cancelPrintJob, assertStationArtifactCapacity } from './printQueue.js';
import { printError, sha256 } from './printQueuePlan.js';
import { discordSettings, discordTelemetry, sealDiscordUrl, openDiscordUrl } from './printStationNotifications.js';
import { canCancelHouseholdBatch } from './printBatchHistory.js';

const STATION = 'household';
export const STATION_ONLINE_MS = 20_000;
export const STATION_COMMAND_TTL_MS = 5 * 60_000;
const COMMANDS = new Set(['pause', 'unpause', 'resume', 'check_update', 'update', 'rollback']);
const UPDATE_COMMANDS = new Set(['check_update', 'update', 'rollback']);
const DISCORD_COMMANDS = new Set(['configure_discord', 'test_discord']);
const ADMIN_COMMANDS = new Set([...UPDATE_COMMANDS, ...DISCORD_COMMANDS]);
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
  return result.replace(/https:\/\/discord(?:app)?\.com\/api\/webhooks\/[^\s]+/gi, '[Discord webhook]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:token|password|secret|authorization|api[_-]?key)\s*[:=]\s*["']?[^\s,;"']+/gi, '[credential redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .replace(/\s+/g, ' ').slice(0, 240);
}

// Older companions send only ok/message. Recognize their exact uncertainty
// summaries without guessing what an unknown vendor warning actually means.
const LEGACY_UNKNOWN_HEALTH = new Set([
  'Printer check pending',
  'Printer status is unavailable',
  'Printer reports an unrecognized status; check the Mac printer queue',
  'Active print pass is not visible in CUPS; reconcile its receipt in CLC',
]);
function healthInput(value) {
  const health = object(value, 'health');
  const ok = bool(health.ok, 'health.ok');
  const summary = message(health.message);
  const known = health.known === undefined ? !LEGACY_UNKNOWN_HEALTH.has(summary) : bool(health.known, 'health.known');
  if (ok && !known) throw printError('Healthy printer status must be known');
  const advisories = health.advisories === undefined ? [] : health.advisories;
  if (!Array.isArray(advisories) || advisories.length > 8) throw printError('Health supports at most 8 advisories');
  return { ok, known, message: summary, advisories: [...new Set(advisories.map(item => message(item)))] };
}

function permissions(userId) {
  const user = get('SELECT is_admin, suspended FROM users WHERE id = ?', [userId]);
  const canControl = !!(user && !user.suspended && (user.is_admin || printCapabilities(userId).canQueue));
  return { canControl, canUpdate: !!(canControl && user.is_admin) };
}
function requireControl(userId, type) {
  const access = permissions(userId);
  if (!access.canControl || (ADMIN_COMMANDS.has(type) && !access.canUpdate)) throw printError('Station management is restricted to authorized household users; updates and Discord settings require an administrator', 403);
  return access;
}
function activeServerJob() {
  return get(`SELECT * FROM print_jobs WHERE station_id = ? AND state IN (${ACTIVE_STATES.map(() => '?').join(',')}) ORDER BY queued_at, created_at, id LIMIT 1`, [STATION, ...ACTIVE_STATES]);
}

function unsubmittedJob(row) {
  return ['preparing', 'ready', 'queued', 'claimed'].includes(row.state)
    && JSON.parse(row.steps_json || '[]').every(step => step.state === 'pending');
}

function householdPrintJobs(userId, canManage = false) {
  // This is the persisted CLC queue, separate from the Mac's latest heartbeat.
  // Do not expose formatPrintJob here: it includes private plan/artifact data.
  const summary = row => {
    const plan = JSON.parse(row.plan_json);
    const canOpen = row.user_id === userId;
    return { id: row.id, deckName: typeof plan.deckName === 'string' ? plan.deckName.slice(0, 200) : 'Card batch',
      totalCopies: Number.isSafeInteger(plan.totalCopies) ? plan.totalCopies : 0,
      state: row.state, createdAt: row.created_at, queuedAt: row.queued_at,
      completedAt: row.completed_at, canOpen, canCancel: canManage && !!canCancelHouseholdBatch(row),
      ...(canOpen ? { deckId: row.tracked_deck_id } : {}) };
  };
  const activePlaceholders = ACTIVE_STATES.map(() => '?').join(',');
  const pending = all(`SELECT * FROM print_jobs
    WHERE (station_id = ? AND state IN (${activePlaceholders}))
      OR (state = 'queued' AND (station_id IS NULL OR station_id = ?))
      OR (state = 'preparing' AND queue_requested = 1 AND (station_id IS NULL OR station_id = ?))
    ORDER BY CASE WHEN state IN (${activePlaceholders}) THEN 0 WHEN state = 'queued' THEN 1 ELSE 2 END,
      queued_at, created_at, id`, [STATION, ...ACTIVE_STATES, STATION, STATION, ...ACTIVE_STATES]).map(summary);
  const recent = all(`SELECT * FROM print_jobs
    WHERE state IN ('completed', 'failed', 'canceled', 'expired')
      AND (station_id = ? OR (station_id IS NULL AND (queue_requested = 1 OR queued_at IS NOT NULL)))
    ORDER BY COALESCE(completed_at, updated_at) DESC, created_at DESC, id DESC LIMIT 20`, [STATION]).map(summary);
  return { pending, recent };
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
    ...expired.map(row => discardSecret(row.id)).filter(Boolean),
    eventStatement('warning', 'A station command expired before acknowledgement'),
  ]);
}
function publicCommand(row) {
  const payload = JSON.parse(row.payload_json);
  return { id: row.id, idempotencyKey: row.request_key, type: payload.type,
    jobId: payload.jobId || null, artifactId: payload.artifactId || null,
    ...(payload.type === 'resume' ? { paperReloaded: true } : {}), targetVersion: payload.targetVersion || null,
    ...(DISCORD_COMMANDS.has(payload.type) ? { revision: payload.revision, ...(payload.type === 'configure_discord' ? { enabled: payload.enabled } : {}) } : {}),
    requesterId: row.requester_id, status: row.status, createdAt: row.created_at, expiresAt: row.expires_at,
    deliveredAt: row.delivered_at, acknowledgedAt: row.acknowledged_at, message: row.message };
}

function discardSecret(commandId) {
  const row = get('SELECT payload_json FROM print_station_commands WHERE id = ?', [commandId]);
  const payload = row && JSON.parse(row.payload_json);
  if (!payload?.secretCipher) return null;
  delete payload.secretCipher;
  return statement('UPDATE print_station_commands SET payload_json = ? WHERE id = ?', [JSON.stringify(payload), commandId]);
}
function stationCommand(row) {
  const command = publicCommand(row), payload = JSON.parse(row.payload_json);
  if (payload.type === 'configure_discord') {
    command.discord = discordSettings({ enabled: payload.enabled, userId: payload.userId,
      webhookUrl: payload.enabled ? openDiscordUrl(payload.secretCipher, row.id) : '' });
  }
  return command;
}

function activePacket(row, active) {
  if (!row?.manifest_json || sha256(row.manifest_json) !== row.manifest_sha256) return null;
  if (active.state === 'awaiting_refeed' && !active.artifactId) return null;
  const next = JSON.parse(row.steps_json || '[]').find(step => step.state !== 'completed');
  if (!next || (active.artifactId && active.artifactId !== next.artifactId)
    || (active.phase && active.phase !== next.phase)) return null;
  const artifacts = JSON.parse(row.manifest_json).artifacts || [];
  const packets = artifacts.filter(artifact => artifact.kind === 'dfc');
  const artifact = packets.find(item => item.id === next.artifactId);
  if (!artifact) return null;
  const packetIndex = artifact.packetIndex ?? packets.indexOf(artifact) + 1;
  const packetCount = artifact.packetCount ?? packets.length;
  if (![packetIndex, packetCount, artifact.sheetCount, artifact.cardCount].every(value => Number.isSafeInteger(value) && value > 0 && value <= 250)
    || packetIndex > packetCount) return null;
  return { artifactId: artifact.id,
    label: typeof artifact.label === 'string' && artifact.label.length <= 240 ? artifact.label : null,
    packetIndex, packetCount, sheetCount: artifact.sheetCount, cardCount: artifact.cardCount };
}

export function printStationStatus(userId) {
  const access = requireControl(userId);
  expireCommands();
  const live = online();
  const active = latest?.activeJob ? { ...latest.activeJob } : null;
  if (active) {
    if (active.state === 'awaiting_refeed') active.artifactId = firstBack(active.id, latest);
    const row = get('SELECT plan_json, manifest_json, manifest_sha256, steps_json FROM print_jobs WHERE id = ? AND station_id = ?', [active.id, STATION]);
    const deckName = row && JSON.parse(row.plan_json).deckName;
    if (typeof deckName === 'string') active.deckName = deckName.slice(0, 200);
    active.packet = activePacket(row, active);
  }
  return { station: {
    stationId: STATION, online: live, lastSeenAt: lastSeen === null ? null : new Date(lastSeen).toISOString(),
    version: latest?.version || null, paused: latest?.paused ?? !!get('SELECT paused FROM print_station_controls WHERE station_id = ?', [STATION])?.paused,
    queue: latest?.queue || null, recipeVerified: latest?.recipeVerified || false, duplexVerified: latest?.duplexVerified || false,
    testPrintingEnabled: latest?.testPrintingEnabled || false,
    recipeFingerprint: latest?.recipeFingerprint || null, activeJob: active,
    health: live ? latest.health : { ok: false, known: false, advisories: [], message: lastSeen === null ? 'Station has not connected since server startup' : 'Station is offline' },
    update: latest?.update || null, discord: latest?.discord || discordTelemetry(null),
  }, permissions: access, jobs: householdPrintJobs(userId, access.canUpdate),
  commands: all('SELECT * FROM print_station_commands WHERE station_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20', [STATION]).map(publicCommand),
  events: all('SELECT id, at, level, message FROM print_station_events ORDER BY received_at DESC, rowid DESC LIMIT 50') };
}

export function cancelHouseholdPrintJob(userId, jobId) {
  const access = requireControl(userId);
  if (!access.canUpdate) throw printError('Only an administrator can cancel household batches here', 403);
  if (!UUID.test(jobId)) throw printError('Invalid print batch ID');
  const row = get('SELECT * FROM print_jobs WHERE id = ?', [jobId]);
  if (!row || (row.station_id !== STATION && !(row.station_id === null && (row.queue_requested || row.queued_at)))) {
    throw printError('Household print batch not found', 404);
  }
  if (row.state === 'canceled') return printStationStatus(userId);
  if (!unsubmittedJob(row)) throw printError('This batch may have printed pages already. Check and cancel its submission at the Mac before reconciling it.', 409);
  // Keep the shared cancellation guard and abort any running PDF generation.
  // This does not send a native command or attempt to cancel a CUPS submission.
  cancelPrintJob(row.user_id, row.tracked_deck_id, row.id);
  commit([
    statement("UPDATE print_jobs SET station_id = ? WHERE id = ? AND state = 'canceled'", [STATION, row.id]),
    eventStatement('info', `Administrator canceled queued batch ${row.id}`),
  ]);
  return printStationStatus(userId);
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

export function createStationCommand(userId, body, notification = false) {
  const { key, payload } = notification ? notificationInput(body) : commandInput(body);
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
  if (UPDATE_COMMANDS.has(payload.type) && !latest.update?.supported) throw printError('Managed updates are not supported by this station installation', 409);
  if (['update', 'rollback'].includes(payload.type)) {
    if (latest.activeJob || activeServerJob() || ['updating', 'rollback', 'checking'].includes(latest.update.status)) throw printError('Wait until the station has finished its active job or update', 409);
    const expected = latest.update[payload.type === 'update' ? 'availableVersion' : 'previousVersion'];
    if (!expected || payload.targetVersion !== expected) throw printError('The requested update version is no longer available; refresh station status', 409);
  }
  if (DISCORD_COMMANDS.has(payload.type)) {
    if (!latest.discord?.supported) throw printError('Update the Mac companion to configure Discord notifications here', 409);
    if (payload.type === 'test_discord' && (!latest.discord.configured || payload.revision !== latest.discord.revision)) throw printError('Discord settings changed; refresh before requesting a test', 409);
    if (payload.type === 'test_discord' && get("SELECT id FROM print_station_commands WHERE station_id = ? AND json_extract(payload_json, '$.type') = 'test_discord' AND created_at > ?", [STATION, new Date(Date.now() - 30_000).toISOString()])) throw printError('Wait 30 seconds before requesting another Discord test', 429);
  }
  const commandId = crypto.randomUUID(), createdAt = timestamp();
  if (payload.type === 'configure_discord') {
    payload.revision = commandId;
    if (payload.enabled) payload.secretCipher = sealDiscordUrl(payload.webhookUrl, commandId);
    delete payload.webhookUrl;
  }
  commit([
    statement('INSERT INTO print_station_commands(id, station_id, requester_id, request_key, request_hash, payload_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [commandId, STATION, userId, key, hash, JSON.stringify(payload), createdAt, new Date(Date.now() + STATION_COMMAND_TTL_MS).toISOString()]),
    eventStatement('info', `Station command requested: ${payload.type}`),
  ]);
  return { command: publicCommand(get('SELECT * FROM print_station_commands WHERE id = ?', [commandId])) };
}

function notificationInput(body) {
  object(body, 'Discord settings');
  if (typeof body.idempotencyKey !== 'string' || !UUID.test(body.idempotencyKey)) throw printError('idempotencyKey must be a UUID');
  if (!DISCORD_COMMANDS.has(body.type)) throw printError('Unsupported Discord command');
  const allowed = new Set(['idempotencyKey', 'type', ...(body.type === 'configure_discord' ? ['enabled', 'webhookUrl', 'userId'] : ['revision'])]);
  if (Object.keys(body).some(key => !allowed.has(key))) throw printError('Unexpected Discord settings field');
  const payload = { type: body.type, ...(body.type === 'configure_discord' ? discordSettings(body) : { revision: body.revision === 'local' ? 'local' : id(body.revision, 'Discord settings revision') }) };
  return { key: body.idempotencyKey.toLowerCase(), payload };
}
export function createDiscordCommand(userId, body) {
  requireControl(userId, 'configure_discord');
  return createStationCommand(userId, body, true);
}
export function findStationCommand(userId, key) {
  requireControl(userId);
  if (typeof key !== 'string' || !UUID.test(key)) throw printError('Invalid request key');
  expireCommands();
  const row = get('SELECT * FROM print_station_commands WHERE requester_id = ? AND request_key = ?', [userId, key.toLowerCase()]);
  return { command: row ? publicCommand(row) : null };
}

function heartbeatInput(body) {
  object(body, 'heartbeat');
  const queue = text(body.queue, 'queue', 96);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(queue)) throw printError('Invalid queue name');
  if (typeof body.recipeFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(body.recipeFingerprint)) throw printError('Invalid recipe fingerprint');
  const health = healthInput(body.health);
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
    testPrintingEnabled: body.testPrintingEnabled === undefined ? false : bool(body.testPrintingEnabled, 'testPrintingEnabled'),
    recipeFingerprint: body.recipeFingerprint.toLowerCase(), activeJob,
    health, update, discord: discordTelemetry(body.discord) },
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
  if (UPDATE_COMMANDS.has(payload.type) && !snapshot.update?.supported) return 'Station no longer supports managed updates';
  if (DISCORD_COMMANDS.has(payload.type) && !snapshot.discord?.supported) return 'This companion does not support Discord settings';
  if (payload.type === 'test_discord' && (!snapshot.discord.configured || snapshot.discord.revision !== payload.revision)) return 'Discord settings changed before the test';
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
      ...(discardSecret(row.id) ? [discardSecret(row.id)] : []),
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
      const removal = discardSecret(row.id); if (removal) deliveryChanges.push(removal);
      continue;
    }
    if (!row.delivered_at) {
      row.delivered_at = timestamp();
      deliveryChanges.push(statement('UPDATE print_station_commands SET delivered_at = ? WHERE id = ?', [row.delivered_at, row.id]));
    }
    try { commands.push(stationCommand(row)); }
    catch {
      deliveryChanges.push(statement("UPDATE print_station_commands SET status = 'rejected', acknowledged_at = ?, message = ? WHERE id = ?", [timestamp(), 'Discord settings could not be decrypted; reconnect from Print Station', row.id]));
      const removal = discardSecret(row.id); if (removal) deliveryChanges.push(removal);
    }
  }
  commit(deliveryChanges);
  return { commands, acknowledgedCommandIds, serverTime: timestamp() };
}

/** Pause blocks only fresh claims; existing durable claims remain recoverable. */
export function claimForManagedStation(maxArtifacts = 8) {
  expireCommands();
  const paused = !!get('SELECT paused FROM print_station_controls WHERE station_id = ?', [STATION])?.paused;
  const pendingPause = get("SELECT id FROM print_station_commands WHERE station_id = ? AND status = 'pending' AND json_extract(payload_json, '$.type') = 'pause'", [STATION]);
  if (paused || pendingPause || (latest?.recipeVerified === false && latest?.testPrintingEnabled !== true)) {
    const active = activeServerJob();
    if (active) assertStationArtifactCapacity(active, maxArtifacts);
    return active ? formatPrintJob(active, true) : null;
  }
  return claimPrintJob({ maxArtifacts });
}
