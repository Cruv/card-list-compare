import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const hash = value => createHash('sha256').update(value).digest('hex');
const accountId = '00000000-0000-4000-8000-000000000013';
const otherAccount = '00000000-0000-4000-8000-000000000014';
const container = {id:'00000000-0000-4000-8000-000000000012',kind:'unassigned'};
const response = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
let dir, db, bridge, plans, artwork, jobId, pending, requests, receipts, failure, serverAccount, assetHashes;

function remoteDecision(value,body,actor,kind='confirm') {
  const key = `${actor}:${body.operationId}`;
  if (receipts.has(key)) return {pending:value,receipt:receipts.get(key)};
  if (body.expectedRevision !== value.revision) return {error:'Pending print changed',code:'pending_changed'};
  if (!value.remainingQuantity || (kind === 'confirm' && body.quantity > value.remainingQuantity)) return {error:'No copies remain',code:'pending_unavailable'};
  const receipt = {operationId:body.operationId,revision:receipts.size+1,changes:[]};
  if (kind === 'confirm') {
    const lotId = randomUUID();
    value.confirmations.push({operationId:body.operationId,actorId:actor,quantity:body.quantity,lotId,createdAt:new Date().toISOString()});
    value.confirmedQuantity += body.quantity;
    value.remainingQuantity -= body.quantity;
    receipt.changes.push({entity:'lots',id:lotId,value:{id:lotId,isProxy:true,quantity:body.quantity}});
    value.status = value.remainingQuantity ? 'partial' : 'confirmed';
  } else {
    value.dismissedQuantity += value.remainingQuantity; value.remainingQuantity = 0; value.status = 'dismissed';
  }
  value.revision += 1;
  receipts.set(key,receipt);
  return {pending:value,receipt};
}

async function fakeManaSync(url,options) {
  const actor = options.headers.Authorization.slice(7);
  if (url.endsWith('/integration/context')) return response({user:{id:serverAccount,username:'alice'},actorId:actor,scopes:['inventory:read','proxies:write']});
  if (url.endsWith('/containers')) return response({containers:[container]});
  requests.push({url,...options});
  const assetHash = new URL(url).pathname.match(/\/proxy-art\/([a-f0-9]{64})$/)?.[1];
  if (assetHash) {
    expect(hash(options.body)).toBe(assetHash);
    assetHashes.add(assetHash);
    return response({sha256:assetHash,url:`/api/v1/proxy-art/${serverAccount}/${assetHash}`,contentType:'image/png',bytes:options.body.length});
  }
  const match = new URL(url).pathname.match(/\/pending-proxies\/([^/]+)(?:\/(confirm|dismiss))?$/);
  if (match) {
    const [,id,action] = match;
    if (failure === 'unsupported') return response({error:'Unsupported'},404);
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      expect(assetHashes.has(body.card.proxyArtwork.front.split('/').at(-1))).toBe(true);
      if (!pending.has(id)) pending.set(id,{id,...body,confirmedQuantity:0,dismissedQuantity:0,remainingQuantity:body.quantity,
        status:'pending',revision:1,confirmations:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
      if (failure === 'create-lost') { failure = null; throw new Error('Create response lost'); }
      return response({pending:pending.get(id)});
    }
    const value = pending.get(id);
    if (!value) return response({error:'Missing'},404);
    if (!action) return response({pending:value});
    const result = remoteDecision(value,JSON.parse(options.body),actor,action);
    if (result.error) return response(result,409);
    if (failure === `${action}-lost`) { failure = null; throw new Error('Decision response lost'); }
    return response(result);
  }
  const receiptId = new URL(url).pathname.match(/\/inventory\/operations\/([^/]+)$/)?.[1];
  if (receiptId) {
    const receipt = receipts.get(`${new URL(url).searchParams.get('actorId')}:${receiptId}`);
    return receipt ? response(receipt) : response({error:'Missing'},404);
  }
  if (url.endsWith('/inventory')) return response({lots:[]});
  throw new Error(`Unexpected request ${url}`);
}

beforeEach(async () => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(),'clc-pending-proxies-'));
  vi.stubEnv('DB_PATH',join(dir,'clc.db')); vi.stubEnv('PRINT_JOBS_DIR',join(dir,'jobs'));
  vi.stubEnv('MANASYNC_BRIDGE_KEY',Buffer.alloc(32,9).toString('base64'));
  db = await import('../db.js'); await db.initDb();
  (await import('./integrationSchema.js')).initIntegrationSchema();
  bridge = await import('./manasyncBridge.js'); bridge.initBridgeSchema();
  artwork = await import('./printJobBridge.js'); plans = await import('./pendingProxyPlans.js');
  db.run("INSERT INTO users(id,username,password_hash) VALUES(1,'alice','h'),(2,'bob','h')");
  db.run("INSERT INTO tracked_owners(id,user_id,archidekt_username) VALUES(1,1,'alice')");
  db.run("INSERT INTO tracked_decks(id,user_id,tracked_owner_id,archidekt_deck_id,deck_name) VALUES(1,1,1,1,'My deck')");
  jobId = randomUUID();
  mkdirSync(join(dir,'jobs',jobId,'images'),{recursive:true});
  const front = {sha256:hash(PNG),fileName:`images/${hash(PNG)}.png`,format:'png',size:PNG.length,source:'saved-mpc',identifier:'my-art',face:'front'};
  writeFileSync(join(dir,'jobs',jobId,front.fileName),PNG);
  const plan = {totalCopies:3};
  const manifest = JSON.stringify({version:1,jobId,requesterId:1,plan,copies:[1,2,3].map(id => ({id:String(id),displayName:'Sol Ring',setCode:'c21',collectorNumber:'263',front}))});
  db.run(`INSERT INTO print_jobs(id,user_id,tracked_deck_id,request_key,request_hash,plan_json,state,manifest_json,manifest_sha256,created_at,updated_at)
    VALUES(?,1,1,?,'hash',?,'ready',?,?,'2026-09-09','2026-09-09')`,[jobId,randomUUID(),JSON.stringify(plan),manifest,hash(manifest)]);
  pending = new Map(); requests = []; receipts = new Map(); failure = null; serverAccount = accountId; assetHashes = new Set();
  vi.stubGlobal('fetch',vi.fn(fakeManaSync));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir,{recursive:true,force:true}); });
const connect = (token='actor-one',baseUrl='https://mana.example/prefix') => bridge.connect(1,{baseUrl,token});
const expected = () => { const value = bridge.connectionStatus(1); return value.connected ? {accountId:value.accountId,actorId:value.actorId,baseUrl:value.baseUrl} : null; };
const first = () => bridge.listQueue(1)[0];
const confirm = (quantity=1,operationId=randomUUID(),revision=first().pendingProxy.revision) => bridge.confirmIncrement(1,first().id,
  {operationId,quantity,expectedRevision:revision,expectedConnection:expected()});
const publish = async () => { await connect(); await plans.processPendingProxyPlans(); return first(); };

describe('native pending proxy plans',() => {
  it('automatically stages ready PDFs disconnected, then publishes actual art without acquiring stock',async () => {
    await plans.processPendingProxyPlans();
    const item = first();
    expect(item.pendingProxy).toMatchObject({status:'disconnected',confirmedQuantity:0,remainingQuantity:3});
    expect(requests).toHaveLength(0);
    await expect(confirm(1,randomUUID(),1)).rejects.toThrow('Wait for this print plan');
    await connect(); await plans.refreshPendingProxyPlans(1);
    expect(first().pendingProxy).toMatchObject({status:'pending',revision:1,confirmedQuantity:0,remainingQuantity:3,accountId});
    expect(pending.get(item.id).card.proxyArtwork.front).toBe(`/api/v1/proxy-art/${accountId}/${hash(PNG)}`);
    expect(requests.map(request => request.method)).toEqual(['PUT','PUT']);
    expect(receipts.size).toBe(0); expect(first().operations).toEqual([]);
  });

  it('retains a suspended user’s print plan locally and publishes the same item after reinstatement',async () => {
    await connect(); db.run('UPDATE users SET suspended=1 WHERE id=1');
    fetch.mockClear(); await plans.processPendingProxyPlans();
    const item = first();
    expect(item.pendingProxy.remainingQuantity).toBe(3);
    expect(fetch).not.toHaveBeenCalled();
    await plans.refreshPendingProxyPlans(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(db.get('SELECT attempts FROM manasync_pending_proxy_plans WHERE item_id=?',[item.id]).attempts).toBe(0);
    db.run('UPDATE users SET suspended=0 WHERE id=1');
    await plans.processPendingProxyPlans();
    expect(first().id).toBe(item.id);
    expect(pending.get(item.id)).toMatchObject({quantity:3,confirmedQuantity:0,status:'pending'});
    expect(receipts.size).toBe(0);
  });

  it.each(['confirm','dismiss'])('pauses suspended users’ pending %s decisions and resumes the same payload',async kind => {
    await publish();
    fetch.mockImplementation((url,options) => url.endsWith(`/${kind}`) ? Promise.reject(new Error('Offline before delivery')) : fakeManaSync(url,options));
    if (kind === 'confirm') await confirm(1);
    else await bridge.cancelItem(1,first().id);
    db.run('UPDATE manasync_print_operations SET next_attempt=0');
    db.run('UPDATE manasync_pending_proxy_plans SET next_attempt=0');
    const original = db.get('SELECT * FROM manasync_print_operations');
    expect(original.status).toBe('pending');
    db.run('UPDATE users SET suspended=1 WHERE id=1');
    fetch.mockImplementation(fakeManaSync); fetch.mockClear();
    await bridge.processPending(); await bridge.reportOperation(1,original.id,true);
    expect(fetch).not.toHaveBeenCalled();
    expect(db.get('SELECT * FROM manasync_print_operations')).toEqual(original);
    db.run('UPDATE users SET suspended=0 WHERE id=1');
    await bridge.processPending();
    const delivery = requests.find(request => request.url.endsWith(`/${kind}`));
    expect(delivery.body).toBe(original.payload_json);
    expect(delivery.headers.Authorization).toBe('Bearer actor-one');
    expect(db.get('SELECT status FROM manasync_print_operations').status).toBe('reported');
    expect(receipts.size).toBe(1);
  });

  it('confirms usable quantities only by remote pending endpoint and retains partial/external history',async () => {
    const item = await publish();
    expect((await confirm(1)).status).toBe('reported');
    expect(first()).toMatchObject({confirmed:1,remaining:2,pendingProxy:{status:'partial',revision:2}});
    const external = 'external-reviewed-print-quantity';
    remoteDecision(pending.get(item.id),{operationId:external,quantity:2,expectedRevision:2},'session-owner');
    await plans.refreshPendingProxyPlans(1);
    expect(first()).toMatchObject({confirmed:3,remaining:0,pendingProxy:{status:'confirmed',revision:3}});
    expect(first().pendingProxy.confirmations).toHaveLength(2);
    expect(first().pendingProxy.confirmations[1].operationId).toBe(external);
    expect(requests.some(request => request.url.includes('/inventory/commands'))).toBe(false);
  });

  it('rejects a stale CLC decision after ManaSync confirms first, then uses the newly reviewed revision',async () => {
    const item = await publish();
    remoteDecision(pending.get(item.id),{operationId:randomUUID(),quantity:2,expectedRevision:1},'session-owner');
    const result = await confirm(2);
    expect(result.status).toBe('review');
    expect(receipts.size).toBe(1);
    expect(first()).toMatchObject({confirmed:2,remaining:1,pendingProxy:{revision:2,actionPending:false}});
    expect((await confirm(1)).status).toBe('reported');
    expect(receipts.size).toBe(2);
  });

  it('replays exact confirmation body and original actor after lost response without double counting',async () => {
    await publish(); failure = 'confirm-lost';
    const id = randomUUID(); expect((await confirm(2,id)).status).toBe('pending');
    const original = db.get('SELECT * FROM manasync_print_operations WHERE id=?',[id]);
    expect(first().pendingProxy.actionPending).toBe(true);
    await expect(confirm(1)).rejects.toThrow('outstanding quantity decision');
    await bridge.reportOperation(1,id,true);
    const final = db.get('SELECT * FROM manasync_print_operations WHERE id=?',[id]);
    expect(final.status).toBe('reported'); expect(final.payload_json).toBe(original.payload_json);
    expect(receipts.size).toBe(1); expect(first().confirmed).toBe(2);
    const deliveries = requests.filter(request => request.url.endsWith('/confirm'));
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every(request => request.body === original.payload_json && request.headers.Authorization === 'Bearer actor-one')).toBe(true);
  });

  it('reconciles lost confirmation with a replacement token and permits a new decision by that token',async () => {
    await publish(); failure = 'confirm-lost';
    const original = await confirm(1);
    await connect('actor-two');
    await bridge.reportOperation(1,original.id,true);
    expect(first().operations[0].status).toBe('reconnect');
    await plans.refreshPendingProxyPlans(1);
    expect(first().operations[0].status).toBe('reported');
    expect(first().pendingProxy.actionPending).toBe(false);
    expect((await confirm(2)).status).toBe('reported');
    const deliveries = requests.filter(request => request.url.endsWith('/confirm'));
    expect(deliveries.map(request => request.headers.Authorization)).toEqual(['Bearer actor-one','Bearer actor-two']);
  });

  it('resolves a lost create with a replacement actor using the same account and immutable payload',async () => {
    await connect(); failure = 'create-lost'; await plans.processPendingProxyPlans();
    const item = first(), saved = db.get('SELECT * FROM manasync_pending_proxy_plans WHERE item_id=?',[item.id]);
    expect(item.pendingProxy.status).toBe('error'); expect(pending.size).toBe(1);
    await connect('actor-two'); await plans.refreshPendingProxyPlans(1);
    expect(first().pendingProxy.status).toBe('pending');
    expect(db.get('SELECT create_payload FROM manasync_pending_proxy_plans WHERE item_id=?',[item.id]).create_payload).toBe(saved.create_payload);
    expect(requests.filter(request => request.url.includes('/pending-proxies/') && request.method === 'PUT')).toHaveLength(1);
    expect((await confirm()).status).toBe('reported');
  });

  it('never publishes a frozen plan to a different account or backend after uncertain delivery',async () => {
    await connect(); failure = 'create-lost'; await plans.processPendingProxyPlans();
    const saved = db.get('SELECT * FROM manasync_pending_proxy_plans');
    serverAccount = otherAccount; await connect('other-token');
    const count = requests.length; await plans.refreshPendingProxyPlans(1);
    expect(requests).toHaveLength(count); expect(first().pendingProxy.status).toBe('disconnected');
    serverAccount = accountId; await connect('actor-one','https://different.example'); await plans.refreshPendingProxyPlans(1);
    expect(requests).toHaveLength(count);
    expect(db.get('SELECT * FROM manasync_pending_proxy_plans').create_payload).toBe(saved.create_payload);
  });

  it('dismisses the remaining remote copies with an immutable retry after lost response',async () => {
    await publish(); await confirm(1); failure = 'dismiss-lost';
    await bridge.cancelItem(1,first().id);
    const action = db.get("SELECT * FROM manasync_print_operations WHERE kind='dismiss'");
    expect(action.status).toBe('pending'); expect(pending.get(first().id).status).toBe('dismissed');
    await bridge.reportOperation(1,action.id,true);
    expect(first()).toMatchObject({confirmed:1,remaining:0,cancelled:true,pendingProxy:{status:'dismissed',dismissedQuantity:2,actionPending:false}});
    expect(receipts.size).toBe(2);
    expect(requests.filter(request => request.url.endsWith('/dismiss')).every(request => request.body === action.payload_json)).toBe(true);
  });

  it('persists disconnected dismissal and resolves lost publication before dismissing remotely',async () => {
    await connect(); failure = 'create-lost'; await plans.processPendingProxyPlans();
    bridge.disconnect(1); await bridge.cancelItem(1,first().id);
    expect(first().pendingProxy.actionPending).toBe(true);
    expect(pending.get(first().id).remainingQuantity).toBe(3);
    await connect(); await plans.refreshPendingProxyPlans(1);
    expect(first().pendingProxy).toMatchObject({status:'dismissed',dismissedQuantity:3,remainingQuantity:0});
    expect(requests.filter(request => request.url.endsWith('/dismiss'))).toHaveLength(1);
  });

  it('lets an explicit revision-locked dismissal close a confirmation that never reached ManaSync',async () => {
    await publish();
    const originalFetch = fetch.getMockImplementation();
    fetch.mockImplementation((url,options) => url.endsWith('/confirm') ? Promise.reject(new Error('Offline before delivery')) : originalFetch(url,options));
    const original = await confirm(1);
    expect(original.status).toBe('pending');
    fetch.mockImplementation(fakeManaSync);
    await connect('actor-two');
    await bridge.cancelItem(1,first().id);
    expect(first().pendingProxy).toMatchObject({status:'dismissed',confirmedQuantity:0,dismissedQuantity:3});
    // Reconnecting and replaying the original frozen confirmation cannot reopen a dismissed plan.
    await connect('actor-one'); await bridge.reportOperation(1,original.id,true);
    expect(first().operations.find(operation => operation.id === original.id).status).toBe('review');
    expect(receipts.size).toBe(1);
  });

  it('locally dismisses never published plans and preserves that decision on manifest replay',async () => {
    await plans.processPendingProxyPlans(); await bridge.cancelItem(1,first().id);
    artwork.stagePrintJob(1,jobId); await connect(); await plans.refreshPendingProxyPlans(1);
    expect(first().pendingProxy).toMatchObject({status:'dismissed',dismissedQuantity:3});
    expect(requests).toHaveLength(0);
  });

  it('does not republish old staged acquisitions, including unresolved local confirmations',async () => {
    const item = artwork.stagePrintJob(1,jobId).items[0];
    db.run('DELETE FROM manasync_pending_proxy_plans');
    const old = await bridge.confirmIncrement(1,item.id,{operationId:randomUUID(),quantity:1,expectedConnection:null});
    artwork.stagePrintJob(1,jobId);
    expect(first().pendingProxy.status).toBe('legacy');
    await connect(); await plans.processPendingProxyPlans();
    expect(first().operations[0].id).toBe(old.id); expect(pending.size).toBe(0);
  });

  it('publishes retained artwork after restart and source expiry without changing the frozen card',async () => {
    await plans.processPendingProxyPlans();
    const original = first(); rmSync(join(dir,'jobs',jobId),{recursive:true});
    db.run("UPDATE print_jobs SET state='expired' WHERE id=?",[jobId]);
    vi.resetModules(); db = await import('../db.js'); await db.initDb();
    bridge = await import('./manasyncBridge.js'); bridge.initBridgeSchema(); plans = await import('./pendingProxyPlans.js');
    await connect(); await plans.refreshPendingProxyPlans(1);
    expect(first().id).toBe(original.id); expect(pending.get(original.id).card.proxyArtwork.front).toContain(hash(PNG));
    expect((await confirm()).status).toBe('reported');
  });

  it('shows unsupported pending APIs without silently acquiring or discarding artwork',async () => {
    await connect(); failure = 'unsupported'; await plans.processPendingProxyPlans();
    expect(first().pendingProxy).toMatchObject({status:'error',error:expect.stringContaining('Update ManaSync')});
    await expect(confirm(1,randomUUID(),1)).rejects.toThrow('Wait for this print plan');
    expect(first().operations).toEqual([]); expect(pending.size).toBe(0);
    failure = null; await plans.refreshPendingProxyPlans(1);
    expect(first().pendingProxy.status).toBe('pending');
  });

  it('counts retained artwork against the aggregate storage cap before copying any new bytes',async () => {
    vi.stubEnv('PRINT_STORAGE_MAX_MB','1'); vi.resetModules();
    const currentDb = await import('../db.js'); await currentDb.initDb();
    artwork = await import('./printJobBridge.js');
    const retained = join(dir,'manasync-artwork','2'); mkdirSync(retained,{recursive:true});
    writeFileSync(join(retained,'existing.png'),Buffer.alloc(1024*1024-PNG.length));
    // Native source bytes already use the remaining capacity; retaining them would exceed it.
    await expect((await import('./pendingProxyPlans.js')).stagePreparedPrintJob(1,jobId)).resolves.toBe(null);
    expect(readdirSync(join(dir,'manasync-artwork'))).toEqual(['2']);
    // Reloading modules reopened the shared persisted database.
    expect(currentDb.get('SELECT proxy_staging_error FROM print_jobs WHERE id=?',[jobId]).proxy_staging_error).toContain('including retained ManaSync artwork');
    expect(currentDb.all('SELECT * FROM manasync_print_items')).toEqual([]);
  });
});
