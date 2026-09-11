import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import crypto from 'node:crypto';
import express from 'express';

let dir, db, management, server, origin, tokens;
const credential = 'station-management-fixture-credential-0123456789012345';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const instant = Date.UTC(2026, 8, 10, 12);
const heartbeat = (extra = {}) => ({ version: '2.45.0', paused: false, queue: 'EPSON_ET_8550_Series',
  recipeVerified: true, duplexVerified: false, recipeFingerprint: 'f'.repeat(64), activeJob: null,
  health: { ok: true, message: 'Station ready' },
  update: { supported: true, currentVersion: '2.45.0', previousVersion: '2.44.2', availableVersion: '2.45.1', status: 'available', error: null },
  events: [], receipts: [], ...extra });
const command = (type, extra = {}) => ({ idempotencyKey: crypto.randomUUID(), type, ...extra });

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(instant);
  dir = mkdtempSync(join(tmpdir(), 'clc-station-management-'));
  vi.stubEnv('DB_PATH', join(dir, 'db.sqlite')); vi.stubEnv('PRINT_JOBS_DIR', join(dir, 'jobs'));
  vi.stubEnv('PRINT_STATION_TOKEN', credential); vi.stubEnv('PRINT_ALLOWED_USER_IDS', '2,4');
  vi.stubEnv('JWT_SECRET', 'station-management-test-jwt-secret-only');
  db = await import('../db.js'); await db.initDb();
  for (const [username, admin, suspended] of [['admin', 1, 0], ['household', 0, 0], ['outside', 0, 0], ['suspended', 0, 1]]) {
    db.run('INSERT INTO users(username, password_hash, is_admin, suspended) VALUES (?, ?, ?, ?)', [username, 'unused', admin, suspended]);
  }
  const { createToken } = await import('../middleware/auth.js');
  tokens = Object.fromEntries(db.all('SELECT * FROM users').map(user => [user.id, createToken(user)]));
  management = await import('../lib/printStationManagement.js');
  const app = express(); app.use(express.json({ limit: '64kb' }));
  app.use('/api/print-station-management', (await import('./print-station-management.js')).default);
  app.use('/api/print-station', (await import('./print-station.js')).default);
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true });
});
function request(path, { method = 'GET', body, token = tokens[1] } = {}) {
  return fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const status = (user = 1) => request('/api/print-station-management/status', { token: tokens[user] });
const send = (value, user = 1) => request('/api/print-station-management/commands', { method: 'POST', body: value, token: tokens[user] });
const beat = value => request('/api/print-station/heartbeat', { method: 'POST', body: value || heartbeat(), token: credential });
const claim = () => request('/api/print-station/claim', { method: 'POST', body: {}, token: credential });
async function accepted(value, user = 1) {
  const response = await send(value, user), body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200); return body.command;
}
function seedJob(state = 'awaiting_refeed', steps = [
  { artifactId: 'dfc-first', phase: 'fronts', state: 'completed', spoolerId: 'EPSON-1' },
  { artifactId: 'dfc-first', phase: 'backs', state: 'pending', requiresRefeed: true },
  { artifactId: 'dfc-second', phase: 'fronts', state: 'pending' },
  { artifactId: 'dfc-second', phase: 'backs', state: 'pending', requiresRefeed: true },
]) {
  const id = crypto.randomUUID(), path = join(dir, 'jobs', id);
  mkdirSync(path, { recursive: true });
  const pdf = Buffer.from('%PDF-1.4\nFixture\n%%EOF\n'); writeFileSync(join(path, 'fronts.pdf'), pdf);
  const manifest = JSON.stringify({ recipe: { id: 'household-letter-v6' }, artifacts: [{ id: 'fronts', kind: 'ordinary',
    fileName: 'fronts.pdf', sha256: digest(pdf), size: pdf.length, pageCount: 1, sheetCount: 1, cardCount: 7 }] });
  const plan = { deckName: 'Household proof', mode: 'full', totalCopies: 7, artSource: 'scryfall', source: null, target: { id: 1, createdAt: new Date().toISOString(), textHash: 'f'.repeat(64) } };
  db.run(`INSERT INTO print_jobs(id, user_id, tracked_deck_id, request_key, request_hash, plan_json, state,
    manifest_json, manifest_sha256, steps_json, created_at, updated_at, queued_at, station_id, claim_nonce, lease_expires_at)
    VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, crypto.randomUUID(), 'hash', JSON.stringify(plan), state, manifest, digest(manifest), JSON.stringify(steps),
    new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), state === 'queued' ? null : 'household', 'nonce', new Date(instant + 120000).toISOString()]);
  return id;
}

describe('household station access and telemetry', () => {
  it('uses real user authentication, live DB authorization and separate station credentials', async () => {
    expect((await request('/api/print-station-management/status', { token: null })).status).toBe(401);
    expect((await status(3)).status).toBe(403); expect((await status(4)).status).toBe(403);
    expect((await (await status(2)).json()).permissions).toEqual({ canControl: true, canUpdate: false });
    const neverSeen = await (await status()).json();
    expect(neverSeen.station).toMatchObject({ online: false, lastSeenAt: null, version: null, queue: null, activeJob: null });
    expect((await request('/api/print-station/heartbeat', { method: 'POST', body: heartbeat() })).status).toBe(401);
    expect((await request('/api/print-station-management/status', { token: credential })).status).toBe(401);
    expect((await beat()).status).toBe(200);
    db.run('UPDATE users SET suspended = 1 WHERE id = 2'); // authorization must not rely only on JWT/cache
    expect((await status(2)).status).toBe(403);
  });

  it('preserves protocol-v1 status and keeps liveness ephemeral without five-second DB rewrites', async () => {
    const legacy = await request('/api/print-station/status', { token: credential });
    expect(await legacy.json()).toEqual({ stationId: 'household', recipeId: 'household-letter-v6', protocolVersion: 1 });
    await beat();
    const before = readFileSync(join(dir, 'db.sqlite'));
    vi.setSystemTime(instant + 5000); await beat();
    expect(readFileSync(join(dir, 'db.sqlite'))).toEqual(before);
    expect((await (await status()).json()).station.online).toBe(true);
    vi.setSystemTime(instant + 25001);
    expect((await (await status()).json()).station.online).toBe(false);
    management.resetPrintStationManagement();
    expect((await (await status()).json()).station.lastSeenAt).toBeNull();
  });

  it('defaults test printing off for legacy stations and accepts only explicit boolean telemetry without changing proofs', async () => {
    expect((await (await status()).json()).station.testPrintingEnabled).toBe(false);
    await beat(heartbeat({ recipeVerified: false, duplexVerified: false }));
    expect((await (await status()).json()).station).toMatchObject({
      testPrintingEnabled: false, recipeVerified: false, duplexVerified: false,
    });
    expect((await beat(heartbeat({ testPrintingEnabled: true, recipeVerified: false, duplexVerified: false }))).status).toBe(200);
    for (const invalid of [null, 'true', 'false', 1, 0, {}, []]) {
      expect((await beat(heartbeat({ testPrintingEnabled: invalid }))).status).toBe(400);
    }
    expect((await (await status()).json()).station).toMatchObject({
      testPrintingEnabled: true, recipeVerified: false, duplexVerified: false,
    }); // A rejected heartbeat must not replace the last accepted proof flags.
    expect((await send(command('test_printing', { enabled: true }))).status).toBe(400);
    expect((await send(command('pause', { testPrintingEnabled: true }))).status).toBe(400);
    expect(db.get('SELECT COUNT(*) AS n FROM print_station_commands').n).toBe(0);
    await beat(heartbeat({ testPrintingEnabled: false }));
    expect((await (await status()).json()).station.testPrintingEnabled).toBe(false);
    await beat(heartbeat({ testPrintingEnabled: true }));
    await beat(); // An older companion replacing the station must not inherit the opt-in.
    expect((await (await status()).json()).station.testPrintingEnabled).toBe(false);
    management.resetPrintStationManagement();
    expect((await (await status()).json()).station.testPrintingEnabled).toBe(false);
  });

  it('bounds heartbeat fields and redacts credentials from persisted summaries and browser output', async () => {
    const event = { id: crypto.randomUUID(), at: new Date().toISOString(), level: 'error', message: `Bearer ${credential} password=hello secret=${process.env.JWT_SECRET}` };
    await beat(heartbeat({ health: { ok: false, message: event.message }, events: [event] }));
    const view = await (await status()).json(), encoded = JSON.stringify(view);
    expect(encoded).not.toContain(credential); expect(encoded).not.toContain(process.env.JWT_SECRET); expect(encoded).not.toContain('hello');
    expect(view.events).toHaveLength(1); expect(view.events[0].message).toContain('redacted');
    const before = readFileSync(join(dir, 'db.sqlite')); await beat(heartbeat({ health: { ok: false, message: event.message }, events: [event] }));
    expect(readFileSync(join(dir, 'db.sqlite'))).toEqual(before);
    for (const body of [heartbeat({ events: Array(51).fill(event) }), heartbeat({ receipts: Array(21).fill({}) }), heartbeat({ paused: 'false' }), heartbeat({ health: { ok: true, message: 'x'.repeat(1001) } })]) {
      expect((await beat(body)).status).toBe(400);
    }
    expect((await beat(heartbeat({ events: [{ ...event, message: 'Changed' }] }))).status).toBe(409);
  });
});

describe('durable control commands and receipts', () => {
  it('deduplicates retries before live eligibility checks and rejects mismatched request reuse', async () => {
    await beat(); const input = command('pause'), first = await accepted(input, 2);
    expect(first).toMatchObject({ idempotencyKey: input.idempotencyKey, status: 'pending', requesterId: 2 });
    expect((await accepted(input, 2)).id).toBe(first.id);
    expect((await send({ ...input, type: 'unpause' }, 2)).status).toBe(409);
    expect((await send(command('unpause'), 2)).status).toBe(409);
    management.resetPrintStationManagement();
    expect((await accepted(input, 2)).id).toBe(first.id);
    expect((await send(command('pause'), 2)).status).toBe(409);
    expect(db.get('SELECT COUNT(*) AS n FROM print_station_commands').n).toBe(1);
  });

  it('keeps receipts durable and never redelivers an acknowledged command', async () => {
    await beat(); const input = command('pause'), created = await accepted(input);
    expect((await (await beat()).json()).commands[0]).toMatchObject({ id: created.id, type: 'pause' });
    const receipt = { commandId: created.id, status: 'applied', message: 'Paused' };
    const result = await (await beat(heartbeat({ paused: true, receipts: [receipt] }))).json();
    expect(result).toMatchObject({ commands: [], acknowledgedCommandIds: [created.id] });
    expect((await accepted(input)).status).toBe('applied');
    const before = readFileSync(join(dir, 'db.sqlite'));
    expect((await (await beat(heartbeat({ paused: true, receipts: [receipt] }))).json()).acknowledgedCommandIds).toEqual([created.id]);
    expect(readFileSync(join(dir, 'db.sqlite'))).toEqual(before);
    expect((await beat(heartbeat({ receipts: [{ ...receipt, status: 'rejected' }] }))).status).toBe(409);
    management.resetPrintStationManagement();
    expect((await (await status()).json()).station).toMatchObject({ online: false, paused: true });
  });

  it('expires pending commands without redelivery and accepts only previously delivered late receipts', async () => {
    await beat(); const delivered = await accepted(command('check_update'));
    await beat(); vi.setSystemTime(instant + management.STATION_COMMAND_TTL_MS + 1);
    expect((await (await beat()).json()).commands).toEqual([]);
    expect(db.get('SELECT status FROM print_station_commands WHERE id = ?', [delivered.id]).status).toBe('expired');
    expect((await beat(heartbeat({ receipts: [{ commandId: delivered.id, status: 'applied', message: 'Update check completed' }] }))).status).toBe(200);
    const neverDelivered = await accepted(command('pause'));
    vi.setSystemTime(instant + 2 * management.STATION_COMMAND_TTL_MS + 2); await beat();
    expect((await beat(heartbeat({ receipts: [{ commandId: neverDelivered.id, status: 'applied' }] }))).status).toBe(409);
    expect((await beat(heartbeat({ receipts: [{ commandId: crypto.randomUUID(), status: 'applied' }] }))).status).toBe(409);
  });

  it('rejects revoked requesters before delivery and does not trust a stale admin JWT', async () => {
    await beat(); const queued = await accepted(command('pause'), 2);
    db.run('UPDATE users SET suspended = 1 WHERE id = 2');
    expect((await (await beat()).json()).commands).toEqual([]);
    expect(db.get('SELECT status FROM print_station_commands WHERE id = ?', [queued.id]).status).toBe('rejected');
    db.run('UPDATE users SET is_admin = 0 WHERE id = 1');
    expect((await send(command('check_update'))).status).toBe(403);
  });

  it('accepts durable receipts after a delivered command requester loses access', async () => {
    await beat(); const created = await accepted(command('pause'), 2);
    expect((await (await beat()).json()).commands[0].deliveredAt).toBe(new Date().toISOString());
    db.run('UPDATE users SET suspended = 1 WHERE id = 2');
    expect((await (await beat()).json()).commands).toEqual([]);
    const receipt = { commandId: created.id, status: 'applied', message: 'Paused before access changed' };
    expect((await (await beat(heartbeat({ paused: true, receipts: [receipt] }))).json()).acknowledgedCommandIds).toEqual([created.id]);
    expect(db.get('SELECT status FROM print_station_commands WHERE id = ?', [created.id]).status).toBe('applied');
  });

  it('requires exact update targets, administrator authority, idle state and supported installation', async () => {
    await beat();
    expect((await send(command('check_update'), 2)).status).toBe(403);
    expect((await send(command('update'))).status).toBe(400);
    expect((await send(command('update', { targetVersion: '2.44.0' }))).status).toBe(409);
    const created = await accepted(command('update', { targetVersion: '2.45.1' }));
    expect(created.targetVersion).toBe('2.45.1');
    const changed = heartbeat(); changed.update.availableVersion = '2.45.2';
    expect((await (await beat(changed)).json()).commands).toEqual([]);
    expect(db.get('SELECT status FROM print_station_commands WHERE id = ?', [created.id]).status).toBe('rejected');
    await beat(heartbeat({ activeJob: { id: crypto.randomUUID(), state: 'active' } }));
    expect((await send(command('rollback', { targetVersion: '2.44.2' }))).status).toBe(409);
    await beat(heartbeat({ update: { supported: false, currentVersion: '2.45.0', previousVersion: null, availableVersion: null, status: 'unsupported', error: null } }));
    expect((await send(command('check_update'))).status).toBe(409);
  });
});

describe('physical state separation and DFC batch binding', () => {
  it('derives the current packet identity and counts only from the immutable server manifest', async () => {
    const jobId = seedJob();
    const artifact = { id: 'dfc-first', kind: 'dfc', packetIndex: 1, packetCount: 2,
      label: 'CLC Household proof • batch ABCD • DFC 1/2', sheetCount: 1, cardCount: 7 };
    const manifest = JSON.stringify({ artifacts: [artifact, { ...artifact, id: 'dfc-second', packetIndex: 2 }] });
    db.run('UPDATE print_jobs SET manifest_json=?, manifest_sha256=? WHERE id=?', [manifest, digest(manifest), jobId]);
    const activeJob = { id: jobId, state: 'awaiting_refeed', artifactId: 'dfc-first', phase: 'backs',
      packet: { label: 'Wrong sheets from telemetry', sheetCount: 99 }, label: 'Wrong label' };
    await beat(heartbeat({ activeJob }));
    expect((await (await status()).json()).station.activeJob.packet).toEqual({
      artifactId: artifact.id, label: artifact.label, packetIndex: 1, packetCount: 2, sheetCount: 1, cardCount: 7,
    });
    expect(JSON.stringify(await (await status()).json())).not.toContain('Wrong');
    await beat(heartbeat({ activeJob: { ...activeJob, artifactId: 'dfc-second' } }));
    expect((await (await status()).json()).station.activeJob.packet).toBeNull();
    await beat(heartbeat({ activeJob }));
    db.run('UPDATE print_jobs SET manifest_sha256=? WHERE id=?', ['0'.repeat(64), jobId]);
    expect((await (await status()).json()).station.activeJob.packet).toBeNull();
  });

  it('preserves a legacy double-faced stack’s sheet count without inventing a printed label', async () => {
    const jobId = seedJob();
    const manifest = JSON.stringify({ artifacts: [{ id: 'dfc-first', kind: 'dfc', sheetCount: 3, cardCount: 18 }] });
    db.run('UPDATE print_jobs SET manifest_json=?, manifest_sha256=? WHERE id=?', [manifest, digest(manifest), jobId]);
    await beat(heartbeat({ activeJob: { id: jobId, state: 'awaiting_refeed', artifactId: 'dfc-first', phase: 'backs' } }));
    expect((await (await status()).json()).station.activeJob.packet).toEqual({
      artifactId: 'dfc-first', label: null, packetIndex: 1, packetCount: 1, sheetCount: 3, cardCount: 18,
    });
  });

  it('blocks new claims immediately for pending pause and unverified recipes, but preserves active recovery', async () => {
    const queued = seedJob('queued', [{ artifactId: 'fronts', phase: 'fronts', state: 'pending' }]);
    await beat(); const pause = await accepted(command('pause'));
    expect(await (await claim()).json()).toEqual({ job: null });
    expect(db.get('SELECT state FROM print_jobs WHERE id = ?', [queued]).state).toBe('queued');
    await beat(); await beat(heartbeat({ receipts: [{ commandId: pause.id, status: 'rejected', message: 'Fixture rejection' }] }));
    await beat(heartbeat({ recipeVerified: false })); expect(await (await claim()).json()).toEqual({ job: null });
    await beat(); const active = (await (await claim()).json()).job;
    expect(active.id).toBe(queued); expect(active.state).toBe('claimed');
    await accepted(command('pause'));
    expect((await (await claim()).json()).job.id).toBe(queued);
  });

  it('permits unverified test claims only after native opt-in while preserving pause and existing-claim recovery', async () => {
    const queued = seedJob('queued', [{ artifactId: 'fronts', phase: 'fronts', state: 'pending' }]);
    const proof = { recipeVerified: false, duplexVerified: false };
    await beat(heartbeat(proof));
    expect(await (await claim()).json()).toEqual({ job: null });
    await beat(heartbeat({ ...proof, testPrintingEnabled: true, paused: true }));
    expect(await (await claim()).json()).toEqual({ job: null });
    await beat(heartbeat({ ...proof, testPrintingEnabled: true }));
    const pause = await accepted(command('pause'));
    expect(await (await claim()).json()).toEqual({ job: null });
    await beat(heartbeat({ ...proof, testPrintingEnabled: true }));
    await beat(heartbeat({ ...proof, testPrintingEnabled: true,
      receipts: [{ commandId: pause.id, status: 'rejected', message: 'Fixture rejection' }] }));
    const active = (await (await claim()).json()).job;
    expect(active).toMatchObject({ id: queued, state: 'claimed' });
    expect((await (await status()).json()).station).toMatchObject({ ...proof, testPrintingEnabled: true });
    await beat(heartbeat({ ...proof, testPrintingEnabled: false }));
    expect((await (await claim()).json()).job.id).toBe(queued);
  });

  it('binds explicit paper reload to the current pending DFC artifact and rejects stale batches', async () => {
    const jobId = seedJob(); const active = { id: jobId, state: 'awaiting_refeed', artifactId: 'dfc-first', phase: 'backs' };
    await beat(heartbeat({ activeJob: active }));
    expect((await send(command('resume', { jobId }))).status).toBe(400);
    expect((await send(command('resume', { jobId, paperReloaded: true }))).status).toBe(400);
    expect((await send(command('resume', { jobId: crypto.randomUUID(), artifactId: 'dfc-first', paperReloaded: true }))).status).toBe(409);
    expect((await (await status()).json()).station.activeJob.artifactId).toBe('dfc-first');
    const input = command('resume', { jobId, artifactId: 'dfc-first', paperReloaded: true }), created = await accepted(input, 2);
    expect(created).toMatchObject({ jobId, artifactId: 'dfc-first', paperReloaded: true });
    const row = db.get('SELECT steps_json FROM print_jobs WHERE id = ?', [jobId]);
    const steps = JSON.parse(row.steps_json); steps[1].state = steps[2].state = 'completed';
    db.run('UPDATE print_jobs SET steps_json = ? WHERE id = ?', [JSON.stringify(steps), jobId]);
    expect((await (await beat(heartbeat({ activeJob: active }))).json()).commands).toEqual([]);
    expect((await (await status()).json()).station.activeJob.artifactId).toBeNull(); // local and server disagree
    expect((await accepted(input, 2)).status).toBe('rejected'); // retries never bind to dfc-second
    await beat(heartbeat({ activeJob: { ...active, artifactId: 'dfc-second' } }));
    expect((await (await status()).json()).station.activeJob.artifactId).toBe('dfc-second');
    expect((await send(command('resume', { jobId, artifactId: 'dfc-first', paperReloaded: true }), 2)).status).toBe(409);
    const next = await accepted(command('resume', { jobId, artifactId: 'dfc-second', paperReloaded: true }), 2);
    expect(next.artifactId).toBe('dfc-second');
    expect((await (await status()).json()).station.activeJob.deckName).toBe('Household proof');
  });

  it('does not change physical print steps when the station acknowledges a refeed command', async () => {
    const jobId = seedJob(), snapshot = heartbeat({ recipeVerified: false, duplexVerified: false, testPrintingEnabled: true,
      activeJob: { id: jobId, state: 'awaiting_refeed' } });
    await beat(snapshot);
    expect((await send(command('resume', { jobId, artifactId: 'dfc-first' }))).status).toBe(400);
    const created = await accepted(command('resume', { jobId, artifactId: 'dfc-first', paperReloaded: true }));
    await beat(snapshot);
    const before = db.get('SELECT state, steps_json FROM print_jobs WHERE id = ?', [jobId]);
    await beat({ ...snapshot, receipts: [{ commandId: created.id, status: 'applied', message: 'Reload confirmed locally' }] });
    expect(db.get('SELECT state, steps_json FROM print_jobs WHERE id = ?', [jobId])).toEqual(before);
  });
});
