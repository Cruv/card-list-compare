import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const hash = value => createHash('sha256').update(value).digest('hex');
const accountId = '00000000-0000-4000-8000-000000000013';
const otherAccount = '00000000-0000-4000-8000-000000000014';
const container = {id:'00000000-0000-4000-8000-000000000012',kind:'unassigned'};
const response = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const localFetch = globalThis.fetch;
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
  if (url.endsWith('/pending-proxies')) return response({items:[...pending.values()]});
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
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir,{recursive:true,force:true}); });
const connect = (token='actor-one',baseUrl='https://mana.example/prefix') => bridge.connect(1,{baseUrl,token});
const expected = () => { const value = bridge.connectionStatus(1); return value.connected ? {accountId:value.accountId,actorId:value.actorId,baseUrl:value.baseUrl} : null; };
const first = () => bridge.listQueue(1)[0];
const confirm = (quantity=1,operationId=randomUUID(),revision=first().pendingProxy.revision) => bridge.confirmIncrement(1,first().id,
  {operationId,quantity,expectedRevision:revision,expectedConnection:expected()});
const publish = async () => { await connect(); await plans.processPendingProxyPlans(); return first(); };

describe('native pending proxy plans',() => {
  it.each(['backs_pending','awaiting_paper_reset'])('retains ManaSync pending plans while native printing is %s',async state => {
    db.run('UPDATE print_jobs SET state=? WHERE id=?',[state,jobId]);
    const item = await publish();
    expect(item.printJobId).toBe(jobId);
    expect(item.pendingProxy.status).toBe('pending');
    expect(pending.size).toBe(1);
  });
  it('publishes and confirms a standalone batch with its frozen label and no fabricated deck',async () => {
    const label = 'Friday proxy replacements 🐉';
    const listText = '3 Sol Ring (C21) 263';
    const row = db.get('SELECT manifest_json FROM print_jobs WHERE id=?',[jobId]);
    const manifest = JSON.parse(row.manifest_json);
    manifest.plan = { ...manifest.plan, mode:'adhoc', deckId:null, deckName:label, source:null, target:null,
      list:{name:label,text:listText,textHash:hash(listText)} };
    const frozen = JSON.stringify(manifest);
    db.run('UPDATE print_jobs SET tracked_deck_id=NULL,plan_json=?,manifest_json=?,manifest_sha256=? WHERE id=?',
      [JSON.stringify(manifest.plan),frozen,hash(frozen),jobId]);
    db.run('DELETE FROM tracked_decks'); db.run('DELETE FROM tracked_owners');
    await plans.processPendingProxyPlans();
    const staged = first();
    expect(staged).toMatchObject({deckId:null,printJobId:jobId,confirmed:0,remaining:3});
    expect(bridge.listQueue(2)).toEqual([]);
    await connect(); failure = 'create-lost'; await plans.processPendingProxyPlans();
    const original = db.get('SELECT create_payload FROM manasync_pending_proxy_plans WHERE item_id=?',[staged.id]).create_payload;
    expect(JSON.parse(original)).toMatchObject({label,source:'clc',sourceRef:jobId,quantity:3});
    expect(original).not.toContain(listText); expect(original).not.toContain('textHash');
    expect(receipts.size).toBe(0);
    // A restarted publisher reconciles the same remote plan, not another batch.
    vi.resetModules(); db = await import('../db.js'); await db.initDb();
    bridge = await import('./manasyncBridge.js'); bridge.initBridgeSchema(); plans = await import('./pendingProxyPlans.js');
    await plans.refreshPendingProxyPlans(1);
    expect(first().id).toBe(staged.id);
    expect(db.get('SELECT create_payload FROM manasync_pending_proxy_plans WHERE item_id=?',[staged.id]).create_payload).toBe(original);
    const operationId = randomUUID();
    expect((await confirm(2,operationId,1)).status).toBe('reported');
    expect((await confirm(2,operationId,1)).status).toBe('reported');
    expect(first()).toMatchObject({deckId:null,confirmed:2,remaining:1});
    expect(receipts.size).toBe(1);
    await bridge.cancelItem(1,first().id);
    expect(first()).toMatchObject({confirmed:2,remaining:0,pendingProxy:{status:'dismissed',dismissedQuantity:1}});
    expect(db.get('SELECT COUNT(*) AS count FROM tracked_decks').count).toBe(0);
    expect(db.get('SELECT COUNT(*) AS count FROM deck_snapshots').count).toBe(0);
    expect(requests.filter(request => request.url.endsWith('/pending-proxies/'+staged.id) && request.method === 'PUT')).toHaveLength(1);
  });

  it('stages only final edited quantities and added cards, excluding removed rows and basic lands',async () => {
    const text = '2 Sol Ring (C21) 263\n4 Swamp\n1 Lightning Bolt';
    const manifest = JSON.parse(db.get('SELECT manifest_json FROM print_jobs WHERE id=?',[jobId]).manifest_json);
    manifest.copies[2] = {...manifest.copies[2],displayName:'Skullclamp',setCode:'cmm',collectorNumber:'396'};
    manifest.plan = {...manifest.plan,mode:'adhoc',deckId:null,deckName:'Edited standalone list',source:null,target:null,
      list:{name:'Edited standalone list',text,textHash:hash(text)},excludeBasicLands:true,
      additionalCardText:'1 Skullclamp (CMM) 396',
      cards:[{displayName:'Sol Ring',quantity:2},{displayName:'Skullclamp',quantity:1}],
      removedCards:[{displayName:'Lightning Bolt',quantity:1}],excludedBasicLands:[{displayName:'Swamp',quantity:4}]};
    const frozen = JSON.stringify(manifest);
    db.run('UPDATE print_jobs SET tracked_deck_id=NULL,plan_json=?,manifest_json=?,manifest_sha256=? WHERE id=?',
      [JSON.stringify(manifest.plan),frozen,hash(frozen),jobId]);
    await connect(); await plans.processPendingProxyPlans();
    const items = bridge.listQueue(1);
    expect(items.map(item => [item.card.name,item.quantity]).sort()).toEqual([['Skullclamp',1],['Sol Ring',2]]);
    expect(items.every(item => item.deckId === null && item.confirmed === 0 && item.printJobId === jobId)).toBe(true);
    expect([...pending.values()].map(item => [item.card.name,item.quantity]).sort()).toEqual([['Skullclamp',1],['Sol Ring',2]]);
    expect([...pending.values()].every(item => item.label === 'Edited standalone list')).toBe(true);
    expect(receipts.size).toBe(0);
    const deliveries = requests.filter(request => request.url.includes('/pending-proxies/') && request.method === 'PUT');
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every(request => !request.body.includes('Swamp') && !request.body.includes('Lightning Bolt') && !request.body.includes('additionalCardText'))).toBe(true);
  });

  it('uses the print-time label instead of a renamed deck and leaves old frozen payloads unchanged',async () => {
    db.run('UPDATE print_jobs SET plan_json=? WHERE id=?',[JSON.stringify({totalCopies:3,deckName:'Original print label'}),jobId]);
    await publish();
    expect(pending.get(first().id).label).toBe('Original print label');
    const original = db.get('SELECT create_payload FROM manasync_pending_proxy_plans').create_payload;
    db.run("UPDATE tracked_decks SET deck_name='Renamed later'");
    db.run('UPDATE print_jobs SET plan_json=? WHERE id=?',[JSON.stringify({totalCopies:3,deckName:'Changed label'}),jobId]);
    await plans.refreshPendingProxyPlans(1);
    expect(db.get('SELECT create_payload FROM manasync_pending_proxy_plans').create_payload).toBe(original);
  });

  it('automatically stages ready PDFs disconnected, then publishes actual art without acquiring stock',async () => {
    await plans.processPendingProxyPlans();
    const item = first();
    expect(item.pendingProxy).toMatchObject({status:'disconnected',confirmedQuantity:0,remainingQuantity:3});
    expect(requests).toHaveLength(0);
    await expect(confirm(1,randomUUID(),1)).rejects.toThrow('Wait for this print plan');
    await connect(); await plans.processPendingProxyPlans();
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
    await connect(); await plans.refreshPendingProxyPlans(1); await plans.processPendingProxyPlans();
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
    artwork.stagePrintJob(1,jobId); await connect(); await plans.refreshPendingProxyPlans(1); await plans.processPendingProxyPlans();
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
    await connect(); await plans.processPendingProxyPlans();
    expect(first().id).toBe(original.id); expect(pending.get(original.id).card.proxyArtwork.front).toContain(hash(PNG));
    expect((await confirm()).status).toBe('reported');
  });

  it('shows unsupported pending APIs without silently acquiring or discarding artwork',async () => {
    await connect(); failure = 'unsupported'; await plans.processPendingProxyPlans();
    expect(first().pendingProxy).toMatchObject({status:'error',error:expect.stringContaining('Update ManaSync')});
    await expect(confirm(1,randomUUID(),1)).rejects.toThrow('Wait for this print plan');
    expect(first().operations).toEqual([]); expect(pending.size).toBe(0);
    failure = null; await plans.refreshPendingProxyPlans(1);
    expect(first().pendingProxy.retryState).toBe('held');
    await plans.retryPendingProxyPublication(1,first().id,{expectedConnection:expected()});
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

function duplicatePublished({printJobId = randomUUID(),deckId = 1,userId = 1} = {}) {
  const original = db.get('SELECT * FROM manasync_print_items WHERE id=?',[first().id]);
  const plan = db.get('SELECT * FROM manasync_pending_proxy_plans WHERE item_id=?',[original.id]);
  const id = randomUUID(), create = {...JSON.parse(plan.create_payload),sourceRef:printJobId};
  const value = {...structuredClone(pending.get(original.id)),id,sourceRef:printJobId};
  db.run(`INSERT INTO manasync_print_items(id,user_id,deck_id,card_json,quantity,created_at,print_job_id,artwork_json)
    VALUES(?,?,?,?,?,?,?,?)`,[id,userId,deckId,original.card_json,original.quantity,original.created_at,printJobId,original.artwork_json]);
  db.run(`INSERT INTO manasync_pending_proxy_plans(item_id,user_id,status,create_payload,base_url,account_id,remote_json,created_at)
    VALUES(?,?,'published',?,?,?,?,?)`,[id,userId,JSON.stringify(create),plan.base_url,plan.account_id,JSON.stringify(value),plan.created_at]);
  pending.set(id,value);
  return id;
}
const publication = () => db.get('SELECT * FROM manasync_pending_proxy_plans WHERE item_id=?',[first().id]);
const bulkCalls = () => requests.filter(request => request.url.endsWith('/pending-proxies'));

describe('bounded ManaSync synchronization',() => {
  it.each(['pending','partial','confirmed','dismissed'])('makes zero automatic requests over an idle day for published %s history',async status => {
    await publish();
    if (status === 'partial') await confirm(1);
    if (status === 'confirmed') await confirm(3);
    if (status === 'dismissed') await bridge.cancelItem(1,first().id);
    // Old successful rows with a high historical attempt count are idle, not held.
    db.run('UPDATE manasync_pending_proxy_plans SET next_attempt=0,attempts=100');
    expect(first().pendingProxy).toMatchObject({retryState:'idle',canRetryPublication:false});
    vi.useFakeTimers({toFake:['Date']});
    const start = Date.now(); requests.length=0; fetch.mockClear();
    for (let tick=1;tick<=5760;tick+=1) {
      vi.setSystemTime(start+tick*15000);
      await bridge.processPending();
    }
    expect(requests).toEqual([]); expect(fetch).not.toHaveBeenCalled();
    expect(first().pendingProxy.status).toBe(status);
  });

  it('caps transient publication attempts at six and does not let refresh restart uploads',async () => {
    await connect();
    fetch.mockImplementation((url,options) => {
      if (url.includes('/proxy-art/')) {requests.push({url,...options});return response({error:'Temporary failure'},503);}
      return fakeManaSync(url,options);
    });
    vi.useFakeTimers({toFake:['Date']}); const start=Date.now();
    for(let attempt=0;attempt<20;attempt+=1) {
      vi.setSystemTime(start+attempt*3600000);await plans.processPendingProxyPlans();
    }
    expect(first().pendingProxy).toMatchObject({retryState:'held',attempts:6,canRetryPublication:true});
    expect(requests.filter(request=>request.url.includes('/proxy-art/'))).toHaveLength(6);
    const frozen=publication().create_payload;
    await plans.refreshPendingProxyPlans(1);
    expect(bulkCalls()).toHaveLength(1);
    expect(requests.filter(request=>request.url.includes('/proxy-art/'))).toHaveLength(6);
    expect(publication()).toMatchObject({attempts:6,status:'held',create_payload:frozen});
    expect(first().operations).toEqual([]);expect(receipts.size).toBe(0);
  });

  it.each([[403,'proxy_storage_quota'],[507,'Storage full'],[429,'Daily quota exceeded']])('immediately holds definitive publication failure %s without discarding the frozen intent',async (status,message) => {
    await connect();
    fetch.mockImplementation((url,options) => {
      if (url.includes('/proxy-art/')) {requests.push({url,...options});return response({error:message},status);}
      return fakeManaSync(url,options);
    });
    await plans.processPendingProxyPlans();const frozen=publication();
    expect(first().pendingProxy).toMatchObject({retryState:'held',attempts:1,error:expect.stringContaining(message)});
    db.run('UPDATE manasync_pending_proxy_plans SET next_attempt=0');
    await plans.processPendingProxyPlans();await plans.refreshPendingProxyPlans(1);
    expect(requests.filter(request=>request.url.includes('/proxy-art/'))).toHaveLength(1);
    expect(publication()).toMatchObject({create_payload:frozen.create_payload,account_id:frozen.account_id,base_url:frozen.base_url});
    expect(receipts.size).toBe(0);
  });

  it('holds legacy exhausted rows and only an explicit guarded retry spends a fresh publication budget',async () => {
    await connect();failure='unsupported';await plans.processPendingProxyPlans();
    db.run("UPDATE manasync_pending_proxy_plans SET status='publishing',attempts=60,next_attempt=0");
    const frozen=publication().create_payload;failure=null;requests.length=0;
    await plans.processPendingProxyPlans();
    expect(requests).toEqual([]);expect(first().pendingProxy.retryState).toBe('held');
    await plans.refreshPendingProxyPlans(1);
    expect(requests.map(request=>request.method)).toEqual([undefined]);
    await expect(plans.retryPendingProxyPublication(1,first().id,{})).rejects.toThrow('Refresh the connection');
    await expect(plans.retryPendingProxyPublication(2,first().id,{expectedConnection:expected()})).rejects.toMatchObject({status:404});
    await expect(plans.retryPendingProxyPublication(1,first().id,{expectedConnection:{...expected(),actorId:'another actor'}})).rejects.toThrow('Connection changed');
    const result=await plans.retryPendingProxyPublication(1,first().id,{expectedConnection:expected()});
    expect(result.pendingProxy).toMatchObject({retryState:'idle',status:'pending',attempts:0});
    expect(publication().create_payload).toBe(frozen);
    expect(requests.filter(request=>request.method==='PUT'&&request.url.includes('/pending-proxies/')).map(request=>request.body)).toEqual([frozen]);
    expect(receipts.size).toBe(0);
  });

  it('recovers an exhausted lost PUT by the original ID before any new artwork upload',async () => {
    await connect();failure='create-lost';await plans.processPendingProxyPlans();
    db.run("UPDATE manasync_pending_proxy_plans SET status='held',attempts=6");
    const frozen=publication().create_payload, id=first().id;requests.length=0;
    const result=await plans.retryPendingProxyPublication(1,id,{expectedConnection:expected()});
    expect(result.pendingProxy.status).toBe('pending');expect(publication().create_payload).toBe(frozen);
    expect(requests).toHaveLength(1);expect(requests[0].method).toBeUndefined();expect(requests[0].url).toMatch(new RegExp('/pending-proxies/'+id+'$'));
    expect(pending.size).toBe(1);expect(receipts.size).toBe(0);
  });

  it('uses one coalesced owner bulk read across scopes and observes every matching item beyond the old 100-row limit',async () => {
    await publish();const originalId=first().id,targetJob=randomUUID();
    const later=[];
    for(let index=0;index<105;index+=1) later.push(duplicatePublished({printJobId:targetJob}));
    remoteDecision(pending.get(originalId),{operationId:'external-original',quantity:1,expectedRevision:1},'session-owner');
    for(const id of later) remoteDecision(pending.get(id),{operationId:'external-'+id,quantity:3,expectedRevision:1},'session-owner');
    requests.length=0;
    await Promise.all([plans.refreshPendingProxyPlans(1,{printJobId:jobId}),plans.refreshPendingProxyPlans(1,{printJobId:targetJob})]);
    expect(bulkCalls()).toHaveLength(1);
    expect(db.get('SELECT remote_json FROM manasync_pending_proxy_plans WHERE item_id=?',[originalId]).remote_json).toContain('external-original');
    expect(later.every(id=>JSON.parse(db.get('SELECT remote_json FROM manasync_pending_proxy_plans WHERE item_id=?',[id]).remote_json).remainingQuantity===0)).toBe(true);
    expect(requests.some(request=>request.method==='PUT'||request.method==='POST')).toBe(false);
  });

  it('scopes updates to the reviewed batch and never interprets unknown or missing IDs as confirmed',async () => {
    await publish();const original=first(),otherJob=randomUUID(),otherId=duplicatePublished({printJobId:otherJob});
    const unrelated=duplicatePublished({userId:2,deckId:null});
    remoteDecision(pending.get(otherId),{operationId:'external',quantity:3,expectedRevision:1},'session-owner');
    remoteDecision(pending.get(unrelated),{operationId:'other-owner',quantity:3,expectedRevision:1},'other-session');
    pending.delete(original.id);pending.set('unknown-record',{id:'unknown-record'});
    await plans.refreshPendingProxyPlans(1,{printJobId:jobId});
    expect(bridge.listQueue(1).find(item=>item.id===original.id)).toMatchObject({confirmed:0,remaining:3,pendingProxy:{error:expect.stringContaining('last known record is retained')}});
    expect(JSON.parse(db.get('SELECT remote_json FROM manasync_pending_proxy_plans WHERE item_id=?',[otherId]).remote_json).remainingQuantity).toBe(3);
    expect(JSON.parse(db.get('SELECT remote_json FROM manasync_pending_proxy_plans WHERE item_id=?',[unrelated]).remote_json).remainingQuantity).toBe(3);
    expect(db.get('SELECT item_id FROM manasync_pending_proxy_plans WHERE item_id=?',['unknown-record'])).toBeNull();
  });

  it.each(['quantity','artwork','revision','duplicate-id','confirmation'])('rejects malformed bulk %s before committing recognized plans',async kind => {
    await publish();const original=first(),second=duplicatePublished();
    remoteDecision(pending.get(original.id),{operationId:'external',quantity:1,expectedRevision:1},'session-owner');
    const bad=pending.get(second);
    if(kind==='quantity')bad.quantity+=1;
    if(kind==='artwork')bad.card.proxyArtwork.front='/different-art';
    if(kind==='revision')bad.revision=0;
    if(kind==='confirmation')bad.confirmations=[null];
    if(kind==='duplicate-id')fetch.mockImplementation((url,options)=>url.endsWith('/pending-proxies')?response({items:[...pending.values(),bad]}):fakeManaSync(url,options));
    const before=db.all('SELECT * FROM manasync_pending_proxy_plans ORDER BY item_id');
    await expect(plans.refreshPendingProxyPlans(1)).rejects.toMatchObject({status:502});
    expect(db.all('SELECT * FROM manasync_pending_proxy_plans ORDER BY item_id')).toEqual(before);
  });

  it('does not let an equal revision contradict saved history or a stale bulk response undo confirmation',async () => {
    await publish();const id=first().id,old=structuredClone(pending.get(id));
    remoteDecision(pending.get(id),{operationId:'conflict',quantity:1,expectedRevision:1},'session-owner');pending.get(id).revision=1;
    await expect(plans.refreshPendingProxyPlans(1)).rejects.toThrow('inconsistent pending print history');
    expect(first().confirmed).toBe(0);
    pending.set(id,old);await confirm(1);
    const current=publication();
    fetch.mockImplementation((url,options)=>url.endsWith('/pending-proxies')?response({items:[old]}):fakeManaSync(url,options));
    await plans.refreshPendingProxyPlans(1);
    expect(publication()).toEqual(current);expect(first().confirmed).toBe(1);
  });

  it.each(['disconnect','rotate','suspend','delete'])('rejects an in-flight bulk result after %s without committing owner data',async change => {
    await publish();const before=publication();let finish;
    fetch.mockImplementation((url,options)=>url.endsWith('/pending-proxies')?new Promise(resolve=>{finish=resolve;}):fakeManaSync(url,options));
    const refresh=plans.refreshPendingProxyPlans(1);
    await Promise.resolve();expect(finish).toBeTypeOf('function');
    if(change==='disconnect')bridge.disconnect(1);
    if(change==='rotate')await connect('actor-two');
    if(change==='suspend')db.run('UPDATE users SET suspended=1 WHERE id=1');
    if(change==='delete')db.run('DELETE FROM users WHERE id=1');
    finish(response({items:[...pending.values()]}));
    await expect(refresh).rejects.toMatchObject({status:['suspend','delete'].includes(change)?503:409});
    if(change==='delete')expect(db.all('SELECT * FROM manasync_pending_proxy_plans')).toEqual([]);
    else expect(publication()).toEqual(before);
  });

  it('throttles successful and failed owner bulk reads for sixty seconds without using a previous actor cache',async () => {
    await publish();vi.useFakeTimers({toFake:['Date']});const start=Date.now();
    await plans.refreshPendingProxyPlans(1);await plans.refreshPendingProxyPlans(1);expect(bulkCalls()).toHaveLength(1);
    await connect('actor-two');await plans.refreshPendingProxyPlans(1);expect(bulkCalls()).toHaveLength(2);
    vi.setSystemTime(start+60001);
    fetch.mockImplementation((url,options)=>url.endsWith('/pending-proxies')?(requests.push({url,...options}),response({error:'Offline'},503)):fakeManaSync(url,options));
    await expect(plans.refreshPendingProxyPlans(1)).rejects.toMatchObject({status:503});
    await expect(plans.refreshPendingProxyPlans(1)).rejects.toMatchObject({status:503});expect(bulkCalls()).toHaveLength(3);
  });

  it('does not bypass an exhausted cancellation outbox through background plan synchronization',async () => {
    await publish();failure='dismiss-lost';await bridge.cancelItem(1,first().id);
    db.run('UPDATE manasync_print_operations SET attempts=6,next_attempt=0');
    db.run('UPDATE manasync_pending_proxy_plans SET next_attempt=0');requests.length=0;
    for(let tick=0;tick<10;tick+=1)await bridge.processPending();
    expect(requests).toEqual([]);expect(first().pendingProxy.actionPending).toBe(true);
    await plans.refreshPendingProxyPlans(1);
    expect(first().pendingProxy).toMatchObject({status:'dismissed',actionPending:false});
  });

  it.each([403,503])('bounds a new cancellation when ManaSync reads/dismissal return %s before any outbox exists',async status => {
    await publish();const id=first().id;
    fetch.mockImplementation((url,options)=>{
      if(url.includes('/pending-proxies/')) {requests.push({url,...options});return response({error:'Unavailable'},status);}
      return fakeManaSync(url,options);
    });
    requests.length=0;await bridge.cancelItem(1,id);
    const outbox=db.get("SELECT * FROM manasync_print_operations WHERE kind='dismiss'");
    expect(outbox).toMatchObject({pending_id:id,attempts:1});
    expect(JSON.parse(outbox.payload_json)).toEqual({operationId:outbox.id,expectedRevision:1});
    vi.useFakeTimers({toFake:['Date']});const start=Date.now();
    for(let tick=1;tick<=30;tick+=1) {vi.setSystemTime(start+tick*3600000);await bridge.processPending();}
    const attempts=requests.filter(request=>request.url.endsWith('/dismiss'));
    expect(attempts).toHaveLength(status===403?1:6);
    expect(attempts.every(request=>request.body===outbox.payload_json)).toBe(true);
    // Only the one definitive-rejection reconciliation read is allowed; no
    // pre-outbox GET repeats on every worker tick.
    expect(requests.filter(request=>!request.method)).toHaveLength(status===403?1:0);
    expect(receipts.size).toBe(0);
  });

  it('does not recreate a deleted account’s plan when publication finishes in flight',async () => {
    await connect();let finish;
    fetch.mockImplementation((url,options)=>url.includes('/pending-proxies/')&&options.method==='PUT'
      ?new Promise(resolve=>{finish=resolve;}):fakeManaSync(url,options));
    const work=plans.processPendingProxyPlans();
    for(let turn=0;turn<20&&!finish;turn+=1)await Promise.resolve();
    expect(finish).toBeTypeOf('function');
    const id=first().id, create=JSON.parse(publication().create_payload);
    db.run('DELETE FROM users WHERE id=1');
    finish(response({pending:{id,...create,confirmedQuantity:0,dismissedQuantity:0,remainingQuantity:3,status:'pending',revision:1,confirmations:[]}}));
    await expect(work).resolves.toBeUndefined();
    expect(db.all('SELECT * FROM manasync_pending_proxy_plans')).toEqual([]);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('exposes owner-authenticated scoped refresh and explicit publication retry over HTTP',async () => {
    vi.stubEnv('JWT_SECRET','manasync-route-test-secret-012345678901234567890123456789');
    await connect();failure='unsupported';await plans.processPendingProxyPlans();failure=null;
    const id=first().id, frozen=publication().create_payload;
    const {default:express}=await import('express');
    const {default:router}=await import('../routes/manasync.js');
    const {createToken}=await import('../middleware/auth.js');
    const app=express();app.use(express.json());app.use('/api/manasync',router);
    const server=app.listen(0,'127.0.0.1');await once(server,'listening');
    const base=`http://127.0.0.1:${server.address().port}/api/manasync`;
    const post=(path,body,userId=1)=>localFetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',
      ...(userId?{Authorization:'Bearer '+createToken({id:userId,username:'fixture'})}:{})},body:JSON.stringify(body)});
    try {
      expect((await post('/print-queue/'+id+'/retry-publication',{},null)).status).toBe(401);
      expect((await post('/print-queue/'+id+'/retry-publication',{expectedConnection:expected()},2)).status).toBe(404);
      expect((await post('/print-queue/'+id+'/retry-publication',{})).status).toBe(400);
      expect((await post('/print-queue/refresh',{deckId:'all'})).status).toBe(400);
      const count=requests.length;
      const empty=await post('/print-queue/refresh',{printJobId:randomUUID()});expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({items:[]});expect(requests).toHaveLength(count);
      const retry=await post('/print-queue/'+id+'/retry-publication',{expectedConnection:expected()});
      expect(retry.status).toBe(200);expect(await retry.json()).toMatchObject({item:{id,pendingProxy:{retryState:'idle',status:'pending'}}});
      expect(publication().create_payload).toBe(frozen);expect(pending.size).toBe(1);expect(receipts.size).toBe(0);
    } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  });
});
