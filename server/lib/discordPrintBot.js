/** Signed Discord interactions. The bot token is used only during command registration. */
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { all, get, run, runTransaction } from '../db.js';
import { createStationCommand, printStationStatus } from './printStationManagement.js';
import { printError } from './printQueuePlan.js';
import { DISCORD_PRINT_SETTINGS_KEY as SETTINGS_KEY, discordPrintRequestKey } from './discordPrintCommandAuthorization.js';

const SNOWFLAKE = /^[1-9][0-9]{0,19}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_CLOCK_SKEW_SECONDS = 300;
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(value).digest('hex');
const statement = (sql, params = []) => ({ sql, params });

export function initDiscordPrintBotSchema() {
  run(`CREATE TABLE IF NOT EXISTS discord_print_interactions (
    interaction_id TEXT PRIMARY KEY, application_id TEXT NOT NULL, settings_revision TEXT NOT NULL,
    requester_id INTEGER NOT NULL, command_request_key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT,
    created_at TEXT NOT NULL, completed_at TEXT
  )`);
  if (!all('PRAGMA table_info(discord_print_interactions)').some(column => column.name === 'command_request_key')) {
    const rows = all('SELECT interaction_id FROM discord_print_interactions');
    runTransaction([statement('ALTER TABLE discord_print_interactions ADD COLUMN command_request_key TEXT'),
      ...rows.map(row => statement('UPDATE discord_print_interactions SET command_request_key = ? WHERE interaction_id = ?', [discordPrintRequestKey(row.interaction_id), row.interaction_id]))]);
  }
  run('CREATE INDEX IF NOT EXISTS idx_discord_print_command_key ON discord_print_interactions(command_request_key, requester_id)');
}

function requireAdmin(userId) {
  const user = get('SELECT id, username, is_admin, suspended FROM users WHERE id = ?', [userId]);
  if (!user?.is_admin || user.suspended) throw printError('Discord printer commands require an active CLC administrator', 403);
  return user;
}

function snowflake(value, label) {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value) || BigInt(value) >= 2n ** 64n) throw printError(`${label} must be a valid numeric Discord ID`);
  return value;
}

function storedSettings() {
  const row = get('SELECT value FROM server_settings WHERE key = ?', [SETTINGS_KEY]);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function revokeUndeliveredCommands(settings) {
  if (!settings) return [];
  // Include unfinished intents: a crash can leave a station command committed
  // before its interaction response is recorded. Deriving the original key
  // identifies that command without retaining a Discord token or payload.
  return all('SELECT interaction_id, requester_id FROM discord_print_interactions WHERE application_id = ? AND settings_revision = ?', [settings.applicationId, settings.revision])
    .map(row => statement("UPDATE print_station_commands SET status = 'rejected', message = ? WHERE station_id = 'household' AND requester_id = ? AND request_key = ? AND status = 'pending' AND delivered_at IS NULL",
      ['Discord command connection changed before this request reached the Mac', row.requester_id, discordPrintRequestKey(row.interaction_id)]));
}

function endpointUrl() {
  try {
    const url = new URL(process.env.APP_URL || 'http://localhost:8080');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid origin');
    return `${url.origin}/api/discord/interactions`;
  } catch { return null; }
}

export function discordPrintBotSettings(userId) {
  const admin = requireAdmin(userId), settings = storedSettings();
  const operator = settings && get('SELECT username, is_admin, suspended FROM users WHERE id = ?', [settings.clcUserId]);
  return { configured: !!settings, endpointUrl: endpointUrl(), developerPortalUrl: 'https://discord.com/developers/applications',
    currentAdmin: { id: admin.id, username: admin.username },
    ...(settings ? { ...settings, operatorActive: !!(operator?.is_admin && !operator.suspended), operatorName: operator?.username || 'Deleted account',
      inviteUrl: `https://discord.com/oauth2/authorize?client_id=${settings.applicationId}&scope=applications.commands&integration_type=0&guild_id=${settings.guildId}&disable_guild_select=true` } : {}) };
}

export function saveDiscordPrintBotSettings(userId, body) {
  requireAdmin(userId);
  const allowed = new Set(['applicationId', 'publicKey', 'guildId', 'channelId', 'operatorDiscordId']);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.has(key))) throw printError('Unexpected Discord command settings field');
  if (typeof body.publicKey !== 'string' || !/^[a-f0-9]{64}$/i.test(body.publicKey) || /^0+$/.test(body.publicKey)) throw printError('Discord public key must be 64 hexadecimal characters from General Information');
  const settings = { applicationId: snowflake(body.applicationId, 'Application ID'), publicKey: body.publicKey.toLowerCase(),
    guildId: snowflake(body.guildId, 'Server ID'), channelId: snowflake(body.channelId, 'Channel ID'),
    operatorDiscordId: snowflake(body.operatorDiscordId, 'Operator user ID'), clcUserId: userId, revision: randomUUID(), registeredAt: null, updatedAt: now() };
  runTransaction([...revokeUndeliveredCommands(storedSettings()),
    statement('INSERT OR REPLACE INTO server_settings(key, value, updated_at) VALUES (?, ?, ?)', [SETTINGS_KEY, JSON.stringify(settings), settings.updatedAt])]);
  return discordPrintBotSettings(userId);
}

export function disconnectDiscordPrintBot(userId) {
  requireAdmin(userId);
  runTransaction([...revokeUndeliveredCommands(storedSettings()), statement('DELETE FROM server_settings WHERE key = ?', [SETTINGS_KEY])]);
  return discordPrintBotSettings(userId);
}

export const DISCORD_PRINT_COMMAND = {
  name: 'proxy', type: 1, description: 'Check CLC printing or continue a batch after fixing the printer',
  default_member_permissions: null,
  options: [
    { name: 'status', type: 1, description: 'Show printer status and recovery instructions', options: [
      { name: 'batch', type: 3, description: 'Exact CLC batch ID from the alert', required: false, min_length: 36, max_length: 36 },
    ] },
    { name: 'continue', type: 1, description: 'Confirm the printer issue is fixed and correct paper is loaded; continue this batch', options: [
      { name: 'batch', type: 3, description: 'Exact CLC batch ID from the alert', required: true, min_length: 36, max_length: 36 },
      { name: 'sheet', type: 4, description: 'First unprinted sheet position in this interrupted attempt, starting at 1', required: false, min_value: 1, max_value: 1000 },
    ] },
  ],
};

export async function registerDiscordPrintBotCommands(userId, body, { fetchImpl = fetch } = {}) {
  requireAdmin(userId);
  const settings = storedSettings();
  if (!settings) throw printError('Save the Discord application settings first', 409);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'botToken')
    || typeof body.botToken !== 'string' || !/^[A-Za-z0-9_.-]{20,256}$/.test(body.botToken)) throw printError('Enter the bot token from the Discord Developer Portal');
  let response;
  try {
    // POST upserts only our named command. Bulk PUT would remove other commands.
    response = await fetchImpl(`https://discord.com/api/v10/applications/${settings.applicationId}/guilds/${settings.guildId}/commands`, {
      method: 'POST', headers: { Authorization: `Bot ${body.botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(DISCORD_PRINT_COMMAND), signal: AbortSignal.timeout(5000), redirect: 'error',
    });
  } catch { throw printError('Discord registration could not be confirmed. The token was not stored; retry registration after checking the connection.', 502); }
  // Never return a provider response: it can contain credentials or request text.
  if (!response.ok) throw printError(response.status === 401 ? 'Discord rejected the bot token. Check the application and token.'
    : response.status === 403 ? 'Discord denied registration. Install this application in the selected server first.'
      : 'Discord command registration failed. Check the application and server IDs, then retry.', 502);
  requireAdmin(userId);
  const current = storedSettings();
  if (current?.revision !== settings.revision) throw printError('Discord settings changed during registration. Register the current configuration again.', 409);
  current.registeredAt = now();
  run('UPDATE server_settings SET value = ?, updated_at = ? WHERE key = ?', [JSON.stringify(current), now(), SETTINGS_KEY]);
  return discordPrintBotSettings(userId);
}

export function verifyDiscordPrintSignature(rawBody, signature, timestamp, settings = storedSettings()) {
  if (!settings || !Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !/^[a-f0-9]{128}$/i.test(signature)
    || typeof timestamp !== 'string' || !/^[0-9]{1,12}$/.test(timestamp)
    || Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(settings.publicKey, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), key, Buffer.from(signature, 'hex'));
  } catch { return false; }
}

function safeText(value, max = 220) {
  return Array.from(String(value || ''), character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127 ? ' ' : character).join('')
    .replace(/@/g, '@\u200b').replace(/[<>{}`*_~|\\]/g, '').slice(0, max);
}
const reply = content => ({ type: 4, data: { content: content.slice(0, 1900), flags: 64, allowed_mentions: { parse: [], users: [], roles: [], replied_user: false } } });

function parseCommand(data) {
  if (data?.name !== 'proxy' || data.type !== 1 || !Array.isArray(data.options) || data.options.length !== 1) throw printError('Use /proxy status or /proxy continue with an exact batch ID');
  const subcommand = data.options[0];
  if (!['status', 'continue'].includes(subcommand.name) || subcommand.type !== 1) throw printError('Unsupported printer command');
  const options = subcommand.options || [];
  if (!Array.isArray(options) || options.length > 2) throw printError('Unexpected printer command option');
  const parsed = { action: subcommand.name };
  for (const option of options) {
    if (option.name === 'batch' && option.type === 3 && parsed.batch === undefined && typeof option.value === 'string' && UUID.test(option.value)) parsed.batch = option.value.toLowerCase();
    else if (subcommand.name === 'continue' && option.name === 'sheet' && option.type === 4 && parsed.sheet === undefined && Number.isSafeInteger(option.value) && option.value >= 1 && option.value <= 1000) parsed.sheet = option.value;
    else throw printError('Use the exact batch UUID and a valid sheet number');
  }
  if (parsed.action === 'continue' && !parsed.batch) throw printError('Continuing requires the exact batch ID from the alert');
  return parsed;
}

function batchSummary(userId, batchId) {
  const status = printStationStatus(userId);
  const active = status.station?.activeJob;
  const jobs = [...(status.jobs?.pending || []), ...(status.jobs?.recent || []), ...(status.jobs?.deferred || [])];
  const batch = batchId && jobs.find(job => job.id === batchId);
  if (batchId && !batch && active?.id !== batchId) throw printError('That batch is not in the current station history. Open Printer in CLC to find it.', 404);
  const lines = [`Printer: ${safeText(status.station?.queue || 'Household printer')}`, `Station: ${status.station?.online ? status.station.paused ? 'paused' : 'online' : 'offline'}`,
    `Health: ${safeText(status.station?.health?.message || 'Status unavailable')}`];
  const selected = batch || (!batchId && active);
  if (selected) lines.push(`Batch: ${safeText(selected.deckName || active?.deckName || 'Print batch')} · ${selected.id}`, `State: ${safeText(selected.state)}`);
  if (active && (!batchId || active.id === batchId)) {
    if (active.artifactId) lines.push(`Packet: ${safeText(active.artifactId)} · pass: ${safeText(active.phase)}`);
    const recovery = active.recovery;
    if (recovery) {
      lines.push(recovery.mode === 'reprint_remaining' ? 'The spooler canceled this pass. Check which sheets printed before continuing.' : 'The spooler retained this pass. Fix the printer issue and load the correct paper before continuing.');
      if (Array.isArray(recovery.physicalPages)) {
        const preview = recovery.physicalPages.slice(0, 35).map((page, index) => `${index + 1} → ${page}`).join(', ');
        lines.push(`Print order for this interrupted attempt (position → PDF page number): ${preview}${recovery.physicalPages.length > 35 ? ' … (full order in Printer in CLC)' : ''}`);
        lines.push(`Sheets in this attempt: ${recovery.totalSheets}. The sheet option is a position in this attempt, starting at 1; it is not a PDF page number.`);
      }
      lines.push(active.phase === 'backs' ? 'Back-side recovery: open Printer in CLC to check and reload the matching front sheets.'
        : `/proxy continue batch:${active.id}${recovery.mode === 'reprint_remaining' ? ' sheet:<first unprinted position in this attempt>' : ''}`);
    }
  }
  return { status, content: lines.join('\n') };
}

function execute(userId, parsed, interactionId) {
  const { status, content } = batchSummary(userId, parsed.batch);
  if (parsed.action === 'status') return reply(`Yo, here's where we're at.\n\n${content}`);
  const active = status.station?.activeJob, recovery = active?.recovery;
  if (active?.id !== parsed.batch || !recovery) throw printError('This exact batch is not waiting for printer recovery. Check /proxy status or open Printer in CLC.', 409);
  if (recovery.phase === 'backs') throw printError('Back-side recovery requires checking and reloading the matching front sheets. Open Printer in CLC and confirm the paper there.', 409);
  if (recovery.mode === 'reprint_remaining' && parsed.sheet === undefined) throw printError('This pass was canceled. Check the physical sheet order with /proxy status, then provide sheet:<first unprinted sheet position, starting at 1>.', 409);
  if (recovery.mode === 'resume' && parsed.sheet !== undefined) throw printError('The spooler still has this pass. Leave off the sheet option to resume its existing job.', 409);
  const result = createStationCommand(userId, { idempotencyKey: discordPrintRequestKey(interactionId), type: 'recover_print', jobId: parsed.batch,
    artifactId: recovery.artifactId, phase: recovery.phase, spoolerId: recovery.spoolerId,
    recoveryId: recovery.recoveryId, paperReady: true, ...(parsed.sheet === undefined ? {} : { firstUnprintedSheet: parsed.sheet }) });
  return reply(`All right, let's get back to work.\n\nRecovery request queued for ${safeText(active.deckName || 'Print batch')} · ${parsed.batch}.\nRequest: ${result.command.id}\nThe Mac will check the exact spooler state before continuing. This confirms the request, not that printing has completed.`);
}

export function handleDiscordPrintInteraction(rawBody, signature, timestamp) {
  const settings = storedSettings();
  if (!verifyDiscordPrintSignature(rawBody, signature, timestamp, settings)) throw printError('Invalid Discord signature', 401);
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { throw printError('Invalid Discord JSON', 400); }
  if (payload.application_id !== settings.applicationId) throw printError('Unexpected Discord application', 401);
  if (payload.type === 1) return { type: 1 };
  if (payload.type !== 2) return reply('Use /proxy status or /proxy continue.');
  if (payload.guild_id !== settings.guildId || payload.channel_id !== settings.channelId || payload.member?.user?.id !== settings.operatorDiscordId || payload.user
    || (payload.context !== undefined && payload.context !== 0)) return reply('Printer commands are restricted to the configured operator and server channel.');
  try { requireAdmin(settings.clcUserId); } catch { return reply('The linked CLC administrator is no longer authorized. Update the printer command connection in CLC.'); }
  snowflake(payload.id, 'Interaction ID');
  let parsed;
  try { parsed = parseCommand(payload.data); } catch (error) { return reply(safeText(error.message, 1000)); }
  // Store no Discord token or raw message/payload. Exact IDs/semantic inputs are
  // hashed, and a durable intent precedes every station mutation.
  const hash = digest(JSON.stringify(parsed));
  const existing = get('SELECT * FROM discord_print_interactions WHERE interaction_id = ?', [payload.id]);
  if (existing) {
    if (existing.application_id !== settings.applicationId || existing.settings_revision !== settings.revision || existing.requester_id !== settings.clcUserId || existing.request_hash !== hash) return reply('This interaction ID was already used. Send a new /proxy status command.');
    return existing.response_json ? JSON.parse(existing.response_json) : reply('This request was already received, but its result is not confirmed. Check /proxy status and Recent requests in CLC before sending another continue command.');
  }
  run('INSERT INTO discord_print_interactions(interaction_id, application_id, settings_revision, requester_id, command_request_key, request_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [payload.id, settings.applicationId, settings.revision, settings.clcUserId, discordPrintRequestKey(payload.id), hash, now()]);
  let response;
  try { response = execute(settings.clcUserId, parsed, payload.id); }
  catch (error) { response = reply(error.status ? safeText(error.message, 1300) : 'Printer recovery could not be confirmed. Check Printer in CLC before sending another command.'); }
  runTransaction([
    statement('UPDATE discord_print_interactions SET response_json = ?, completed_at = ? WHERE interaction_id = ?', [JSON.stringify(response), now(), payload.id]),
    statement("DELETE FROM discord_print_interactions WHERE created_at < ? AND completed_at IS NOT NULL", [new Date(Date.now() - 7 * 86400_000).toISOString()]),
  ]);
  return response;
}
