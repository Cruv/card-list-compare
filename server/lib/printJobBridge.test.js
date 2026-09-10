import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const printingId = '00000000-0000-4000-8000-000000000010';
const oracleId = '00000000-0000-4000-8000-000000000011';
const accountId = '00000000-0000-4000-8000-000000000013';
const location = { id: '00000000-0000-4000-8000-000000000012', name: 'Unassigned', kind: 'unassigned' };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let dir, db, bridge, artwork, jobId, manifest, assets, receipts, commands, uploads, failure, afterUpload;

function distinctPng(value) {
  const data = Buffer.from(`fixture\0${value}`), type = Buffer.from('tEXt');
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); type.copy(chunk, 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), data.length + 8);
  return Buffer.concat([PNG.subarray(0, -12), chunk, PNG.subarray(-12)]);
}

function image(bytes, face, identifier) {
  const sha256 = hash(bytes), fileName = `images/${sha256}.png`;
  writeFileSync(join(dir, 'jobs', jobId, fileName), bytes);
  return { sha256, fileName, format: 'png', size: bytes.length, source: 'saved-mpc', identifier, face };
}

function saveManifest() {
  const text = JSON.stringify(manifest);
  db.run('UPDATE print_jobs SET manifest_json = ?, manifest_sha256 = ? WHERE id = ?', [text, hash(text), jobId]);
}

async function fakeManaSync(url, options) {
  const actor = options.headers.Authorization.slice(7);
  if (url.endsWith('/integration/context')) return response({ user: { id: accountId, username: 'alice' }, actorId: actor, scopes: ['inventory:read', 'proxies:write'] });
  if (url.endsWith('/containers')) return response({ containers: [location] });
  const assetHash = new URL(url).pathname.match(/\/proxy-art\/([a-f0-9]{64})$/)?.[1];
  if (assetHash) {
    uploads.push({ url, ...options });
    if (failure === 'unsupported') return response({ error: 'not_found' }, 404);
    expect(options.method).toBe('PUT');
    expect(hash(options.body)).toBe(assetHash);
    assets.set(assetHash, Buffer.from(options.body));
    if (failure === 'upload-timeout') { failure = null; throw new Error('Upload response lost'); }
    if (afterUpload) { const callback = afterUpload; afterUpload = null; await callback(); }
    return response({ sha256: assetHash, url: `/api/v1/proxy-art/${accountId}/${assetHash}`,
      contentType: options.headers['Content-Type'], bytes: options.body.length });
  }
  if (url.endsWith('/inventory/commands')) {
    commands.push({ url, ...options });
    const request = JSON.parse(options.body);
    const key = `${actor}:${request.operationId}`;
    if (receipts.has(key)) return response({ ...receipts.get(key), replayed: true });
    for (const imageUrl of Object.values(request.command.input.card.proxyArtwork || {})) {
      expect(assets.has(imageUrl.split('/').at(-1))).toBe(true);
    }
    const lot = { id: randomUUID(), ...request.command.input };
    const receipt = { operationId: request.operationId, revision: receipts.size + 1,
      changes: [{ entity: 'lots', id: lot.id, value: lot }] };
    receipts.set(key, receipt);
    if (failure === 'acquire-timeout') { failure = null; throw new Error('Acquire response lost'); }
    return response(receipt);
  }
  throw new Error(`Unexpected request ${url}`);
}

beforeEach(async () => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'clc-frozen-art-'));
  vi.stubEnv('DB_PATH', join(dir, 'clc.db'));
  vi.stubEnv('PRINT_JOBS_DIR', join(dir, 'jobs'));
  vi.stubEnv('MANASYNC_BRIDGE_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('JWT_SECRET', 'test-only-frozen-proxy-art-session-secret');
  db = await import('../db.js'); await db.initDb();
  (await import('./integrationSchema.js')).initIntegrationSchema();
  bridge = await import('./manasyncBridge.js'); bridge.initBridgeSchema();
  artwork = await import('./printJobBridge.js');
  db.run("INSERT INTO users (id,username,password_hash) VALUES (1,'alice','h'),(2,'bob','h')");
  db.run("INSERT INTO tracked_owners (id,user_id,archidekt_username) VALUES (1,1,'alice')");
  db.run("INSERT INTO tracked_decks (id,user_id,tracked_owner_id,archidekt_deck_id,deck_name) VALUES (1,1,1,1,'Deck')");
  jobId = randomUUID();
  mkdirSync(join(dir, 'jobs', jobId, 'images'), { recursive: true });
  const front = image(PNG, 'front', 'custom-front-selection');
  const back = image(distinctPng('back'), 'back', 'custom-back-selection');
  const alternate = image(distinctPng('alternate'), 'front', 'alternate-front-selection');
  const card = { displayName: 'Malakir Rebirth // Malakir Mire', setCode: 'znr', collectorNumber: '111', scryfallId: printingId, oracleId };
  manifest = { version: 1, jobId, requesterId: 1, plan: { totalCopies: 4 }, copies: [
    { id: '0001', ...card, front, back }, { id: '0002', ...card, front, back },
    { id: '0003', ...card, front: alternate, back },
    { id: '0004', displayName: 'Sol Ring', setCode: 'c21', collectorNumber: '263', front },
  ] };
  db.run(`INSERT INTO print_jobs (id,user_id,tracked_deck_id,request_key,request_hash,plan_json,state,created_at,updated_at)
    VALUES (?,1,1,?,'hash',?,'ready','2026-01-01','2026-01-01')`, [jobId, randomUUID(), JSON.stringify(manifest.plan)]);
  saveManifest();
  assets = new Map(); receipts = new Map(); commands = []; uploads = []; failure = null; afterUpload = null;
  vi.stubGlobal('fetch', vi.fn(fakeManaSync));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const connect = () => bridge.connect(1, { baseUrl: 'https://mana.example/prefix', token: 'original-actor' });
const expected = () => { const c = bridge.connectionStatus(1); return c.connected ? { accountId: c.accountId, actorId: c.actorId, baseUrl: c.baseUrl } : null; };
const stage = () => artwork.stagePrintJob(1, jobId);
const legacyStage = () => { const result = stage(); db.run('DELETE FROM manasync_pending_proxy_plans'); return result; };
const confirm = (itemId, operationId = randomUUID()) => bridge.confirmIncrement(1, itemId, { operationId, quantity: 1, expectedConnection: expected() });
function request(router, method, url, token) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const req = { method, url, body: {}, headers: token ? { authorization: `Bearer ${token}` } : {} };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
      set(values) { Object.assign(headers, values); return this; },
      json(body) { resolve({ status: this.statusCode, body, headers }); return this; },
      send(body) { resolve({ status: this.statusCode, body, headers }); return this; } };
    router.handle(req, res, error => error ? reject(error) : resolve({ status: 404 }));
  });
}

describe('native print job artwork bridge', () => {
  it('groups exact cards and both actual art faces deterministically without confirming or acquiring', () => {
    const first = stage(), second = stage();
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.items.map(item => item.id)).toEqual(first.items.map(item => item.id));
    expect(first.items).toHaveLength(3);
    expect(first.items.map(item => item.quantity).sort()).toEqual([1,1,2]);
    const paired = first.items.find(item => item.quantity === 2);
    expect(paired).toMatchObject({ printJobId: jobId, confirmed: 0, remaining: 2,
      card: { scryfallId: printingId, oracleId, setCode: 'znr', collectorNumber: '111' },
      artwork: { front: { sha256: hash(PNG), source: 'saved-mpc' }, back: { identifier: 'custom-back-selection' } } });
    expect(artwork.ownedQueueArtwork(1, paired.id, 'front').bytes).toEqual(PNG);
    expect(artwork.ownedQueueArtwork(1, paired.id, 'back').bytes).toEqual(distinctPng('back'));
    expect(bridge.listQueue(1).every(item => item.operations.length === 0)).toBe(true);
    expect(db.get('SELECT state FROM print_jobs WHERE id = ?', [jobId]).state).toBe('ready');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves source art and stable staged items after native expiry and restart', async () => {
    const first = legacyStage();
    rmSync(join(dir, 'jobs', jobId), { recursive: true });
    db.run("UPDATE print_jobs SET state = 'expired' WHERE id = ?", [jobId]);
    vi.resetModules();
    db = await import('../db.js'); await db.initDb();
    bridge = await import('./manasyncBridge.js'); bridge.initBridgeSchema();
    artwork = await import('./printJobBridge.js');
    const replay = legacyStage();
    expect(replay.replayed).toBe(true);
    expect(replay.items.map(item => item.id)).toEqual(first.items.map(item => item.id));
    const paired = replay.items.find(item => item.quantity === 2);
    expect(artwork.ownedQueueArtwork(1, paired.id, 'back').bytes).toEqual(distinctPng('back'));
    await connect();
    expect((await confirm(paired.id)).status).toBe('reported');
  });

  it('rejects other users, missing faces and new staging after source expiry', () => {
    expect(() => artwork.stagePrintJob(2, jobId)).toThrow('Print job not found');
    const first = stage();
    expect(() => artwork.ownedQueueArtwork(2, first.items[0].id, 'front')).toThrow('Artwork not found');
    const ordinary = first.items.find(item => !item.artwork.back);
    expect(() => artwork.ownedQueueArtwork(1, ordinary.id, 'back')).toThrow('Artwork not found');
    expect(() => artwork.ownedQueueArtwork(1, ordinary.id, '../front')).toThrow('face not found');
    db.run('DELETE FROM manasync_print_items');
    rmSync(artwork.BRIDGE_ARTWORK_DIR, { recursive: true });
    rmSync(join(dir, 'jobs', jobId), { recursive: true });
    expect(stage).toThrow('expired or is missing');
    expect(bridge.listQueue(1)).toEqual([]);
  });

  it('exposes staging and private face bytes only through the owning account session', async () => {
    const { createToken } = await import('../middleware/auth.js');
    const router = (await import('../routes/manasync.js')).default;
    const owner = createToken({ id: 1, username: 'alice' });
    const other = createToken({ id: 2, username: 'bob' });
    const stagePath = `/print-jobs/${jobId}/confirmation-queue`;
    expect((await request(router, 'POST', stagePath)).status).toBe(401);
    expect((await request(router, 'POST', stagePath, other)).status).toBe(404);
    const result = await request(router, 'POST', stagePath, owner);
    expect(result.status).toBe(200);
    const item = result.body.items.find(value => value.quantity === 2);
    const path = `/print-queue/${item.id}/artwork/back`;
    expect((await request(router, 'GET', path, other)).status).toBe(404);
    const preview = await request(router, 'GET', path, owner);
    expect(preview).toMatchObject({ status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store' } });
    expect(preview.body).toEqual(distinctPng('back'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['checksum', 'path', 'symlink'])('rejects %s-tampered source bytes before publishing a confirmation queue', kind => {
    const front = manifest.copies[0].front;
    if (kind === 'checksum') writeFileSync(join(dir, 'jobs', jobId, front.fileName), Buffer.alloc(front.size));
    if (kind === 'path') { front.fileName = '../outside.png'; saveManifest(); }
    if (kind === 'symlink') {
      const outside = join(dir, 'outside.png'); writeFileSync(outside, PNG);
      rmSync(join(dir, 'jobs', jobId, front.fileName)); symlinkSync(outside, join(dir, 'jobs', jobId, front.fileName));
    }
    expect(stage).toThrow(/checksum|path|escapes|Unexpected link in print storage/);
    expect(bridge.listQueue(1)).toEqual([]);
  });

  it('publishes all staged groups atomically and retains cancellation on replay', async () => {
    db.run("CREATE TRIGGER fail_art_queue BEFORE INSERT ON manasync_print_items WHEN NEW.quantity = 1 BEGIN SELECT RAISE(ABORT, 'staging failed'); END");
    expect(stage).toThrow('staging failed');
    expect(bridge.listQueue(1)).toEqual([]);
    db.run('DROP TRIGGER fail_art_queue');
    const first = stage(); await bridge.cancelItem(1, first.items[0].id);
    const replay = stage();
    expect(replay.items.find(item => item.id === first.items[0].id).cancelled).toBe(true);
    expect(replay.items).toHaveLength(first.items.length);
  });

  it('binds an offline explicit confirmation to uploaded exact custom fronts and backs', async () => {
    const item = legacyStage().items.find(item => item.quantity === 2);
    const local = await confirm(item.id);
    expect(local.status).toBe('local');
    expect(fetch).not.toHaveBeenCalled();
    await connect();
    await bridge.bindLocalIncrement(1, local.id, location.id, expected());
    expect(uploads).toHaveLength(2); expect(commands).toHaveLength(1);
    expect(uploads[0].body).toEqual(PNG); expect(uploads[1].body).toEqual(distinctPng('back'));
    for (const upload of uploads) expect(upload).toMatchObject({ redirect: 'error', headers: { 'Content-Type': 'image/png', 'X-ManaSync-User': accountId, Authorization: 'Bearer original-actor' } });
    expect(JSON.parse(commands[0].body).command.input.card.proxyArtwork).toEqual({
      front: `/api/v1/proxy-art/${accountId}/${hash(PNG)}`,
      back: `/api/v1/proxy-art/${accountId}/${hash(distinctPng('back'))}`,
    });
    expect(commands[0].url).toBe('https://mana.example/prefix/api/v1/inventory/commands');
  });

  it.each(['upload-timeout','acquire-timeout'])('replays identical artwork, actor and command after %s', async lostAt => {
    const item = legacyStage().items.find(item => item.quantity === 2);
    await connect(); failure = lostAt;
    const operationId = randomUUID();
    expect((await confirm(item.id, operationId)).status).toBe('pending');
    const original = db.get('SELECT * FROM manasync_print_operations WHERE id = ?', [operationId]);
    expect(commands).toHaveLength(lostAt === 'upload-timeout' ? 0 : 1);
    await bridge.reportOperation(1, operationId, true);
    const final = db.get('SELECT * FROM manasync_print_operations WHERE id = ?', [operationId]);
    expect(final.status).toBe('reported');
    expect(final.payload_json).toBe(original.payload_json);
    expect(final.token_cipher).toBe(original.token_cipher);
    expect(receipts.size).toBe(1);
    expect(commands.every(command => command.body === original.payload_json)).toBe(true);
    expect(uploads.every(upload => upload.headers.Authorization === 'Bearer original-actor')).toBe(true);
    expect(uploads.filter(upload => upload.url.endsWith(hash(PNG))).every(upload => upload.body.equals(PNG))).toBe(true);
  });

  it('fails visibly on an unsupported artwork endpoint and never acquires without the art', async () => {
    const item = legacyStage().items[0]; await connect(); failure = 'unsupported';
    const operation = await confirm(item.id);
    expect(operation).toMatchObject({ status: 'pending', error: expect.stringContaining('Update ManaSync') });
    expect(commands).toHaveLength(0);
    failure = null; await bridge.reportOperation(1, operation.id, true);
    expect(commands).toHaveLength(1);
    expect(JSON.parse(commands[0].body).command.input.card.proxyArtwork.front).toBeTruthy();
  });

  it('refuses an artwork receipt pointing outside the frozen account and keeps the original command', async () => {
    const item = legacyStage().items[0]; await connect();
    fetch.mockImplementation(async (url, options) => {
      const result = await fakeManaSync(url, options);
      return url.includes('/proxy-art/') ? response({ ...await result.json(), url: '/api/v1/proxy-art/other-account/wrong-hash' }) : result;
    });
    const operation = await confirm(item.id);
    expect(operation).toMatchObject({ status: 'pending', error: expect.stringContaining('invalid proxy artwork receipt') });
    expect(commands).toHaveLength(0);
    const original = db.get('SELECT payload_json FROM manasync_print_operations WHERE id = ?', [operation.id]).payload_json;
    fetch.mockImplementation(fakeManaSync);
    await bridge.reportOperation(1, operation.id, true);
    expect(commands[0].body).toBe(original);
  });

  it('stops before acquisition when the connection changes during an artwork upload', async () => {
    const item = legacyStage().items.find(item => item.quantity === 2); await connect();
    afterUpload = () => bridge.connect(1, { baseUrl: 'https://mana.example/prefix', token: 'replacement-actor' });
    expect((await confirm(item.id)).status).toBe('review');
    expect(uploads).toHaveLength(1); expect(commands).toHaveLength(0);
  });

  it('stops remaining artwork and acquisition when the user is suspended during an upload', async () => {
    const item = legacyStage().items.find(item => item.quantity === 2); await connect();
    afterUpload = () => db.run('UPDATE users SET suspended=1 WHERE id=1');
    const operation = await confirm(item.id);
    expect(operation).toMatchObject({status:'pending',error:expect.stringContaining('suspended')});
    expect(uploads).toHaveLength(1); expect(commands).toHaveLength(0);
    const original = db.get('SELECT * FROM manasync_print_operations WHERE id=?',[operation.id]);
    fetch.mockClear(); await bridge.reportOperation(1,operation.id,true);
    expect(fetch).not.toHaveBeenCalled();
    db.run('UPDATE users SET suspended=0 WHERE id=1');
    await bridge.reportOperation(1,operation.id,true);
    expect(commands).toHaveLength(1); expect(receipts.size).toBe(1);
    expect(commands[0].body).toBe(original.payload_json);
    expect(commands[0].headers.Authorization).toBe('Bearer original-actor');
  });

  it('verifies retained bytes before upload and removes private copies with account print cleanup', async () => {
    const item = legacyStage().items.find(item => item.quantity === 2);
    const retained = join(artwork.BRIDGE_ARTWORK_DIR, '1', `${item.artwork.front.sha256}.png`);
    expect(readFileSync(retained)).toEqual(PNG);
    writeFileSync(retained, Buffer.alloc(PNG.length));
    await connect();
    expect((await confirm(item.id)).status).toBe('review');
    expect(uploads).toHaveLength(0); expect(commands).toHaveLength(0);
    (await import('./printQueue.js')).purgeUserPrintJobs(1);
    expect(existsSync(join(artwork.BRIDGE_ARTWORK_DIR, '1'))).toBe(false);
  });
});
