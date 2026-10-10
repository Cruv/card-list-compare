import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import express from 'express';

let dir, db, bot, server, origin, privateKey, config, tokens, management;
let nextInteractionId = 0n;
const instant = Date.UTC(2026, 9, 10, 15);
const batchId = '7acd98db-0771-4bf1-be3a-2f4b4d109f14';
const tokenFixture = 'registration.fixture.token-do-not-store';
const adminHeaders = token => ({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });
function recoveryStatus(extra = {}) {
  return { station: { online: true, paused: false, queue: 'EPSON_ET_8550_Series', health: { message: 'Printer needs paper' },
    activeJob: { id: batchId, deckName: '@everyone getting right with paper', state: 'submitted', artifactId: 'fronts', phase: 'fronts',
      recovery: { recoveryId: 'boundary-28', mode: 'resume', artifactId: 'fronts', phase: 'fronts', spoolerId: 'EPSON_ET_8550_Series-28', physicalPages: [4, 3, 2, 1], totalSheets: 4 }, ...extra } },
    jobs: { pending: [{ id: batchId, deckName: '@everyone getting right with paper', state: 'submitted' }], recent: [], deferred: [] } };
}

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(instant);
  dir = mkdtempSync(join(tmpdir(), 'clc-discord-bot-'));
  vi.stubEnv('DB_PATH', join(dir, 'db.sqlite')); vi.stubEnv('PRINT_JOBS_DIR', join(dir, 'jobs'));
  vi.stubEnv('JWT_SECRET', 'discord-bot-test-jwt-secret-not-a-real-credential'); vi.stubEnv('APP_URL', 'https://clc.example.test/');
  vi.stubEnv('PRINT_STATION_TOKEN', 'discord-bot-fixture-station-token-not-real-0123456789');
  db = await import('../db.js'); await db.initDb();
  for (const [username, admin, suspended] of [['admin', 1, 0], ['household', 0, 0], ['suspended', 1, 1]]) {
    db.run('INSERT INTO users(username, password_hash, is_admin, suspended) VALUES (?, ?, ?, ?)', [username, 'unused', admin, suspended]);
  }
  management = { printStationStatus: vi.fn(() => recoveryStatus()), createStationCommand: vi.fn(() => ({ command: { id: randomUUID(), status: 'pending' } })) };
  vi.doMock('../lib/printStationManagement.js', () => management);
  bot = await import('../lib/discordPrintBot.js'); bot.initDiscordPrintBotSchema();
  const pair = generateKeyPairSync('ed25519'); privateKey = pair.privateKey;
  config = { applicationId: '123456789012345678', publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
    guildId: '234567890123456789', channelId: '345678901234567890', operatorDiscordId: '456789012345678901' };
  bot.saveDiscordPrintBotSettings(1, config);
  const auth = await import('../middleware/auth.js'); tokens = [1, 2, 3].map(id => auth.createToken(db.get('SELECT * FROM users WHERE id = ?', [id])));
  const routes = await import('./discord-print-bot.js');
  const app = express(); app.use('/api/discord', routes.discordPrintInteractionRouter); app.use(express.json());
  app.use('/api/print-station-management', routes.default);
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
  vi.doUnmock('../lib/printStationManagement.js'); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true });
});

function payload(action = 'status', options = [], extra = {}) {
  return { id: String(567890123456789012n + ++nextInteractionId), application_id: config.applicationId, type: 2,
    guild_id: config.guildId, channel_id: config.channelId, member: { user: { id: config.operatorDiscordId } }, context: 0,
    token: 'interaction-token-must-never-be-stored', data: { name: 'proxy', type: 1, options: [{ name: action, type: 1, options }] }, ...extra };
}
const batch = value => ({ name: 'batch', type: 3, value: value || batchId });
const sheet = value => ({ name: 'sheet', type: 4, value });
function signed(value, { timestamp = String(instant / 1000), raw = JSON.stringify(value), signature } = {}) {
  const bytes = Buffer.from(raw);
  return { bytes, timestamp, signature: signature || sign(null, Buffer.concat([Buffer.from(timestamp), bytes]), privateKey).toString('hex') };
}
async function interact(value, options = {}) {
  const { bytes, timestamp, signature } = signed(value, options);
  const response = await fetch(`${origin}/api/discord/interactions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature-Timestamp': timestamp, 'X-Signature-Ed25519': signature }, body: bytes });
  return { status: response.status, body: await response.json() };
}
async function adminRequest(path = '', { method = 'GET', body, token = tokens[0] } = {}) {
  const response = await fetch(`${origin}/api/print-station-management/discord-bot${path}`, { method, headers: adminHeaders(token), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

describe('signed Discord printer commands', () => {
  it('verifies the original raw PING bytes and rejects invalid, missing, stale or future signatures', async () => {
    const ping = { type: 1, application_id: config.applicationId };
    expect(await interact(ping, { raw: ` { "type": 1, "application_id": "${config.applicationId}" }\n` })).toEqual({ status: 200, body: { type: 1 } });
    for (const options of [{ signature: '0'.repeat(128) }, { timestamp: String(instant / 1000 - 301) }, { timestamp: String(instant / 1000 + 301) }, { timestamp: 'bad' }]) {
      expect((await interact(ping, options)).status).toBe(401);
    }
    expect((await fetch(`${origin}/api/discord/interactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ping) })).status).toBe(401);
    expect((await interact({ ...ping, application_id: '999999' })).status).toBe(401);
    expect((await interact(ping, { raw: '{"broken"' })).status).toBe(400);
    const original = signed(ping);
    expect((await interact(ping, { raw: JSON.stringify({ ...ping, type: 2 }), signature: original.signature })).status).toBe(401);
    expect(db.all('SELECT * FROM discord_print_interactions')).toEqual([]);
  });

  it('restricts commands to the configured guild, channel, operator and an active linked CLC admin', async () => {
    for (const extra of [{ guild_id: '123' }, { channel_id: '123' }, { member: { user: { id: '123' } } }, { member: null, user: { id: config.operatorDiscordId } }, { user: { id: config.operatorDiscordId } }, { context: 1 }]) {
      const result = await interact(payload('continue', [batch()], extra));
      expect(result.status).toBe(200); expect(result.body.data.content).toContain('restricted');
    }
    for (const sql of ['UPDATE users SET suspended = 1 WHERE id = 1', 'UPDATE users SET suspended = 0, is_admin = 0 WHERE id = 1', 'DELETE FROM users WHERE id = 1']) {
      db.run(sql); expect((await interact(payload())).body.data.content).toContain('no longer authorized');
    }
    expect(management.createStationCommand).not.toHaveBeenCalled(); expect(management.printStationStatus).not.toHaveBeenCalled();
  });

  it('gives an ephemeral useful status without mentions or stored message tokens', async () => {
    const result = await interact(payload('status', [batch()]));
    expect(result.status).toBe(200); expect(result.body.data.flags).toBe(64);
    expect(result.body.data.allowed_mentions).toEqual({ parse: [], users: [], roles: [], replied_user: false });
    expect(result.body.data.content).toContain(batchId); expect(result.body.data.content).toContain('Printer needs paper');
    expect(result.body.data.content).toContain('/proxy continue'); expect(result.body.data.content).not.toContain('@everyone');
    expect(management.printStationStatus).toHaveBeenCalledWith(1);
    const durable = readFileSync(join(dir, 'db.sqlite')).toString('latin1');
    expect(durable).not.toContain('interaction-token'); expect(durable).not.toContain(tokenFixture);
  });

  it('queues one exact held-job recovery and durably repeats its receipt after a lost response', async () => {
    const request = payload('continue', [batch()]);
    const first = await interact(request), again = await interact(request);
    expect(again).toEqual(first); expect(management.createStationCommand).toHaveBeenCalledTimes(1);
    expect(management.createStationCommand).toHaveBeenCalledWith(1, {
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/), type: 'recover_print', jobId: batchId,
      artifactId: 'fronts', phase: 'fronts', spoolerId: 'EPSON_ET_8550_Series-28', recoveryId: 'boundary-28', paperReady: true,
    });
    expect(first.body.data.content).toContain('Recovery request queued'); expect(first.body.data.content).toContain('not that printing has completed');
    const persisted = new (db.getDb().constructor)(readFileSync(join(dir, 'db.sqlite')));
    try { expect(persisted.exec('SELECT completed_at FROM discord_print_interactions')[0].values[0][0]).toBeTruthy(); } finally { persisted.close(); }
    db.run('UPDATE users SET is_admin = 0 WHERE id = 1');
    expect((await interact(request)).body.data.content).toContain('no longer authorized');
    expect(management.createStationCommand).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit first unprinted sheet for canceled passes and rejects backs or stale boundaries', async () => {
    management.printStationStatus.mockReturnValue(recoveryStatus({ recovery: { recoveryId: 'canceled-28', mode: 'reprint_remaining', artifactId: 'fronts', phase: 'fronts', spoolerId: 'EPSON_ET_8550_Series-28', physicalPages: [4, 3, 2, 1], totalSheets: 4 } }));
    expect((await interact(payload('continue', [batch()]))).body.data.content).toContain('first unprinted sheet');
    expect(management.createStationCommand).not.toHaveBeenCalled();
    expect((await interact(payload('continue', [batch(), sheet(2)]))).body.data.content).toContain('queued');
    expect(management.createStationCommand.mock.calls[0][1]).toMatchObject({ firstUnprintedSheet: 2, recoveryId: 'canceled-28' });
    management.printStationStatus.mockReturnValue(recoveryStatus({ phase: 'backs', recovery: { ...recoveryStatus().station.activeJob.recovery, phase: 'backs' } }));
    expect((await interact(payload('continue', [batch()]))).body.data.content).toContain('matching front sheets');
    management.printStationStatus.mockReturnValue(recoveryStatus({ recovery: null }));
    expect((await interact(payload('continue', [batch()]))).body.data.content).toContain('not waiting');
    expect(management.createStationCommand).toHaveBeenCalledTimes(1);
  });

  it('does not replay an uncertain durable intent, conflict or provider validation failure', async () => {
    const original = payload('continue', [batch()]);
    management.createStationCommand.mockImplementationOnce(() => { throw Object.assign(new Error('Exact printer recovery boundary changed'), { status: 409 }); });
    const first = await interact(original); expect(first.body.data.content).toContain('boundary changed');
    expect(await interact(original)).toEqual(first); expect(management.createStationCommand).toHaveBeenCalledTimes(1);
    const changed = { ...original, data: payload('continue', [batch(), sheet(2)]).data };
    expect((await interact(changed)).body.data.content).toContain('already used');
    db.run('UPDATE discord_print_interactions SET response_json = NULL, completed_at = NULL WHERE interaction_id = ?', [original.id]);
    expect((await interact(original)).body.data.content).toContain('result is not confirmed');
    expect(management.createStationCommand).toHaveBeenCalledTimes(1);
  });

  it('rejects an old receipt after changing the application operator binding', async () => {
    const original = payload('continue', [batch()]);
    await interact(original);
    bot.saveDiscordPrintBotSettings(1, config);
    expect((await interact(original)).body.data.content).toContain('already used');
    expect(management.createStationCommand).toHaveBeenCalledTimes(1);
  });

  it('supports a valid large current attempt without losing recovery instructions to Discord message limits', async () => {
    management.printStationStatus.mockReturnValue(recoveryStatus({ recovery: { ...recoveryStatus().station.activeJob.recovery, recoveryId: 'large-attempt', mode: 'reprint_remaining', physicalPages: Array.from({ length: 1000 }, (_, index) => 1000 - index), totalSheets: 1000 } }));
    const status = (await interact(payload('status', [batch()]))).body;
    expect(status.data.content).toContain('Sheets in this attempt: 1000');
    expect(status.data.content).toContain('full order in Printer in CLC');
    expect(status.data.content).toContain('/proxy continue');
    expect(status.data.content.length).toBeLessThanOrEqual(1900);
    await interact(payload('continue', [batch(), sheet(1000)]));
    expect(management.createStationCommand.mock.calls[0][1].firstUnprintedSheet).toBe(1000);
  });

  it.each([['resume', 4, []], ['reprint_remaining', 7, [sheet(3)]]])('uses the actual sanitized station status and recovery command for %s', async (mode, cupsState, extraOptions) => {
    const real = await vi.importActual('../lib/printStationManagement.js');
    management.printStationStatus.mockImplementation(real.printStationStatus);
    management.createStationCommand.mockImplementation(real.createStationCommand);
    const manifest = JSON.stringify({ artifacts: [{ id: 'fronts', kind: 'ordinary', pageCount: 4, sheetCount: 4, cardCount: 28 }] });
    const stamp = new Date(instant).toISOString();
    db.run(`INSERT INTO print_jobs(id, user_id, request_key, request_hash, plan_json, state, manifest_json, manifest_sha256,
      steps_json, created_at, updated_at, queued_at, station_id, claim_nonce, lease_expires_at)
      VALUES (?, 1, ?, 'fixture', ?, 'submitted', ?, ?, ?, ?, ?, ?, 'household', 'fixture-nonce', ?)`,
    [batchId, randomUUID(), JSON.stringify({ deckName: 'Paper recovery', totalCopies: 28 }), manifest, createHash('sha256').update(manifest).digest('hex'),
      JSON.stringify([{ artifactId: 'fronts', phase: 'fronts', state: 'submitted', spoolerId: 'EPSON_ET_8550_Series-28' }]), stamp, stamp, stamp, new Date(instant + 120000).toISOString()]);
    const recovery = { recoveryId: 'recover-' + 'a'.repeat(24), artifactId: 'fronts', phase: 'fronts', spoolerId: 'EPSON_ET_8550_Series-28',
      mode, cupsState, physicalPages: [4, 3, 2, 1], totalSheets: 4, attemptId: null };
    const heartbeat = { version: '2.57.0', paused: false, queue: 'EPSON_ET_8550_Series', printRecovery: true, deferredBacks: true,
      recipeVerified: true, duplexVerified: false, recipeFingerprint: 'f'.repeat(64), health: { ok: true, known: true, message: 'Printer ready' },
      activeJob: { id: batchId, state: 'submitted', artifactId: 'fronts', phase: 'fronts', recovery }, receipts: [], events: [] };
    real.stationManagementHeartbeat(heartbeat);
    const actualStatus = real.printStationStatus(1);
    expect(actualStatus.station.activeJob).not.toHaveProperty('spoolerId');
    expect(actualStatus.station.activeJob.recovery).toEqual(recovery);
    const request = payload('continue', [batch(), ...extraOptions]);
    const first = await interact(request); expect(first.body.data.content).toContain('Recovery request queued');
    expect(await interact(request)).toEqual(first);
    const commands = db.all('SELECT payload_json FROM print_station_commands'); expect(commands).toHaveLength(1);
    expect(JSON.parse(commands[0].payload_json)).toMatchObject({ type: 'recover_print', jobId: batchId, recoveryId: recovery.recoveryId, artifactId: 'fronts', phase: 'fronts', spoolerId: recovery.spoolerId,
      ...(mode === 'reprint_remaining' ? { firstUnprintedSheet: 3, pages: [1, 2] } : {}) });
    if (mode === 'resume') {
      // Also cover a crash between station intent and interaction response.
      db.run('UPDATE discord_print_interactions SET response_json = NULL, completed_at = NULL WHERE interaction_id = ?', [request.id]);
      bot.saveDiscordPrintBotSettings(1, config);
      expect(db.get('SELECT status FROM print_station_commands').status).toBe('rejected');
      await interact(payload('continue', [batch()]));
      expect(db.all("SELECT status FROM print_station_commands WHERE status = 'pending'")).toHaveLength(1);
      vi.stubEnv('PRINT_ALLOWED_USER_IDS', '1');
      db.run('UPDATE users SET is_admin = 0 WHERE id = 1');
      expect(real.printStationStatus(1).permissions.canControl).toBe(true);
      expect(real.stationManagementHeartbeat(heartbeat).commands).toEqual([]);
      expect(db.all("SELECT status FROM print_station_commands WHERE status = 'pending'")).toEqual([]);
      expect(db.all("SELECT message FROM print_station_commands WHERE message LIKE '%administrator authorization changed%'")).toHaveLength(1);
    } else {
      db.run('UPDATE print_station_commands SET delivered_at = ?', [stamp]);
      bot.disconnectDiscordPrintBot(1);
      expect(db.get('SELECT status FROM print_station_commands').status).toBe('pending');
    }
  });

  it('rejects malformed, duplicate or unexpected command options without queueing', async () => {
    const invalid = [payload('continue'), payload('continue', [batch('short-id')]), payload('continue', [batch(), batch()]), payload('continue', [batch(), sheet(0)]),
      payload('continue', [batch(), sheet(1001)]), payload('continue', [batch(), { name: 'shell', type: 3, value: 'ls' }]), payload('status', [sheet(1)]),
      payload('pause'), payload('continue', [batch()], { data: { name: 'other', type: 1 } })];
    for (const value of invalid) expect((await interact(value)).status).toBe(200);
    expect(management.createStationCommand).not.toHaveBeenCalled();
    expect((await interact(payload('continue', [batch(), sheet(1)]))).body.data.content).toContain('Leave off the sheet');
    expect(management.createStationCommand).not.toHaveBeenCalled();
  });
});

describe('Discord application setup', () => {
  it('requires current admin authorization and returns only public setup data with an exact endpoint/install scope', async () => {
    for (const token of [null, tokens[1], tokens[2]]) expect((await adminRequest('', { token })).status).toBe(token ? 403 : 401);
    const result = await adminRequest(); expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(result.body).toMatchObject({ configured: true, ...config, clcUserId: 1, operatorName: 'admin', operatorActive: true, endpointUrl: 'https://clc.example.test/api/discord/interactions', registeredAt: null });
    expect(new URL(result.body.inviteUrl).searchParams.get('scope')).toBe('applications.commands');
    expect(new URL(result.body.inviteUrl).searchParams.get('guild_id')).toBe(config.guildId);
    expect(JSON.stringify(result.body)).not.toContain('botToken');
  });

  it('validates numeric IDs, public key and allowed fields before persisting', async () => {
    for (const body of [{ ...config, guildId: 'https://attacker.invalid' }, { ...config, applicationId: String(2n ** 64n) }, { ...config, publicKey: 'not hex' },
      { ...config, publicKey: '0'.repeat(64) }, { ...config, botToken: tokenFixture }, { ...config, clcUserId: 2 }]) {
      expect((await adminRequest('', { method: 'PUT', body })).status).toBe(400);
    }
    expect(bot.discordPrintBotSettings(1)).toMatchObject(config);
    expect(readFileSync(join(dir, 'db.sqlite')).toString('latin1')).not.toContain(tokenFixture);
  });

  it('registers only the proxy guild command using a one-time token and never stores the token or response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: () => { throw new Error('Provider body must not be read'); } }));
    const result = await bot.registerDiscordPrintBotCommands(1, { botToken: tokenFixture }, { fetchImpl });
    expect(result.registeredAt).toBe(new Date(instant).toISOString());
    expect(fetchImpl).toHaveBeenCalledWith(`https://discord.com/api/v10/applications/${config.applicationId}/guilds/${config.guildId}/commands`, expect.objectContaining({ method: 'POST', redirect: 'error', headers: { Authorization: `Bot ${tokenFixture}`, 'Content-Type': 'application/json' } }));
    const command = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(command.name).toBe('proxy'); expect(command.options.map(item => item.name)).toEqual(['status', 'continue']);
    expect(command.options[1].options[0].required).toBe(true);
    expect(JSON.stringify(result)).not.toContain(tokenFixture); expect(readFileSync(join(dir, 'db.sqlite')).toString('latin1')).not.toContain(tokenFixture);
  });

  it('redacts registration failures and rejects configuration/admin changes during REST registration', async () => {
    const throws = vi.fn(async () => { throw new Error(`Provider dumped secret ${tokenFixture}`); });
    await expect(bot.registerDiscordPrintBotCommands(1, { botToken: tokenFixture }, { fetchImpl: throws })).rejects.toThrow('could not be confirmed');
    await expect(bot.registerDiscordPrintBotCommands(1, { botToken: tokenFixture }, { fetchImpl: async () => ({ ok: false, status: 401 }) })).rejects.toThrow('rejected the bot token');
    await expect(bot.registerDiscordPrintBotCommands(1, { botToken: tokenFixture }, { fetchImpl: async () => {
      bot.saveDiscordPrintBotSettings(1, { ...config, channelId: '1234' }); return { ok: true };
    } })).rejects.toThrow('changed during registration');
    await expect(bot.registerDiscordPrintBotCommands(1, { botToken: tokenFixture }, { fetchImpl: async () => {
      db.run('UPDATE users SET is_admin = 0 WHERE id = 1'); return { ok: true };
    } })).rejects.toThrow('active CLC administrator');
    expect(readFileSync(join(dir, 'db.sqlite')).toString('latin1')).not.toContain(tokenFixture);
  });

  it('disconnects incoming commands without modifying notification settings', async () => {
    db.run("INSERT INTO server_settings(key, value) VALUES ('unrelated_notifications', 'preserved')");
    expect((await adminRequest('/disconnect', { method: 'POST', body: {} })).body.configured).toBe(false);
    expect((await interact({ type: 1, application_id: config.applicationId })).status).toBe(401);
    expect(db.get("SELECT value FROM server_settings WHERE key = 'unrelated_notifications'").value).toBe('preserved');
  });
});
