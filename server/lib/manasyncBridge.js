import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, run, transaction } from '../db.js';
import { getInstanceId } from './integrationSchema.js';

export class BridgeError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function initBridgeSchema() {
  run(`CREATE TABLE IF NOT EXISTS manasync_connections (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    base_url TEXT NOT NULL, token_cipher TEXT NOT NULL, account_id TEXT NOT NULL,
    actor_id TEXT NOT NULL, username TEXT NOT NULL, connected INTEGER NOT NULL DEFAULT 1,
    last_success TEXT, last_error TEXT, containers_json TEXT, last_ownership TEXT)`);
  for (const column of ['containers_json TEXT','last_ownership TEXT']) {
    try { run(`ALTER TABLE manasync_connections ADD COLUMN ${column}`); } catch { /* Existing schema. */ }
  }
  run(`CREATE TABLE IF NOT EXISTS manasync_print_items (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deck_id INTEGER REFERENCES tracked_decks(id) ON DELETE SET NULL,
    card_json TEXT NOT NULL, quantity INTEGER NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL)`);
  const itemColumns = all('PRAGMA table_info(manasync_print_items)');
  for (const column of ['print_job_id', 'artwork_json']) {
    if (!itemColumns.some(existing => existing.name === column)) run(`ALTER TABLE manasync_print_items ADD COLUMN ${column} TEXT`);
  }
  run('CREATE INDEX IF NOT EXISTS idx_manasync_print_job ON manasync_print_items(user_id, print_job_id)');
  run(`CREATE TABLE IF NOT EXISTS manasync_print_operations (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES manasync_print_items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'acquire', quantity INTEGER NOT NULL, intent_json TEXT NOT NULL,
    payload_json TEXT, base_url TEXT, token_cipher TEXT, account_id TEXT, actor_id TEXT,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, receipt_json TEXT, lot_id TEXT, created_at TEXT NOT NULL)`);
  if (!all('PRAGMA table_info(manasync_print_operations)').some(column => column.name === 'pending_id')) {
    run('ALTER TABLE manasync_print_operations ADD COLUMN pending_id TEXT');
  }
  run(`CREATE TABLE IF NOT EXISTS manasync_pending_proxy_plans (
    item_id TEXT PRIMARY KEY REFERENCES manasync_print_items(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'local', create_payload TEXT,
    base_url TEXT, account_id TEXT, remote_json TEXT, last_error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0, cancel_operation_id TEXT,
    created_at TEXT NOT NULL)`);
  if (!all('PRAGMA table_info(print_jobs)').some(column => column.name === 'proxy_staging_error')) {
    run('ALTER TABLE print_jobs ADD COLUMN proxy_staging_error TEXT');
  }
  if (!all('PRAGMA table_info(print_jobs)').some(column => column.name === 'proxy_staging_next_attempt')) {
    run('ALTER TABLE print_jobs ADD COLUMN proxy_staging_next_attempt INTEGER NOT NULL DEFAULT 0');
  }
}
let key;
function encryptionKey() {
  if (key) return key;
  if (process.env.MANASYNC_BRIDGE_KEY) {
    key = Buffer.from(process.env.MANASYNC_BRIDGE_KEY, 'base64');
    if (key.length !== 32) throw new BridgeError('MANASYNC_BRIDGE_KEY must be a base64 encoded 32 byte key.', 503);
    return key;
  }
  const dir = dirname(process.env.DB_PATH || fileURLToPath(new URL('../data/cardlistcompare.db', import.meta.url)));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, '.manasync-bridge-key');
  try { writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' }); }
  catch (err) { if (err.code !== 'EEXIST') throw err; }
  key = readFileSync(path);
  if (key.length !== 32) throw new BridgeError('The CLC ManaSync encryption key is invalid.', 503);
  return key;
}
export function encryptToken(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(v => v.toString('base64')).join('.');
}
function decryptToken(value) {
  const [iv, tag, ciphertext] = value.split('.').map(v => Buffer.from(v, 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString('utf8');
}
export function validateBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new BridgeError('Enter a valid ManaSync backend URL.');
  const input = value.trim();
  if (/^[/\\]/.test(input)) throw new BridgeError('Enter a ManaSync backend hostname, not a relative path.');
  // Bare domains and host:port addresses use HTTPS; an explicit http:// remains
  // available for a household LAN or a server-to-server Docker connection.
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(input);
  const bareHostPort = /^[^/:?#\s]+:\d+(?:[/?#]|$)/.test(input);
  if (hasScheme && !bareHostPort && !/^[a-z][a-z\d+.-]*:\/\//i.test(input)) {
    throw new BridgeError('Enter a valid HTTP or HTTPS ManaSync backend URL.');
  }
  const address = hasScheme && !bareHostPort ? input : `https://${input}`;
  let url;
  try { url = new URL(address); } catch { throw new BridgeError('Enter a valid HTTP or HTTPS ManaSync backend URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new BridgeError('Use an HTTP or HTTPS ManaSync backend URL.');
  const authority = address.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1];
  if (/\s|\\/.test(input) || authority?.includes('@') || url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
    throw new BridgeError('Use a backend URL without credentials, query parameters, or a fragment.');
  }
  // Keep a reverse-proxy prefix: remote() appends /api/v1/... to this base.
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
export function isBridgeUserActive(userId) {
  const user = get('SELECT suspended FROM users WHERE id = ?', [userId]);
  return !!user && !user.suspended;
}
export async function remote(connection, path, options = {}) {
  // Recheck after each awaited upload/read as well as at worker entry: suspension
  // may happen while a request is in flight. Keep the frozen outbox retryable.
  if (!isBridgeUserActive(connection.user_id)) throw new BridgeError('ManaSync delivery is paused because this CLC account is suspended or unavailable.', 503);
  const { contentType = 'application/json', ...requestOptions } = options;
  const response = await fetch(`${connection.base_url}${path}`, {
    ...requestOptions, redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: { 'Content-Type': contentType, Authorization: `Bearer ${decryptToken(connection.token_cipher)}`,
      ...(connection.account_id ? { 'X-ManaSync-User': connection.account_id } : {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new BridgeError(`ManaSync: ${detail}`, response.status);
  }
  if (!body || typeof body !== 'object') throw new BridgeError('ManaSync returned an invalid response.', 502);
  return body;
}
export function connectionFor(userId) { return get('SELECT * FROM manasync_connections WHERE user_id = ?', [userId]); }
export function connectionStatus(userId) {
  const c = connectionFor(userId);
  return { configured: !!c, connected: !!c?.connected, baseUrl: c?.base_url || '', accountId: c?.account_id || '',
    username: c?.username || '', actorId: c?.actor_id || '', lastSuccess: c?.last_success || null, lastOwnership: c?.last_ownership || null, error: c?.last_error || null };
}
export async function connect(userId, { baseUrl, token }) {
  if (typeof token !== 'string' || !token.trim() || token.length > 8192) throw new BridgeError('Enter a user-granted ManaSync token.');
  const c = { user_id: userId, base_url: validateBaseUrl(baseUrl), token_cipher: encryptToken(token.trim()) };
  const context = await remote(c, '/api/v1/integration/context');
  if (!context.user?.id || !context.actorId || !Array.isArray(context.scopes)) throw new BridgeError('Update ManaSync to a version supporting integration context.', 400);
  if (!['inventory:read', 'proxies:write'].every(scope => context.scopes.includes(scope))) throw new BridgeError('Grant inventory:read and proxies:write to this ManaSync token.');
  if (context.scopes.some(scope => !['inventory:read', 'proxies:write'].includes(scope))) throw new BridgeError('Use a dedicated ManaSync token with only inventory:read and proxies:write.');
  c.account_id = context.user.id;
  const locations = await remote(c, '/api/v1/containers');
  if (!Array.isArray(locations.containers)) throw new BridgeError('ManaSync returned invalid locations.', 502);
  run(`INSERT INTO manasync_connections (user_id,base_url,token_cipher,account_id,actor_id,username,connected,last_success,containers_json)
    VALUES (?,?,?,?,?,?,1,?,?) ON CONFLICT(user_id) DO UPDATE SET base_url=excluded.base_url,token_cipher=excluded.token_cipher,
    account_id=excluded.account_id,actor_id=excluded.actor_id,username=excluded.username,connected=1,last_error=NULL,last_success=excluded.last_success,containers_json=excluded.containers_json,
    last_ownership=CASE WHEN manasync_connections.account_id=excluded.account_id AND manasync_connections.base_url=excluded.base_url THEN manasync_connections.last_ownership ELSE NULL END`,
  [userId,c.base_url,c.token_cipher,context.user.id,context.actorId,context.user.username,new Date().toISOString(),JSON.stringify(locations.containers)]);
  return connectionStatus(userId);
}
export function disconnect(userId) {
  run('UPDATE manasync_connections SET connected=0 WHERE user_id=?', [userId]);
  return connectionStatus(userId);
}
function requireConnection(userId) {
  const c = connectionFor(userId);
  if (!c?.connected) throw new BridgeError('Connect ManaSync in Settings to read ownership or report printed cards.', 409);
  return c;
}
export async function readRemote(userId, path) {
  const c = requireConnection(userId);
  try {
    const result = await remote(c, path);
    run('UPDATE manasync_connections SET last_success=?,last_error=NULL WHERE user_id=? AND actor_id=?', [new Date().toISOString(), userId, c.actor_id]);
    return result;
  } catch (error) {
    run('UPDATE manasync_connections SET last_error=? WHERE user_id=? AND actor_id=?', [error.message,userId,c.actor_id]);
    throw error;
  }
}
export function markOwnershipRead(userId) {
  run('UPDATE manasync_connections SET last_ownership=? WHERE user_id=?',[new Date().toISOString(),userId]);
}
export async function containers(userId) {
  const c = requireConnection(userId);
  const result = await remote(c, '/api/v1/containers');
  if (!Array.isArray(result.containers)) throw new BridgeError('ManaSync returned invalid locations.',502);
  run('UPDATE manasync_connections SET containers_json=? WHERE user_id=? AND actor_id=?',[JSON.stringify(result.containers),userId,c.actor_id]);
  return result.containers.filter(c => !['list','incoming'].includes(c.kind));
}
function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function positive(value) { return Number.isInteger(value) && value > 0 && value <= 10000; }
export function cardIdentity(value) {
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 300) throw new BridgeError('A card name is required.');
  for (const field of ['scryfallId','oracleId']) if (value[field] && !uuid(value[field])) throw new BridgeError(`Invalid ${field}.`);
  return { name: value.name.trim(), scryfallId: value.scryfallId || null, oracleId: value.oracleId || null,
    setCode: String(value.setCode || '').slice(0,30), collectorNumber: String(value.collectorNumber || '').slice(0,30),
    finish: ['nonfoil','foil','etched'].includes(value.finish) ? value.finish : 'nonfoil', language: String(value.language || 'en').slice(0,10),
    condition: 'near_mint', altered: false, misprint: false };
}
export function queueItem(userId, data) {
  if (!uuid(data.id) || !positive(data.quantity)) throw new BridgeError('Provide a queue UUID and positive quantity.');
  const card = cardIdentity(data.card);
  if (data.deckId && !get('SELECT id FROM tracked_decks WHERE id=? AND user_id=?', [data.deckId,userId])) throw new BridgeError('Deck not found.',404);
  const previous = get('SELECT * FROM manasync_print_items WHERE id=?', [data.id]);
  if (previous) {
    if (previous.user_id !== userId || previous.card_json !== JSON.stringify(card) || previous.quantity !== data.quantity || previous.deck_id !== (data.deckId || null)) throw new BridgeError('Queue operation ID has already been used for different content.',409);
    return previous;
  }
  run('INSERT INTO manasync_print_items(id,user_id,deck_id,card_json,quantity,created_at) VALUES(?,?,?,?,?,?)',
    [data.id,userId,data.deckId || null,JSON.stringify(card),data.quantity,new Date().toISOString()]);
  return get('SELECT * FROM manasync_print_items WHERE id=?',[data.id]);
}
export function listQueue(userId, deckId) {
  return all('SELECT * FROM manasync_print_items WHERE user_id=? AND (deck_id=? OR ? IS NULL) ORDER BY created_at DESC',[userId,deckId || null,deckId || null]).map(item => {
    const operations = all('SELECT * FROM manasync_print_operations WHERE user_id=? AND item_id=? ORDER BY created_at',[userId,item.id]);
    let confirmed = operations.filter(o => o.kind === 'acquire').reduce((n,o) => n+o.quantity,0);
    const pendingPlan = get('SELECT * FROM manasync_pending_proxy_plans WHERE item_id = ?', [item.id]);
    const pendingProxy = pendingPlan ? publicPendingProxy(pendingPlan, item, operations) : item.print_job_id ? {
      status:'legacy', confirmedQuantity:confirmed, dismissedQuantity:item.cancelled ? item.quantity-confirmed : 0,
      remainingQuantity:item.cancelled ? 0 : item.quantity-confirmed, revision:null, actionPending:false,
      error:null, baseUrl:null, accountId:null, confirmations:[],
    } : null;
    if (pendingProxy && pendingProxy.status !== 'legacy') confirmed = pendingProxy.confirmedQuantity;
    const artwork = item.artwork_json ? JSON.parse(item.artwork_json) : null;
    if (artwork) for (const face of ['front','back']) if (artwork[face]) {
      artwork[face].imageUrl = `/api/manasync/print-queue/${encodeURIComponent(item.id)}/artwork/${face}`;
    }
    return { id:item.id, deckId:item.deck_id, card:JSON.parse(item.card_json), quantity:item.quantity, confirmed,
      printJobId:item.print_job_id || null, artwork, pendingProxy,
      remaining:pendingProxy && pendingProxy.status !== 'legacy' ? pendingProxy.remainingQuantity : item.cancelled ? 0 : item.quantity-confirmed,
      cancelled:!!item.cancelled || pendingProxy?.status === 'dismissed', operations:operations.map(publicOperation) };
  });
}
function publicPendingProxy(plan, item, operations) {
  const remote = plan.remote_json ? JSON.parse(plan.remote_json) : null;
  const connection = connectionFor(item.user_id);
  const connected = connection?.connected && (!plan.account_id || (connection.account_id === plan.account_id && connection.base_url === plan.base_url));
  const actionPending = remote?.remainingQuantity !== 0 && (!!plan.cancel_requested || operations.some(o => o.pending_id && ['pending','reconnect'].includes(o.status)));
  let status = remote?.status || 'publishing';
  if (plan.status === 'dismissed') status = 'dismissed';
  else if (!['confirmed','dismissed'].includes(status)) {
    if (!connected) status = 'disconnected';
    else if (plan.last_error) status = 'error';
  }
  return { status, confirmedQuantity:remote?.confirmedQuantity || 0,
    dismissedQuantity:remote?.dismissedQuantity || (plan.status === 'dismissed' ? item.quantity : 0),
    remainingQuantity:remote?.remainingQuantity ?? (plan.status === 'dismissed' ? 0 : item.quantity),
    revision:remote?.revision ?? null, actionPending, error:plan.last_error || null,
    baseUrl:plan.base_url || null, accountId:plan.account_id || null, confirmations:remote?.confirmations || [] };
}
function publicOperation(o) {
  return { id:o.id,itemId:o.item_id,kind:o.kind,quantity:o.quantity,status:o.status,attempts:o.attempts,error:o.last_error,
    lotId:o.lot_id,receipt:o.receipt_json ? JSON.parse(o.receipt_json) : null,accountId:o.account_id,
    createdAt:o.created_at };
}
export function cancelItem(userId, id) {
  if (get('SELECT item_id FROM manasync_pending_proxy_plans WHERE item_id = ? AND user_id = ?', [id,userId])) {
    return import('./pendingProxyPlans.js').then(module => module.cancelPendingProxy(userId,id));
  }
  run('UPDATE manasync_print_items SET cancelled=1 WHERE id=? AND user_id=?',[id,userId]);
}
const active = new Set();
export function assertExpectedConnection(userId,expected) {
  const c = connectionFor(userId);
  if (expected === null && !c?.connected) return c;
  if (!expected || typeof expected !== 'object') throw new BridgeError('Refresh the connection before confirming physical prints.');
  if (!c?.connected || c.account_id !== expected.accountId || c.actor_id !== expected.actorId || c.base_url !== expected.baseUrl) {
    throw new BridgeError('Connection changed since this screen was loaded. Refresh and review the destination account before confirming.',409);
  }
  return c;
}
export function queueItems(userId,data) {
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 500) throw new BridgeError('Queue between 1 and 500 card entries.');
  return transaction(() => data.items.map(item => queueItem(userId,item)));
}
// Freeze account-owned content addresses before delivery; uploaded art never
// changes an already-persisted acquisition's UUID or payload bytes.
export function artworkCard(item, accountId) {
  const card = JSON.parse(item.card_json);
  if (!item.artwork_json) return card;
  const artwork = JSON.parse(item.artwork_json);
  const reference = image => `/api/v1/proxy-art/${encodeURIComponent(accountId)}/${image.sha256}`;
  return { ...card, proxyArtwork: { front: reference(artwork.front), ...(artwork.back ? { back: reference(artwork.back) } : {}) } };
}
export async function confirmIncrement(userId, itemId, data) {
  if (get('SELECT item_id FROM manasync_pending_proxy_plans WHERE item_id = ? AND user_id = ?', [itemId,userId])) {
    return (await import('./pendingProxyPlans.js')).confirmPendingProxy(userId,itemId,data);
  }
  if (!uuid(data.operationId) || !positive(data.quantity)) throw new BridgeError('Provide a confirmation UUID and positive printed quantity.');
  const intent = JSON.stringify({ itemId,quantity:data.quantity,containerId:data.containerId || null,expectedConnection:data.expectedConnection });
  const previous = get('SELECT * FROM manasync_print_operations WHERE id=?',[data.operationId]);
  if (previous) {
    if (previous.user_id !== userId || previous.intent_json !== intent) throw new BridgeError('This confirmation ID is already used with a different quantity or destination.',409);
    return publicOperation(previous);
  }
  const item = get('SELECT * FROM manasync_print_items WHERE id=? AND user_id=?',[itemId,userId]);
  if (!item || item.cancelled) throw new BridgeError('Print item not found or cancelled.',404);
  const c = assertExpectedConnection(userId,data.expectedConnection);
  let destination;
  if (c?.connected) {
    const options = JSON.parse(c.containers_json || '[]').filter(v => !['list','incoming'].includes(v.kind));
    destination = data.containerId ? options.find(v => v.id === data.containerId) : options.find(v => v.kind === 'unassigned');
    if (!destination) throw new BridgeError('Choose a physical destination for these printed proxies.');
  }
  // Persist the confirmation before any network write; cached destinations allow offline confirmation.
  transaction(() => {
    const exists = get('SELECT * FROM manasync_print_operations WHERE id=?',[data.operationId]);
    if (exists) {
      if (exists.user_id !== userId || exists.intent_json !== intent) throw new BridgeError('Confirmation operation conflict.',409);
      return;
    }
    const current = get('SELECT * FROM manasync_print_items WHERE id=? AND user_id=?',[itemId,userId]);
    const confirmed = get("SELECT COALESCE(SUM(quantity),0) AS total FROM manasync_print_operations WHERE item_id=? AND kind='acquire'",[itemId]).total;
    if (current.cancelled || data.quantity > current.quantity-confirmed) throw new BridgeError('This quantity exceeds the unconfirmed print quantity. Refresh the queue.',409);
    const payload = destination ? JSON.stringify({ operationId:data.operationId,command:{ type:'acquire',input:{
      card:artworkCard(item,c.account_id),quantity:data.quantity,containerId:destination.id,isProxy:true,unitCost:null,currency:'USD',
      source:'clc',sourceRef:`${getInstanceId()}:${item.deck_id || 'print'}:${item.id}:${data.operationId}` } } }) : null;
    run(`INSERT INTO manasync_print_operations(id,user_id,item_id,quantity,intent_json,payload_json,base_url,token_cipher,account_id,actor_id,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,[data.operationId,userId,itemId,data.quantity,intent,payload,c?.connected ? c.base_url : null,
        c?.connected ? c.token_cipher : null,c?.connected ? c.account_id : null,c?.connected ? c.actor_id : null,payload ? 'pending' : 'local',new Date().toISOString()]);
  });
  await reportOperation(userId,data.operationId);
  return publicOperation(get('SELECT * FROM manasync_print_operations WHERE id=?',[data.operationId]));
}
export async function bindLocalIncrement(userId, id, containerId, expectedConnection) {
  const o = get('SELECT * FROM manasync_print_operations WHERE id=? AND user_id=?',[id,userId]);
  if (!o || o.status !== 'local') throw new BridgeError('Only local, never-submitted confirmations can be attached to a connection.',409);
  const c = assertExpectedConnection(userId,expectedConnection);
  if (!c?.connected) throw new BridgeError('Connect ManaSync before attaching this local confirmation.',409);
  const options = JSON.parse(c.containers_json || '[]').filter(v => !['list','incoming'].includes(v.kind));
  const destination = options.find(v => v.id === containerId) || (!containerId && options.find(v => v.kind === 'unassigned'));
  if (!destination) throw new BridgeError('Choose a physical destination.');
  const item = get('SELECT * FROM manasync_print_items WHERE id=?',[o.item_id]);
  const payload = JSON.stringify({ operationId:id,command:{ type:'acquire',input:{ card:artworkCard(item,c.account_id),quantity:o.quantity,
    containerId:destination.id,isProxy:true,unitCost:null,currency:'USD',source:'clc',
    sourceRef:`${getInstanceId()}:${item.deck_id || 'print'}:${item.id}:${id}` } } });
  run(`UPDATE manasync_print_operations SET payload_json=?,base_url=?,token_cipher=?,account_id=?,actor_id=?,status='pending'
    WHERE id=? AND user_id=? AND status='local'`,[payload,c.base_url,c.token_cipher,c.account_id,c.actor_id,id,userId]);
  await reportOperation(userId,id);
}
export async function reportOperation(userId, id, manual = false) {
  if (active.has(id) || !isBridgeUserActive(userId)) return;
  let o = get('SELECT * FROM manasync_print_operations WHERE id=? AND user_id=?',[id,userId]);
  if (o?.pending_id) return (await import('./pendingProxyPlans.js')).reportPendingAction(userId,id,manual);
  if (!o || !['pending','reconnect','review'].includes(o.status) || (!manual && (o.status !== 'pending' || o.next_attempt > Date.now() || o.attempts >= 6))) return;
  const c = connectionFor(userId);
  if (!c?.connected) return;
  if (c.actor_id !== o.actor_id || c.account_id !== o.account_id || c.base_url !== o.base_url) {
    run("UPDATE manasync_print_operations SET status='review',last_error=? WHERE id=?",['Connection changed. Reconnect the original token or reconcile the recorded holding; this operation will not be sent through a replacement token.',id]);
    return;
  }
  active.add(id);
  try {
    run("UPDATE manasync_print_operations SET attempts=attempts+1,status='pending',next_attempt=? WHERE id=?",[Date.now()+Math.min(3600000,15000*2**o.attempts),id]);
    o = get('SELECT * FROM manasync_print_operations WHERE id=?',[id]);
    if (JSON.parse(o.payload_json).command?.input?.card?.proxyArtwork) {
      const { uploadOperationArtwork } = await import('./printJobBridge.js');
      await uploadOperationArtwork(o);
      const current = connectionFor(userId);
      if (!current?.connected || current.actor_id !== o.actor_id || current.account_id !== o.account_id || current.base_url !== o.base_url) {
        throw new BridgeError('Connection changed during artwork upload. Reconnect the original account before retrying this confirmation.',409);
      }
    }
    const receipt = await remote(o,'/api/v1/inventory/commands',{method:'POST',body:o.payload_json});
    if (receipt.operationId !== id || !Number.isInteger(receipt.revision) || !Array.isArray(receipt.changes)) throw new BridgeError('Invalid command receipt; delivery remains uncertain.',502);
    const lot = receipt.changes.find(change => change.entity === 'lots' && change.value?.isProxy);
    if (o.kind === 'acquire' && !lot?.id) throw new BridgeError('The command receipt is missing the acquired proxy holding.',502);
    run("UPDATE manasync_print_operations SET status='reported',receipt_json=?,lot_id=?,last_error=NULL WHERE id=?",[JSON.stringify(receipt),lot?.id || o.lot_id,id]);
  } catch (error) {
    const status = error.status === 401 ? 'reconnect' : error.status === 409 ? 'review' : error.status >= 400 && error.status < 500 && ![408,429].includes(error.status) ? 'failed' : 'pending';
    run('UPDATE manasync_print_operations SET status=?,last_error=? WHERE id=?',[status,error.message,id]);
  } finally { active.delete(id); }
}
export async function processPending() {
  await (await import('./pendingProxyPlans.js')).processPendingProxyPlans();
  const rows = all(`SELECT o.id,o.user_id FROM manasync_print_operations o JOIN users u ON u.id=o.user_id
    WHERE u.suspended=0 AND o.status='pending' AND o.attempts<6 AND o.next_attempt<=? ORDER BY o.created_at LIMIT 20`,[Date.now()]);
  for (const o of rows) await reportOperation(o.user_id,o.id);
}
export async function reconcile(userId,id) {
  const o = get('SELECT * FROM manasync_print_operations WHERE id=? AND user_id=?',[id,userId]);
  if (!o?.payload_json) throw new BridgeError('Confirmation not found.',404);
  const c = requireConnection(userId);
  if (c.account_id !== o.account_id || c.base_url !== o.base_url) throw new BridgeError('Reconnect the original ManaSync account and backend to inspect this confirmation.',409);
  // A replacement actor may READ an owner-scoped receipt, but never replay the old command.
  if (o.status !== 'reported') {
    try {
      const receipt = await remote(c,`/api/v1/inventory/operations/${encodeURIComponent(id)}?actorId=${encodeURIComponent(o.actor_id)}`);
      if (receipt.operationId !== id || !Number.isInteger(receipt.revision) || !Array.isArray(receipt.changes)) throw new BridgeError('ManaSync returned an invalid historical receipt.',502);
      const lot = receipt.changes.find(change => change.entity === 'lots' && change.value?.isProxy);
      if (o.kind === 'acquire' && !lot?.id) throw new BridgeError('Historical receipt is missing its proxy holding.',502);
      run("UPDATE manasync_print_operations SET status='reported',receipt_json=?,lot_id=?,last_error=NULL WHERE id=?",[JSON.stringify(receipt),lot?.id || o.lot_id,id]);
    } catch (error) { if (error.status !== 404) throw error; }
  }
  const current = get('SELECT * FROM manasync_print_operations WHERE id=?',[id]);
  const inventory = await readRemote(userId,'/api/v1/inventory');
  const command = JSON.parse(o.payload_json).command || {};
  const lots = (inventory.lots || []).filter(lot => lot.id === current.lot_id || (command.input && lot.source === 'clc' && lot.sourceRef === command.input.sourceRef && lot.isProxy));
  return { operation:publicOperation(current),lots };
}
// Corrections always use a fresh UUID and explicit reviewed revision; never infer a revised quantity.
export async function correctLot(userId,id,data) {
  const o = get('SELECT * FROM manasync_print_operations WHERE id=? AND user_id=?',[id,userId]);
  if (!o?.lot_id || !['reported'].includes(o.status)) throw new BridgeError('A reported proxy holding is required.',409);
  const c = requireConnection(userId);
  if (c.account_id !== o.account_id || c.base_url !== o.base_url) throw new BridgeError('Reconnect the original ManaSync account.',409);
  if (!uuid(data.operationId) || !Number.isInteger(data.expectedRevision) || !['adjust','move'].includes(data.type)) throw new BridgeError('Provide a new operation ID and the reviewed holding revision.');
  let command;
  if (data.type === 'adjust') {
    if (!Number.isInteger(data.quantity) || data.quantity < 0 || data.quantity > 10000 || typeof data.reason !== 'string' || !data.reason.trim()) throw new BridgeError('Provide a reviewed total quantity and reason.');
    command = { type:'adjust',lotId:o.lot_id,expectedRevision:data.expectedRevision,quantity:data.quantity,reason:data.reason.trim() };
  } else {
    if (!positive(data.quantity) || typeof data.containerId !== 'string') throw new BridgeError('Provide the quantity and destination to move.');
    command = { type:'move',lotId:o.lot_id,expectedRevision:data.expectedRevision,quantity:data.quantity,containerId:data.containerId };
  }
  const payload = JSON.stringify({operationId:data.operationId,command});
  const previous = get('SELECT * FROM manasync_print_operations WHERE id=?',[data.operationId]);
  if (previous && (previous.user_id !== userId || previous.payload_json !== payload)) throw new BridgeError('Correction operation conflict.',409);
  if (!previous) run(`INSERT INTO manasync_print_operations(id,user_id,item_id,kind,quantity,intent_json,payload_json,base_url,token_cipher,account_id,actor_id,status,lot_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,[data.operationId,userId,o.item_id,data.type,0,payload,payload,c.base_url,c.token_cipher,c.account_id,c.actor_id,o.lot_id,new Date().toISOString()]);
  await reportOperation(userId,data.operationId);
  return publicOperation(get('SELECT * FROM manasync_print_operations WHERE id=?',[data.operationId]));
}
