import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

vi.mock('../middleware/rateLimit.js', () => ({ archidektLimiter: (_req, _res, next) => next() }));
vi.mock('../lib/archidekt.js', () => ({ fetchDeck: vi.fn(), fetchOwnerDecks: vi.fn() }));

let directory, db, tokenRouter, structuredRouter, proposalRouter, deckRouter, ownerRouter, sessions, hash;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(),'clc-integration-api-'));
  process.env.DB_PATH = join(directory,'test.db');
  process.env.JWT_SECRET = 'test-only-clc-integration-api-secret';
  vi.resetModules();
  db = await import('../db.js'); await db.initDb();
  const schema = await import('../lib/integrationSchema.js'); schema.initIntegrationSchema();
  const auth = await import('../middleware/auth.js');
  for (const id of [1,2]) {
    db.run('INSERT INTO users (id,username,password_hash) VALUES (?,?,?)',[id,`user${id}`,'test']);
    db.run('INSERT INTO tracked_owners (id,user_id,archidekt_username) VALUES (?,?,?)',[id,id,`owner${id}`]);
    db.run('INSERT INTO tracked_decks (id,user_id,tracked_owner_id,archidekt_deck_id,deck_name) VALUES (?,?,?,?,?)',[id,id,id,id,`Deck ${id}`]);
    db.run('INSERT INTO deck_snapshots (tracked_deck_id,deck_text) VALUES (?,?)',[id,'1 Sol Ring (CMM) 410\r\n']);
  }
  sessions = [null,...[1,2].map(id => auth.createToken({id,username:`user${id}`}))];
  tokenRouter = (await import('./integrationTokens.js')).default;
  structuredRouter = (await import('./structuredDecks.js')).default;
  proposalRouter = (await import('./proposals.js')).default;
  deckRouter = (await import('./decks.js')).default;
  ownerRouter = (await import('./owners.js')).default;
  hash = (await import('../lib/structuredSnapshots.js')).textHash;
});
afterEach(() => {
  delete process.env.DB_PATH; delete process.env.JWT_SECRET;
  rmSync(directory,{recursive:true,force:true});
});

// Exercise Express Router and its authentication stack without opening sockets.
function request(router, method, url, token, body) {
  return new Promise((resolve,reject) => {
    const req = { method,url,headers:token ? {authorization:`Bearer ${token}`} : {},body };
    const res = { statusCode:200, status(code) { this.statusCode=code; return this; },
      json(value) { resolve({status:this.statusCode,body:value}); return this; } };
    router.handle(req,res,error => error ? reject(error) : resolve({status:404}));
  });
}
async function issue(user = 1, scopes = ['decks:read']) {
  const result = await request(tokenRouter,'POST','/',sessions[user],{name:'ManaSync',scopes});
  expect(result.status).toBe(201);
  return result.body;
}

it('issues hashed, scoped, per-account credentials; legacy login reads work; revocation is immediate', async () => {
  const issued = await issue();
  expect(db.get('SELECT token_hash FROM integration_tokens WHERE id = ?',[issued.id]).token_hash).not.toContain(issued.token);
  const context = await request(structuredRouter,'GET','/context',issued.token);
  expect(context.body).toMatchObject({version:1,accountId:'1',scopes:['decks:read'],capabilities:{proposals:true}});
  const legacy = await request(structuredRouter,'GET','/context',sessions[1]);
  expect(legacy.body.instanceId).toBe(context.body.instanceId);
  const decks = await request(structuredRouter,'GET','/decks',issued.token);
  expect(decks.body.decks.map(deck=>deck.id)).toEqual(['1']);
  expect(decks.body.decks[0].snapshots[0]).toMatchObject({deckText:'1 Sol Ring (CMM) 410\r\n',cards:[{setCode:'CMM',collectorNumber:'410',scryfallId:null}]});
  expect((await request(tokenRouter,'DELETE',`/${issued.id}`,sessions[2])).status).toBe(404);
  expect((await request(tokenRouter,'DELETE',`/${issued.id}`,sessions[1])).status).toBe(200);
  expect((await request(structuredRouter,'GET','/context',issued.token)).status).toBe(401);
});

it('read credentials cannot propose; proposal credentials cannot review or manage tokens', async () => {
  const read = await issue();
  const scoped = await issue(1,['decks:read','decks:propose']);
  const payload = {operationId:randomUUID(),baseSnapshotId:'1',baseTextHash:hash('1 Sol Ring (CMM) 410\r\n'),
    baseText:'1 Sol Ring (CMM) 410\r\n',proposedText:'1 Arcane Signet'};
  expect((await request(proposalRouter,'POST','/1/proposals',read.token,payload)).status).toBe(403);
  const receipt = await request(proposalRouter,'POST','/1/proposals',scoped.token,payload);
  expect(receipt.status).toBe(201);
  expect((await request(proposalRouter,'POST',`/1/proposals/${receipt.body.proposalId}/review`,scoped.token,{})).status).toBe(401);
  expect((await request(tokenRouter,'POST','/',scoped.token,{name:'escalation',scopes:['decks:read']})).status).toBe(401);
  const other = await issue(2,['decks:read','decks:propose']);
  expect((await request(proposalRouter,'GET',`/1/proposals/${receipt.body.proposalId}`,other.token)).status).toBe(404);
});

it('expired credentials fail before looking up a deck; a replacement credential recovers the same submission', async () => {
  const first = await issue(1,['decks:read','decks:propose']);
  const payload = {operationId:randomUUID(),baseSnapshotId:'1',baseTextHash:hash('1 Sol Ring (CMM) 410\r\n'),
    baseText:'1 Sol Ring (CMM) 410\r\n',proposedText:'1 Arcane Signet'};
  const original = await request(proposalRouter,'POST','/1/proposals',first.token,payload);
  db.run('UPDATE integration_tokens SET expires_at = ? WHERE id = ?',['2000-01-01T00:00:00.000Z',first.id]);
  expect((await request(proposalRouter,'POST','/999/proposals',first.token,payload)).status).toBe(401);
  const replacement = await issue(1,['decks:read','decks:propose']);
  const replay = await request(proposalRouter,'POST','/1/proposals',replacement.token,payload);
  expect(replay.status).toBe(200);
  expect(replay.body.proposalId).toBe(original.body.proposalId);
  expect(replay.body.replayed).toBe(true);
});

it('the session review route creates exactly one digital snapshot and exposes its proposal origin on polling', async () => {
  const scoped = await issue(1,['decks:read','decks:propose']);
  db.run('UPDATE tracked_decks SET paper_snapshot_id = 1 WHERE id = 1');
  const submission = {operationId:randomUUID(),baseSnapshotId:'1',baseTextHash:hash('1 Sol Ring (CMM) 410\r\n'),
    baseText:'1 Sol Ring (CMM) 410\r\n',proposedText:'Mainboard\r\n1 Arcane Signet (ELD) 331\r\n'};
  const saved = (await request(proposalRouter,'POST','/1/proposals',scoped.token,submission)).body;
  const review = {operationId:randomUUID(),expectedProposalRevision:saved.proposalRevision,
    expectedLatestSnapshotId:saved.currentLatestSnapshotId,expectedLatestTextHash:saved.currentLatestTextHash,action:'accept'};
  const path = `/1/proposals/${saved.proposalId}/review`;
  const accepted = await request(proposalRouter,'POST',path,sessions[1],review);
  expect(accepted.status).toBe(200);
  expect(accepted.body.status).toBe('accepted');
  const replay = await request(proposalRouter,'POST',path,sessions[1],review);
  expect(replay.body.resultSnapshotId).toBe(accepted.body.resultSnapshotId);
  const [deck] = (await request(structuredRouter,'GET','/decks',scoped.token)).body.decks;
  expect(deck.latestSnapshotId).toBe(accepted.body.resultSnapshotId);
  expect(deck.paperSnapshotId).toBe('1');
  expect(deck.snapshots[0]).toMatchObject({deckText:submission.proposedText,isLatest:true,isPaper:false,
    origin:{source:'manasync',proposalId:saved.proposalId,operationId:submission.operationId}});
  expect(deck.snapshots).toHaveLength(2);
});

async function creationPayload(token, overrides = {}) {
  const context = (await request(structuredRouter, 'GET', '/context', token)).body;
  return { operationId: randomUUID(), expectedInstanceId: context.instanceId,
    expectedAccountId: context.accountId, name: '  New manual deck  ', deckText: 'Commander\r\n1 Test Commander\r\nMainboard\r\n1 Sol Ring\r\n// exact note  \r\n', ...overrides };
}

it('requires a separate creation grant, pins the destination, and returns one exact manual digital deck', async () => {
  const ordinary = await issue(1, ['decks:read', 'decks:propose']);
  const creator = await issue(1, ['decks:read', 'decks:create']);
  const input = await creationPayload(creator.token);
  expect((await request(structuredRouter, 'POST', '/decks', ordinary.token, input)).status).toBe(403);
  expect((await request(structuredRouter, 'POST', '/decks', sessions[1], input)).status).toBe(403);
  expect((await request(structuredRouter, 'GET', '/context', sessions[1])).body.scopes).toEqual(['decks:read', 'decks:propose']);
  const other = await issue(2, ['decks:read', 'decks:create']);
  for (const [token, payload] of [[other.token, input], [creator.token, { ...input, expectedInstanceId: randomUUID() }]]) {
    expect((await request(structuredRouter, 'POST', '/decks', token, payload)).body.error).toBe('connection_changed');
  }
  const result = await request(structuredRouter, 'POST', '/decks', creator.token, input);
  expect(result.status).toBe(201);
  expect(result.body).toMatchObject({ accountId: '1', instanceId: input.expectedInstanceId,
    operationId: input.operationId, replayed: false, capabilities: { deckCreation: true }, scopes: ['decks:create', 'decks:read'] });
  const [created] = result.body.decks;
  expect(created).toMatchObject({ name: input.name, url: null, paperSnapshotId: null });
  expect(created.snapshots).toHaveLength(1);
  expect(created.snapshots[0]).toMatchObject({ deckText: input.deckText, textHash: hash(input.deckText), isLatest: true, isPaper: false });
  expect(db.get('SELECT * FROM tracked_decks WHERE id = ?', [created.id])).toMatchObject({ source_type: 'manual', archidekt_deck_id: -1, auto_refresh_hours: null, paper_snapshot_id: null });
  expect((await request(ownerRouter, 'GET', '/', sessions[1])).body.owners).toHaveLength(1);
  const listed = (await request(deckRouter, 'GET', '/', sessions[1])).body.decks.find(deck => String(deck.id) === created.id);
  expect(listed.archidekt_username).toBe('Manual decks');
  expect(db.get('SELECT COUNT(*) AS count FROM collection_cards').count).toBe(0);
  expect((await request(structuredRouter, 'GET', '/decks', other.token)).body.decks).toHaveLength(1);
});

it('replays the same creation after token rotation and restart, conflicts on edits, and never resurrects deleted decks', async () => {
  const creator = await issue(1, ['decks:read', 'decks:create']);
  const input = await creationPayload(creator.token);
  const first = await request(structuredRouter, 'POST', '/decks', creator.token, input);
  await request(tokenRouter, 'DELETE', `/${creator.id}`, sessions[1]);
  expect((await request(structuredRouter, 'POST', '/decks', creator.token, input)).status).toBe(401);
  const replacement = await issue(1, ['decks:read', 'decks:create']);
  vi.resetModules();
  db = await import('../db.js'); await db.initDb();
  structuredRouter = (await import('./structuredDecks.js')).default;
  const replay = await request(structuredRouter, 'POST', '/decks', replacement.token, input);
  expect(replay.status).toBe(200);
  expect(replay.body.decks).toEqual(first.body.decks);
  expect(replay.body.replayed).toBe(true);
  for (const changed of [{ ...input, deckText: input.deckText.trim() }, { ...input, name: 'Changed' }, { ...input, extra: true }]) {
    expect((await request(structuredRouter, 'POST', '/decks', replacement.token, changed)).body.error).toBe('operation_conflict');
  }
  db.run('DELETE FROM tracked_decks WHERE id = ?', [first.body.decks[0].id]);
  expect((await request(structuredRouter, 'POST', '/decks', replacement.token, input)).status).toBe(410);
  expect(db.get('SELECT COUNT(*) AS count FROM tracked_decks').count).toBe(2);
  db.run('DELETE FROM users WHERE id = 1');
  expect(db.get('SELECT COUNT(*) AS count FROM integration_deck_creations').count).toBe(0);
});

it('allows an empty initial draft, assigns distinct local IDs, and blocks manual upstream refreshes', async () => {
  const creator = await issue(1, ['decks:read', 'decks:create']);
  const input = await creationPayload(creator.token, { deckText: '' });
  const first = await request(structuredRouter, 'POST', '/decks', creator.token, input);
  const deckId = first.body.decks[0].id;
  expect(first.body.decks[0].snapshots[0]).toMatchObject({ deckText: '', cards: [] });
  await request(structuredRouter, 'POST', '/decks', creator.token, { ...input, operationId: randomUUID() });
  expect(db.all("SELECT archidekt_deck_id FROM tracked_decks WHERE source_type = 'manual' ORDER BY id").map(row => row.archidekt_deck_id)).toEqual([-1, -2]);
  expect(db.get("SELECT COUNT(*) AS count FROM tracked_owners WHERE source_type = 'manual'").count).toBe(1);
  const { fetchDeck, fetchOwnerDecks } = await import('../lib/archidekt.js');
  fetchDeck.mockClear(); fetchOwnerDecks.mockClear();
  expect((await request(deckRouter, 'POST', `/${deckId}/refresh`, sessions[1], {})).body.error).toBe('manual_deck_has_no_upstream');
  expect((await request(deckRouter, 'PATCH', `/${deckId}`, sessions[1], { autoRefreshHours: 6 })).status).toBe(409);
  const owner = db.get("SELECT id FROM tracked_owners WHERE source_type = 'manual'");
  expect((await request(ownerRouter, 'GET', `/${owner.id}/decks`, sessions[1])).status).toBe(409);
  db.run("DELETE FROM tracked_decks WHERE source_type = 'archidekt'");
  expect((await request(deckRouter, 'POST', '/refresh-all', sessions[1], {})).body.summary.total).toBe(0);
  expect(fetchDeck).not.toHaveBeenCalled(); expect(fetchOwnerDecks).not.toHaveBeenCalled();
});

it('rejects invalid creation requests and rolls back the deck, snapshot, and manual owner if receipt persistence fails', async () => {
  const creator = await issue(1, ['decks:read', 'decks:create']);
  const input = await creationPayload(creator.token);
  for (const change of [{ name: ' ' }, { name: 'a'.repeat(201) }, { deckText: 'a'.repeat(500001) }, { operationId: 'invalid' }, { paperSnapshotId: '1' }]) {
    expect((await request(structuredRouter, 'POST', '/decks', creator.token, { ...input, ...change })).status).toBe(400);
  }
  db.run("CREATE TRIGGER fail_creation BEFORE INSERT ON integration_deck_creations BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
  await expect(request(structuredRouter, 'POST', '/decks', creator.token, input)).rejects.toThrow('receipt failure');
  expect(db.get('SELECT COUNT(*) AS count FROM tracked_decks').count).toBe(2);
  expect(db.get('SELECT COUNT(*) AS count FROM deck_snapshots').count).toBe(2);
  expect(db.get("SELECT COUNT(*) AS count FROM tracked_owners WHERE source_type = 'manual'").count).toBe(0);
});

it('exposes complete canonical source metadata and reuses a tracked Archidekt deck without changing its history', async () => {
  const creator = await issue(1, ['decks:read', 'decks:create']);
  db.run('UPDATE tracked_decks SET paper_snapshot_id = 1, deck_url = ? WHERE id = 1', ['https://archidekt.com/decks/1/old-title']);
  const input = await creationPayload(creator.token, { sourceLink: { provider: 'archidekt', deckId: '001', url: 'https://www.archidekt.com/decks/1/new-title?share=1' } });
  const first = await request(structuredRouter, 'POST', '/decks', creator.token, input);
  expect(first).toMatchObject({ status: 200, body: { linkedExisting: true, replayed: false, capabilities: { sourceLinks: true } } });
  expect(first.body.decks[0]).toMatchObject({ id: '1', name: 'Deck 1', paperSnapshotId: '1',
    sourceLink: { provider: 'archidekt', deckId: '1', url: 'https://archidekt.com/decks/1' } });
  expect(first.body.decks[0].snapshots[0].deckText).toBe('1 Sol Ring (CMM) 410\r\n');
  expect(db.get('SELECT COUNT(*) AS count FROM tracked_decks').count).toBe(2);
  expect(db.get('SELECT COUNT(*) AS count FROM deck_snapshots').count).toBe(2);
  expect(db.get('SELECT COUNT(*) AS count FROM tracked_owners').count).toBe(2);
  db.run('INSERT INTO deck_snapshots (tracked_deck_id,deck_text) VALUES (?,?)', [1, '1 Later owner edit']);
  const replay = await request(structuredRouter, 'POST', '/decks', creator.token, { ...input,
    sourceLink: { url: 'https://archidekt.com/decks/1', deckId: '1', provider: 'archidekt' } });
  expect(replay.body).toMatchObject({ linkedExisting: true, replayed: true, decks: first.body.decks });
  expect((await request(structuredRouter, 'POST', '/decks', creator.token, { ...input, sourceLink: { provider: 'archidekt', deckId: '2', url: 'https://archidekt.com/decks/2' } })).body.error).toBe('operation_conflict');
  const latest = (await request(structuredRouter, 'GET', '/decks', creator.token)).body;
  expect(latest.capabilities.sourceLinks).toBe(true);
  expect(latest.decks[0].snapshots[0].deckText).toBe('1 Later owner edit');
});

it('persists per-account manual source bindings and deduplicates new operation IDs after restart', async () => {
  const creator = await issue(1, ['decks:read', 'decks:create']);
  const other = await issue(2, ['decks:read', 'decks:create']);
  const sourceLink = { provider: 'moxfield', deckId: 'Shared_AbC', url: 'https://www.moxfield.com/decks/Shared_AbC?share=1' };
  const input = await creationPayload(creator.token, { sourceLink });
  const first = await request(structuredRouter, 'POST', '/decks', creator.token, input);
  expect(first).toMatchObject({ status: 201, body: { linkedExisting: false } });
  expect(first.body.decks[0]).toMatchObject({ sourceLink: { ...sourceLink, url: 'https://moxfield.com/decks/Shared_AbC' }, paperSnapshotId: null });
  const separate = await request(structuredRouter, 'POST', '/decks', other.token, await creationPayload(other.token, { sourceLink }));
  expect(separate.body.decks[0].id).not.toBe(first.body.decks[0].id);
  vi.resetModules();
  db = await import('../db.js'); await db.initDb();
  const schema = await import('../lib/integrationSchema.js'); schema.initIntegrationSchema(); schema.initIntegrationSchema();
  structuredRouter = (await import('./structuredDecks.js')).default;
  const reused = await request(structuredRouter, 'POST', '/decks', creator.token, { ...input, operationId: randomUUID(), deckText: '1 Different proposed list' });
  expect(reused).toMatchObject({ status: 200, body: { linkedExisting: true, decks: first.body.decks } });
  expect(db.get('SELECT COUNT(*) AS count FROM integration_deck_sources').count).toBe(2);
  const manual = await request(structuredRouter, 'POST', '/decks', creator.token, { ...input, operationId: randomUUID(), sourceLink: null });
  expect(manual.body.decks[0].sourceLink).toBeNull();
  db.run('DELETE FROM tracked_decks WHERE id = ?', [first.body.decks[0].id]);
  expect((await request(structuredRouter, 'POST', '/decks', creator.token, input)).status).toBe(410);
  expect(db.get('SELECT COUNT(*) AS count FROM integration_deck_sources').count).toBe(1);
});

it('rejects ambiguous existing sources and invalid claims without creating or merging decks', async () => {
  const creator = await issue(1, ['decks:read', 'decks:create']);
  const input = await creationPayload(creator.token);
  for (const sourceLink of [false, {}, { provider: 'archidekt', deckId: '1', url: 'https://moxfield.com/decks/1' },
    { provider: 'deckcheck', deckId: 'abc', url: 'https://deckcheck.co/deck/other' }]) {
    expect((await request(structuredRouter, 'POST', '/decks', creator.token, { ...input, sourceLink })).body.error).toBe('invalid_source_link');
  }
  const manual = await request(structuredRouter, 'POST', '/decks', creator.token, input);
  db.run('INSERT INTO integration_deck_sources (deck_id,user_id,provider,source_deck_id,canonical_url) VALUES (?,?,?,?,?)',
    [manual.body.decks[0].id, 1, 'archidekt', '1', 'https://archidekt.com/decks/1']);
  const duplicate = await request(structuredRouter, 'POST', '/decks', creator.token, { ...input, operationId: randomUUID(),
    sourceLink: { provider: 'archidekt', deckId: '1', url: 'https://archidekt.com/decks/1' } });
  expect(duplicate).toMatchObject({ status: 409, body: { error: 'source_identity_conflict' } });
  expect(db.get('SELECT COUNT(*) AS count FROM tracked_decks').count).toBe(3);
  expect(db.get('SELECT COUNT(*) AS count FROM integration_deck_creations').count).toBe(1);
});

it('rolls source binding and snapshot creation back together if the durable receipt cannot be saved', async () => {
  const creator = await issue(1, ['decks:read', 'decks:create']);
  const input = await creationPayload(creator.token, { sourceLink: { provider: 'deckcheck', deckId: 'abc123', url: 'https://deckcheck.co/app/deckview/abc123' } });
  db.run("CREATE TRIGGER fail_source_creation BEFORE INSERT ON integration_deck_creations BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
  await expect(request(structuredRouter, 'POST', '/decks', creator.token, input)).rejects.toThrow('receipt failure');
  expect(db.get('SELECT COUNT(*) AS count FROM tracked_decks').count).toBe(2);
  expect(db.get('SELECT COUNT(*) AS count FROM integration_deck_sources').count).toBe(0);
  expect(db.get('SELECT COUNT(*) AS count FROM deck_snapshots').count).toBe(2);
});
