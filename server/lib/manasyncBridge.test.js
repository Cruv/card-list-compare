import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(),'clc-manasync-'));
let bridge,db;
let receipts,lots,writes,nextFailure;
const card = {name:'Sol Ring',oracleId:'00000000-0000-4000-8000-000000000001',scryfallId:'00000000-0000-4000-8000-000000000002',setCode:'c21',collectorNumber:'263',finish:'nonfoil',language:'en'};
const location = {id:'00000000-0000-4000-8000-000000000003',name:'Unassigned',kind:'unassigned'};
const physical = {id:'00000000-0000-4000-8000-000000000004',name:'Box',kind:'box'};
const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
async function fakeManaSync(url,options) {
  const token = options.headers.Authorization.slice(7);
  const actor = token;
  const userId = token.startsWith('user-b') ? 'account-b' : 'account-a';
  if (options.headers['X-ManaSync-User'] && options.headers['X-ManaSync-User'] !== userId) return json({error:'account_mismatch'},409);
  if (url.endsWith('/integration/context')) return json({user:{id:userId,username:userId},actorId:actor,scopes:token === 'broad' ? ['inventory:read','proxies:write','inventory:write'] : ['inventory:read','proxies:write']});
  if (url.endsWith('/containers')) return json({containers:[location,physical,{id:'virtual',kind:'list',name:'Proxy binder'}]});
  if (url.includes('/inventory/operations/')) {
    const parsed = new URL(url);
    const receipt = receipts.get(`${parsed.searchParams.get('actorId')}:${parsed.pathname.split('/').at(-1)}`);
    return receipt ? json(receipt) : json({error:'not_found'},404);
  }
  if (url.endsWith('/inventory/commands')) {
    writes.push({url,...options});
    const request = JSON.parse(options.body);
    if (nextFailure === 401 || nextFailure === 403 || nextFailure === 409) {const code=nextFailure;nextFailure=null;return json({error:'denied'},code);}
    const key = `${actor}:${request.operationId}`;
    if (receipts.has(key)) return json({...receipts.get(key),replayed:true});
    const input = request.command.input;
    const lot = input ? {id:randomUUID(),...input,revision:lots.length+1} : {...lots.find(v => v.id === request.command.lotId),quantity:request.command.quantity,revision:lots.length+1};
    if (input) lots.push(lot);
    const receipt = {operationId:request.operationId,revision:lots.length+1,changes:[{entity:'lots',id:lot.id,revision:lot.revision,value:lot}]};
    receipts.set(key,receipt);
    if (nextFailure === 'timeout') {nextFailure=null;throw new Error('Transport response lost');}
    return json(receipt);
  }
  if (url.endsWith('/inventory')) return json({lots});
  throw new Error(`Unexpected test request ${url}`);
}
beforeAll(async () => {
  vi.stubEnv('DB_PATH',join(dir,'clc.db'));
  vi.stubEnv('MANASYNC_BRIDGE_KEY',Buffer.alloc(32,7).toString('base64'));
  vi.stubEnv('JWT_SECRET','test-only-manasync-connect-session');
  db = await import('../db.js');await db.initDb();
  const {initIntegrationSchema} = await import('./integrationSchema.js');initIntegrationSchema();
  bridge = await import('./manasyncBridge.js');bridge.initBridgeSchema();
});
beforeEach(() => {
  db.run('DELETE FROM users');
  db.run("INSERT INTO users(id,username,password_hash) VALUES(1,'a','test'),(2,'b','test')");
  receipts=new Map();lots=[];writes=[];nextFailure=null;
  vi.stubGlobal('fetch',vi.fn(fakeManaSync));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
const connect = (userId=1,token='user-a-original') => bridge.connect(userId,{baseUrl:'http://localhost:8081',token});
const expected = (userId=1) => {const c=bridge.connectionStatus(userId);return c.connected ? {accountId:c.accountId,actorId:c.actorId,baseUrl:c.baseUrl} : null;};
const confirm = (userId,itemId,data) => bridge.confirmIncrement(userId,itemId,{expectedConnection:expected(userId),...data});
const queue = (quantity=5,userId=1) => bridge.queueItem(userId,{id:randomUUID(),card,quantity});

describe('ManaSync durable physical-print bridge',() => {
  it('encrypts independently per user and requires least privilege',async () => {
    await connect();await connect(2,'user-b-original');
    expect(bridge.connectionStatus(1).accountId).toBe('account-a');
    expect(bridge.connectionStatus(2).accountId).toBe('account-b');
    expect(bridge.connectionFor(1).token_cipher).not.toContain('user-a-original');
    expect(bridge.connectionStatus(1)).not.toHaveProperty('token_cipher');
    expect(bridge.connectionStatus(1)).not.toHaveProperty('allowedOrigins');
    await expect(connect(1,'broad')).rejects.toThrow('dedicated');
    expect((await bridge.containers(1)).map(v=>v.kind)).toEqual(['unassigned','box']);
  });
  it.each([
    ['https://mana.example', 'https://mana.example'],
    ['https://mana.example:4443/', 'https://mana.example:4443'],
    ['http://mana.example:28081/', 'http://mana.example:28081'],
    ['http://192.168.1.42:9001', 'http://192.168.1.42:9001'],
    ['http://manasync.local:8123', 'http://manasync.local:8123'],
    ['http://[fd00::1]:8089/', 'http://[fd00::1]:8089'],
    ['http://app:28081', 'http://app:28081'],
    ['mana.example', 'https://mana.example'],
    ['mana.example:8443', 'https://mana.example:8443'],
    ['localhost:28081', 'https://localhost:28081'],
    ['192.168.1.42:9443', 'https://192.168.1.42:9443'],
    ['  MANA.Example/  ', 'https://mana.example'],
    ['https://mana.example:443/', 'https://mana.example'],
    ['https://proxy.example/apps/manasync///', 'https://proxy.example/apps/manasync'],
    ['proxy.example/apps/manasync/', 'https://proxy.example/apps/manasync'],
    ['https://manasync.net/api/v1/', 'https://manasync.net'],
    ['https://proxy.example/apps/manasync/api/v1', 'https://proxy.example/apps/manasync'],
  ])('accepts and normalizes a server-reachable backend address: %s', (input, normalized) => {
    expect(bridge.validateBaseUrl(input)).toBe(normalized);
  });
  it.each([
    '', '  ', null, undefined, 8081, {},
    'https://', '/api/v1', '//mana.example', 'http://mana.example:65536',
    'ftp://mana.example', 'file:///etc/passwd', 'javascript:alert(1)', 'javascript:/alert', 'mailto:me@example.com',
    'http:/mana.example', 'https:mana.example',
    'http://user:secret@mana.example:8081', 'https://@mana.example',
    'https://mana.example?token=secret', 'https://mana.example?',
    'https://mana.example#settings', 'https://mana.example#',
    'https://mana.\nexample', 'https://mana.example\\',
    'https://manasync.net/api/v1/integration/context',
  ])('rejects an invalid or ambiguous backend address: %j', input => {
    expect(() => bridge.validateBaseUrl(input)).toThrow(bridge.BridgeError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('defaults to the deployed ManaSync app and accepts a copied bearer value without storing the prefix', async () => {
    const status = await bridge.connect(1, {token:'  Bearer user-a-original  '});
    expect(status).toMatchObject({connected:true,baseUrl:'https://manasync.net'});
    expect(fetch.mock.calls[0][0]).toBe('https://manasync.net/api/v1/integration/context');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer user-a-original');
    expect(bridge.connectionFor(1).token_cipher).not.toContain('user-a-original');
    expect(writes).toEqual([]);
  });
  it('explains tokens copied from the wrong app and rejects malformed values before network access', async () => {
    await expect(bridge.connect(1,{token:'clc_test_only'})).rejects.toThrow('CLC deck-access token');
    for (const token of ['"ms_example"','ms_example extra','Bearer ','ms_example\nsecret']) {
      await expect(bridge.connect(1,{token})).rejects.toMatchObject({status:400});
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(bridge.connectionStatus(1).configured).toBe(false);
  });
  it.each([
    [{cause:{code:'ENOTFOUND'}},'hostname',502],
    [{cause:{code:'ECONNREFUSED'}},'address, port',502],
    [{cause:{code:'CERT_HAS_EXPIRED'}},'HTTPS certificate',502],
    [{cause:{message:'unexpected redirect'}},'redirects',502],
    [{name:'TimeoutError'},'respond in time',504],
    [{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}},'respond in time',504],
    [{},'CLC server could not reach',502],
  ])('gives actionable server diagnostics without echoing credentials: %j', async (details,message,status) => {
    const failure = Object.assign(new Error('private-upstream-test-value'),details);
    fetch.mockRejectedValueOnce(failure);
    const error = await bridge.connect(1,{token:'user-a-original'}).catch(value => value);
    expect(error).toMatchObject({status});
    expect(error.message).toContain(message);
    expect(error.message).not.toMatch(/private-upstream-test-value|user-a-original/);
    expect(bridge.connectionStatus(1).configured).toBe(false);
  });
  it.each([
    [() => json({error:'unauthorized'},401),'rejected this token',401],
    [() => json({error:'not_found'},404),'integration API was not found',404],
    [() => new Response('<html>Sign in</html>',{headers:{'content-type':'text/html'}}),'did not return the ManaSync API',502],
  ])('keeps the previous grant intact when replacement setup fails', async (response,message,status) => {
    await connect();
    const before = bridge.connectionFor(1);
    fetch.mockResolvedValueOnce(response());
    const failure = await connect(1,'user-a-replacement').catch(error => error);
    expect(failure).toMatchObject({status});
    expect(failure.message).toContain(message);
    expect(bridge.connectionFor(1)).toEqual(before);
    expect(writes).toEqual([]);
  });
  it('checks the saved account without changing its token, ownership timestamp or historical confirmations', async () => {
    await connect();
    const item = queue();
    const result = await confirm(1,item.id,{operationId:randomUUID(),quantity:1});
    const operation = db.get('SELECT * FROM manasync_print_operations WHERE id=?',[result.id]);
    const before = bridge.connectionFor(1);
    const originalWriteCount = writes.length;
    fetch.mockClear();
    const status = await bridge.checkConnection(1);
    expect(status).toMatchObject({connected:true,accountId:'account-a',lastOwnership:before.last_ownership});
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/api/v1/integration/context','/api/v1/containers']);
    expect(bridge.connectionFor(1).token_cipher).toBe(before.token_cipher);
    expect(db.get('SELECT * FROM manasync_print_operations WHERE id=?',[result.id])).toEqual(operation);
    expect(writes).toHaveLength(originalWriteCount);
  });
  it('refuses changed context and clears a saved diagnostic after a successful check', async () => {
    await connect();
    fetch.mockResolvedValueOnce(json({user:{id:'account-b'},actorId:'user-a-original',scopes:['inventory:read','proxies:write']}));
    await expect(bridge.checkConnection(1)).rejects.toMatchObject({status:409});
    expect(bridge.connectionStatus(1).error).toContain('different account');
    expect((await bridge.checkConnection(1)).error).toBeNull();
    expect(writes).toEqual([]);
  });
  it('does not restore a disconnected grant or overwrite a new account while a check is in flight', async () => {
    await connect();
    fetch.mockImplementationOnce(async (url,options) => { bridge.disconnect(1); return fakeManaSync(url,options); });
    await expect(bridge.checkConnection(1)).rejects.toThrow('connection changed');
    expect(bridge.connectionStatus(1).connected).toBe(false);
    await connect();
    fetch.mockImplementationOnce(async (url,options) => { await connect(1,'user-b-new'); return fakeManaSync(url,options); });
    await expect(bridge.checkConnection(1)).rejects.toThrow('connection changed');
    expect(bridge.connectionStatus(1)).toMatchObject({connected:true,accountId:'account-b',error:null});
  });
  it('keeps connection checks owner scoped and maps upstream rejection without expiring the CLC session', async () => {
    const router = (await import('../routes/manasync.js')).default;
    const {createToken} = await import('../middleware/auth.js');
    const request = (method,url,userId) => new Promise((resolve,reject) => {
      const req = {method,url,headers:userId ? {authorization:`Bearer ${createToken({id:userId,username:'test'})}`} : {}};
      const res = {statusCode:200,status(code) {this.statusCode=code;return this;},json(body) {resolve({status:this.statusCode,body});return this;}};
      router.handle(req,res,error => error ? reject(error) : resolve({status:404}));
    });
    await connect();
    expect((await request('POST','/connection/check')).status).toBe(401);
    expect((await request('POST','/connection/check',2)).status).toBe(409);
    expect((await request('POST','/connection/check',1)).status).toBe(200);
    fetch.mockResolvedValueOnce(json({message:'This token was revoked.'},401));
    const rejected = await request('POST','/connection/check',1);
    expect(rejected.status).toBe(424);
    expect(rejected.body.error).toContain('revoked');
    expect(bridge.connectionStatus(2).configured).toBe(false);
    expect(writes).toEqual([]);
  });
  it.each([
    ['mana.example:8443', 'https://mana.example:8443'],
    ['https://proxy.example/', 'https://proxy.example'],
    ['http://192.168.1.42:28081/', 'http://192.168.1.42:28081'],
    ['proxy.example/apps/manasync/', 'https://proxy.example/apps/manasync'],
  ])('connects to %s without a per-host or per-port setting and refuses credential redirects', async (baseUrl, normalized) => {
    const status = await bridge.connect(1, { baseUrl, token: 'user-a-original' });
    expect(status).toMatchObject({ connected: true, baseUrl: normalized, accountId: 'account-a' });
    expect(bridge.connectionFor(1).base_url).toBe(normalized);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${normalized}/api/v1/integration/context`, `${normalized}/api/v1/containers`,
    ]);
    for (const [, options] of fetch.mock.calls) {
      expect(options.redirect).toBe('error');
      expect(options.headers.Authorization).toBe('Bearer user-a-original');
    }
  });
  it('queueing and cancellation do not acquire stock, while offline confirmation remains durable',async () => {
    const item=queue();
    const result=await confirm(1,item.id,{operationId:randomUUID(),quantity:2});
    expect(result.status).toBe('local');expect(writes).toHaveLength(0);
    bridge.cancelItem(1,item.id);
    expect(bridge.listQueue(1)[0]).toMatchObject({confirmed:2,remaining:0,cancelled:true});
    await connect();await bridge.bindLocalIncrement(1,result.id,location.id,expected());
    expect(lots[0].quantity).toBe(2);
    expect(bridge.listQueue(1)[0].operations[0].status).toBe('reported');
  });
  it('records partial confirmations once, preserves known identity and gives intentional increments new IDs',async () => {
    await connect();const item=queue();const request={operationId:randomUUID(),quantity:2,containerId:physical.id};
    const result=await confirm(1,item.id,request);
    await confirm(1,item.id,request);
    expect(writes).toHaveLength(1);expect(result.status).toBe('reported');
    expect(JSON.parse(writes[0].body).command.input).toMatchObject({card,quantity:2,isProxy:true,containerId:physical.id});
    expect(writes[0].headers['X-ManaSync-User']).toBe('account-a');
    await expect(confirm(1,item.id,{...request,quantity:3})).rejects.toMatchObject({status:409});
    await confirm(1,item.id,{operationId:randomUUID(),quantity:3});
    expect(lots.map(v=>v.quantity)).toEqual([2,3]);expect(bridge.listQueue(1)[0].remaining).toBe(0);
    await expect(confirm(1,item.id,{operationId:randomUUID(),quantity:1})).rejects.toMatchObject({status:409});
    expect(bridge.listQueue(1)[0].operations.every(o=>o.receipt && o.lotId)).toBe(true);
  });
  it('deduplicates simultaneous submissions and rejects access by another CLC user',async () => {
    await connect();const item=queue();const request={operationId:randomUUID(),quantity:2};
    await Promise.all([confirm(1,item.id,request),confirm(1,item.id,request)]);
    expect(writes).toHaveLength(1);expect(bridge.listQueue(2)).toEqual([]);
    await expect(confirm(2,item.id,request)).rejects.toMatchObject({status:409});
    await expect(confirm(2,item.id,{operationId:randomUUID(),quantity:1})).rejects.toMatchObject({status:404});
    await bridge.reportOperation(2,request.operationId,true);expect(writes).toHaveLength(1);
  });
  it('replays identical bytes and the same actor after a lost response',async () => {
    await connect();const item=queue();const operationId=randomUUID();nextFailure='timeout';
    const result=await confirm(1,item.id,{operationId,quantity:2});
    expect(result.status).toBe('pending');expect(lots).toHaveLength(1);
    const saved=db.get('SELECT * FROM manasync_print_operations WHERE id=?',[operationId]);
    expect(saved.payload_json).toBe(writes[0].body);
    await bridge.reportOperation(1,operationId,true);
    expect(writes).toHaveLength(2);expect(writes[1].body).toBe(writes[0].body);
    expect(writes[1].headers.Authorization).toBe(writes[0].headers.Authorization);
    expect(lots).toHaveLength(1);expect(bridge.listQueue(1)[0].operations[0].receipt.replayed).toBe(true);
  });
  it('pauses suspended users without consuming retries and resumes the same uncertain acquisition',async () => {
    await connect(); const item = queue(), operationId = randomUUID(); nextFailure = 'timeout';
    expect((await confirm(1,item.id,{operationId,quantity:2})).status).toBe('pending');
    db.run('UPDATE manasync_print_operations SET next_attempt=0 WHERE id=?',[operationId]);
    const original = db.get('SELECT * FROM manasync_print_operations WHERE id=?',[operationId]);
    db.run('UPDATE users SET suspended=1 WHERE id=1');
    fetch.mockClear();
    await bridge.processPending(); await bridge.reportOperation(1,operationId,true);
    expect(fetch).not.toHaveBeenCalled();
    expect(db.get('SELECT * FROM manasync_print_operations WHERE id=?',[operationId])).toEqual(original);
    db.run('UPDATE users SET suspended=0 WHERE id=1');
    await bridge.processPending();
    expect(writes).toHaveLength(2); expect(lots).toHaveLength(1);
    expect(writes[1].body).toBe(original.payload_json);
    expect(writes[1].headers.Authorization).toBe(writes[0].headers.Authorization);
    expect(db.get('SELECT status FROM manasync_print_operations WHERE id=?',[operationId]).status).toBe('reported');
  });
  it('pauses on replacement credentials and reconciles the old actor receipt without repeating acquisition',async () => {
    await connect();const item=queue();const operationId=randomUUID();nextFailure='timeout';
    await confirm(1,item.id,{operationId,quantity:2});
    await connect(1,'user-a-replacement');await bridge.reportOperation(1,operationId,true);
    expect(writes).toHaveLength(1);expect(bridge.listQueue(1)[0].operations[0].status).toBe('review');
    const inspection=await bridge.reconcile(1,operationId);
    expect(inspection.operation.status).toBe('reported');expect(inspection.lots).toHaveLength(1);
    expect(writes).toHaveLength(1);
    await connect(1,'user-b-replacement');
    await expect(bridge.reconcile(1,operationId)).rejects.toMatchObject({status:409});
  });
  it('keeps uncertain operations pinned to the original backend when the domain or port changes', async () => {
    await connect();
    const item = queue(), operationId = randomUUID(), shown = expected();
    nextFailure = 'timeout';
    await confirm(1, item.id, { operationId, quantity: 2 });
    const original = db.get('SELECT * FROM manasync_print_operations WHERE id=?', [operationId]);
    await bridge.connect(1, { baseUrl: 'mana.example:8443', token: 'user-a-original' });
    await bridge.reportOperation(1, operationId, true);
    expect(writes).toHaveLength(1);
    expect(db.get('SELECT * FROM manasync_print_operations WHERE id=?', [operationId])).toMatchObject({
      status: 'review', base_url: original.base_url, payload_json: original.payload_json,
      token_cipher: original.token_cipher, account_id: original.account_id, actor_id: original.actor_id,
    });
    await expect(confirm(1, item.id, { operationId: randomUUID(), quantity: 1, expectedConnection: shown })).rejects.toMatchObject({ status: 409 });
    await expect(bridge.reconcile(1, operationId)).rejects.toMatchObject({ status: 409 });
    await connect();
    await bridge.reportOperation(1, operationId, true);
    expect(writes).toHaveLength(2);
    expect(writes[1].url).toBe(writes[0].url);
    expect(writes[1].body).toBe(writes[0].body);
    expect(lots).toHaveLength(1);
  });
  it('distinguishes auth, scope, and conflict failures without acquiring extra prints',async () => {
    await connect();const item=queue();
    for (const [failure,status] of [[401,'reconnect'],[403,'failed'],[409,'review']]) {
      nextFailure=failure;
      const operation=await confirm(1,item.id,{operationId:randomUUID(),quantity:1});
      expect(operation.status).toBe(status);
    }
    expect(lots).toHaveLength(0);
    await bridge.processPending();expect(writes).toHaveLength(3);
  });
  it('confirms physical prints during transport outages and bounds automatic retries',async () => {
    await connect();const item=queue();const operationId=randomUUID();
    vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('offline');}));
    const result=await confirm(1,item.id,{operationId,quantity:2});
    expect(result.status).toBe('pending');expect(bridge.listQueue(1)[0].confirmed).toBe(2);
    db.run('UPDATE manasync_print_operations SET attempts=6,next_attempt=0 WHERE id=?',[operationId]);
    const attempts=fetch.mock.calls.length;await bridge.processPending();expect(fetch.mock.calls).toHaveLength(attempts);
  });
  it('rejects a new confirmation when another tab changed the displayed account',async () => {
    await connect();const item=queue();const shown=expected();await connect(1,'user-b-new');
    await expect(confirm(1,item.id,{operationId:randomUUID(),quantity:2,expectedConnection:shown})).rejects.toMatchObject({status:409});
    expect(writes).toHaveLength(0);expect(bridge.listQueue(1)[0].confirmed).toBe(0);
    await expect(confirm(1,item.id,{operationId:randomUUID(),quantity:2,expectedConnection:null})).rejects.toThrow('Refresh the connection');
  });
  it('queues a complete deck atomically and rolls back malformed batches',() => {
    const items=[{id:randomUUID(),card,quantity:2},{id:randomUUID(),card:{name:'Arcane Signet'},quantity:1}];
    bridge.queueItems(1,{items});bridge.queueItems(1,{items});expect(bridge.listQueue(1)).toHaveLength(2);expect(writes).toHaveLength(0);
    expect(()=>bridge.queueItems(1,{items:[{id:randomUUID(),card,quantity:1},{id:randomUUID(),card,quantity:0}]})).toThrow();
    expect(bridge.listQueue(1)).toHaveLength(2);
  });
  it('persists explicit version-checked corrections as new operations',async () => {
    await connect();const item=queue();const original=await confirm(1,item.id,{operationId:randomUUID(),quantity:2});
    const correction={operationId:randomUUID(),type:'adjust',quantity:1,expectedRevision:1,reason:'One print damaged'};
    const result=await bridge.correctLot(1,original.id,correction);
    expect(result.status).toBe('reported');
    expect(JSON.parse(writes.at(-1).body).command).toEqual({type:'adjust',lotId:original.lotId,quantity:1,expectedRevision:1,reason:'One print damaged'});
    await bridge.correctLot(1,original.id,correction);expect(writes).toHaveLength(2);
    expect(bridge.listQueue(1)[0].confirmed).toBe(2);
    await expect(bridge.correctLot(1,original.id,{...correction,quantity:0})).rejects.toMatchObject({status:409});
  });
});
