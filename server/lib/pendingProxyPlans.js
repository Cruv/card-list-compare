/** Native PDFs publish plans, never inventory. Only reviewed confirmations create holdings. */
import { randomUUID } from 'node:crypto';
import { all, get, run, transaction } from '../db.js';
import { BridgeError, connectionFor, remote, artworkCard, assertExpectedConnection, listQueue,
  isBridgeUserActive, assertCurrentConnection, cachedRemoteRead, invalidatePendingRead, PUBLICATION_ATTEMPT_LIMIT } from './manasyncBridge.js';
import { stagePrintJob, uploadOperationArtwork } from './printJobBridge.js';

const activePlans = new Set(), activeActions = new Set();
let workerActive = false;
const timestamp = () => new Date().toISOString();
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const fail = (message, status = 409) => { throw new BridgeError(message, status); };
const planFor = (userId,id) => get('SELECT * FROM manasync_pending_proxy_plans WHERE item_id=? AND user_id=?',[id,userId]);
const itemFor = (userId,id) => get('SELECT * FROM manasync_print_items WHERE id=? AND user_id=?',[id,userId]);
const matches = (connection, plan) => connection?.connected && (!plan.account_id || (connection.account_id === plan.account_id && connection.base_url === plan.base_url));
const publicAction = operation => ({ id:operation.id,itemId:operation.item_id,kind:operation.kind,quantity:operation.quantity,
  status:operation.status,attempts:operation.attempts,error:operation.last_error,lotId:operation.lot_id,
  receipt:operation.receipt_json ? JSON.parse(operation.receipt_json) : null,accountId:operation.account_id,createdAt:operation.created_at });
const publicationHeld = plan => !plan.remote_json && (plan.status === 'held' || plan.attempts >= PUBLICATION_ATTEMPT_LIMIT);
const permanentPublicationError = error => error.permanent || error.status === 507
  || (error.status >= 400 && error.status < 500 && ![408,425,429].includes(error.status))
  || /quota|storage[_ -]?(?:full|limit)|(?:storage|capacity).*exceed/i.test(`${error.code || ''} ${error.message || ''}`);

function validatePending(plan, value) {
  const original = JSON.parse(plan.create_payload);
  if (!value || value.id !== plan.item_id || value.source !== 'clc' || value.sourceRef !== original.sourceRef
    || value.quantity !== original.quantity || !['pending','partial','confirmed','dismissed'].includes(value.status)
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Array.isArray(value.confirmations)
    || ['quantity','confirmedQuantity','dismissedQuantity','remainingQuantity'].some(field => !Number.isSafeInteger(value[field]) || value[field] < 0)
    || value.confirmedQuantity + value.dismissedQuantity + value.remainingQuantity !== value.quantity
    || value.card?.proxyArtwork?.front !== original.card.proxyArtwork.front
    || (value.card?.proxyArtwork?.back || null) !== (original.card.proxyArtwork.back || null)) {
    fail('ManaSync returned an invalid pending print plan. Refresh or reconcile its outcome before making another quantity decision.',502);
  }
  const decisions = new Set();
  for (const entry of value.confirmations) {
    if (!entry || typeof entry.operationId !== 'string' || !entry.operationId.length || entry.operationId.length > 200 || typeof entry.actorId !== 'string'
      || !Number.isSafeInteger(entry.quantity) || entry.quantity < 1 || !uuid(entry.lotId)) fail('ManaSync returned invalid print confirmation history.',502);
    const key = JSON.stringify([entry.actorId,entry.operationId]);
    if (decisions.has(key)) fail('ManaSync returned duplicate print confirmation history.',502);
    decisions.add(key);
  }
  if (value.confirmations.reduce((sum,entry) => sum+entry.quantity,0) !== value.confirmedQuantity) fail('ManaSync print confirmation history does not match its quantity.',502);
  const expectedStatus = value.dismissedQuantity ? 'dismissed' : value.remainingQuantity === 0 ? 'confirmed' : value.confirmedQuantity ? 'partial' : 'pending';
  if (value.status !== expectedStatus || (value.dismissedQuantity && value.remainingQuantity)) fail('ManaSync pending print status does not match its remaining quantity.',502);
  return value;
}

function savePending(plan, value, inTransaction = false) {
  const pending = validatePending(plan,value);
  const save = () => {
    const current = planFor(plan.user_id,plan.item_id);
    if (!current) fail('This pending print record is no longer available.',409);
    const previous = current.remote_json ? JSON.parse(current.remote_json) : null;
    // A slow GET must never erase a more recent confirmation response.
    if (previous && previous.revision > pending.revision) return;
    if (previous && (pending.confirmedQuantity < previous.confirmedQuantity
      || pending.dismissedQuantity < previous.dismissedQuantity
      || previous.confirmations.some(before => !pending.confirmations.some(after => after.operationId === before.operationId
        && after.actorId === before.actorId && after.quantity === before.quantity && after.lotId === before.lotId))
      || (previous.revision === pending.revision && (previous.confirmedQuantity !== pending.confirmedQuantity
        || previous.dismissedQuantity !== pending.dismissedQuantity || previous.remainingQuantity !== pending.remainingQuantity)))) {
      fail('ManaSync returned inconsistent pending print history. Keep the previous record and refresh before another quantity decision.',502);
    }
    // Publication is durable. A healthy published plan is not background work.
    run("UPDATE manasync_pending_proxy_plans SET status='published',remote_json=?,last_error=NULL,next_attempt=0,attempts=0 WHERE item_id=?",
      [JSON.stringify(pending),plan.item_id]);
    for (const entry of pending.confirmations) {
      run("UPDATE manasync_print_operations SET status='reported',lot_id=?,last_error=NULL WHERE pending_id=? AND id=? AND actor_id=? AND kind='acquire' AND quantity=?",
        [entry.lotId,plan.item_id,entry.operationId,entry.actorId,entry.quantity]);
    }
    if (pending.remainingQuantity === 0) run('UPDATE manasync_pending_proxy_plans SET cancel_requested=0 WHERE item_id=?',[plan.item_id]);
  };
  if (inTransaction) save(); else transaction(save);
  return pending;
}

async function getRemotePlan(plan, connection) {
  const result = await remote(connection,`/api/v1/pending-proxies/${encodeURIComponent(plan.item_id)}`);
  assertCurrentConnection(connection);
  return savePending(plan,result.pending);
}

/** The manifest is already committed; a bridge failure must not fail the ready PDF. */
export async function stagePreparedPrintJob(userId, jobId) {
  try {
    const result = stagePrintJob(userId,jobId);
    run('UPDATE print_jobs SET proxy_staging_error=NULL,proxy_staging_next_attempt=0 WHERE id=? AND user_id=?',[jobId,userId]);
    return result;
  } catch (error) {
    run('UPDATE print_jobs SET proxy_staging_error=?,proxy_staging_next_attempt=? WHERE id=? AND user_id=?',
      [error.message,Date.now()+300000,jobId,userId]);
    return null;
  }
}

export async function syncPendingProxy(userId,id,manual=false) {
  if (activePlans.has(id) || !isBridgeUserActive(userId)) return;
  let plan = planFor(userId,id);
  if (!plan || plan.status === 'dismissed' || publicationHeld(plan)
    || (plan.remote_json && !plan.cancel_requested) || (!manual && plan.next_attempt > Date.now())) return;
  const connection = connectionFor(userId);
  if (!matches(connection,plan)) return;
  const publicationWasPrepared = !!plan.create_payload;
  activePlans.add(id);
  try {
    if (plan.remote_json) {
      // Freeze a revision-locked dismissal from the last validated view. A stale
      // revision is rejected for review; no unbounded pre-outbox GET is needed.
      // The ordinary action outbox then owns its bounded, exact-byte delivery.
      await deliverCancellation(planFor(userId,id),manual);
      return;
    }
    const item = itemFor(userId,id);
    if (!plan.create_payload) {
      // The job label is frozen with its print plan and also exists for standalone
      // lists. Legacy jobs without a label retain the tracked-deck fallback.
      const job = item.print_job_id && get('SELECT plan_json FROM print_jobs WHERE id=? AND user_id=?',[item.print_job_id,userId]);
      const jobName = job && JSON.parse(job.plan_json).deckName;
      const deck = !jobName && item.deck_id && get('SELECT deck_name FROM tracked_decks WHERE id=? AND user_id=?',[item.deck_id,userId]);
      const label = typeof jobName === 'string' && jobName.trim() ? jobName : deck?.deck_name;
      const payload = JSON.stringify({ source:'clc',sourceRef:item.print_job_id,card:artworkCard(item,connection.account_id),quantity:item.quantity,
        ...(label ? {label:Array.from(label).slice(0,200).join('')} : {}) });
      // Pin before the first upload or create request; an uncertain write cannot be redirected.
      run("UPDATE manasync_pending_proxy_plans SET create_payload=?,base_url=?,account_id=?,status='publishing' WHERE item_id=? AND create_payload IS NULL",
        [payload,connection.base_url,connection.account_id,id]);
      plan = planFor(userId,id);
    }
    run('UPDATE manasync_pending_proxy_plans SET attempts=attempts+1,next_attempt=? WHERE item_id=?',
      [Date.now()+Math.min(300000,15000*2**Math.min(plan.attempts,5)),id]);
    {
      let found = false;
      // Resolve a lost PUT using any current token of the same owner, including after rotation.
      if (publicationWasPrepared || plan.attempts > 0) {
        try { await getRemotePlan(plan,connection); found = true; }
        catch (error) { if (error.status !== 404) throw error; }
      }
      if (!found) {
        const create = JSON.parse(plan.create_payload);
        await uploadOperationArtwork({ ...connection,user_id:userId,item_id:id,
          payload_json:JSON.stringify({command:{input:{card:create.card}}}) });
        if (!matches(connectionFor(userId),plan)) fail('Reconnect this plan’s original ManaSync account and backend to finish publishing.');
        let result;
        try { result = await remote(connection,`/api/v1/pending-proxies/${encodeURIComponent(id)}`,{method:'PUT',body:plan.create_payload}); }
        catch (error) {
          if ([404,405].includes(error.status)) throw new BridgeError('Update ManaSync to support pending proxy prints, then retry publication.',503,{permanent:true});
          throw error;
        }
        assertCurrentConnection(connection);
        savePending(plan,result.pending);
        invalidatePendingRead(userId);
      }
    }
    plan = planFor(userId,id);
    if (plan.cancel_requested) await deliverCancellation(plan,manual);
  } catch (error) {
    const current = planFor(userId,id);
    if (!current) return;
    const held = !current.remote_json && (permanentPublicationError(error) || current.attempts >= PUBLICATION_ATTEMPT_LIMIT);
    run('UPDATE manasync_pending_proxy_plans SET last_error=?,status=CASE WHEN ? THEN \'held\' ELSE status END WHERE item_id=?',
      [error.message,held ? 1 : 0,id]);
  } finally { activePlans.delete(id); }
}

function saveAction(plan,connection,id,kind,quantity,intent,payload) {
  run(`INSERT INTO manasync_print_operations(id,user_id,item_id,pending_id,kind,quantity,intent_json,payload_json,
    base_url,token_cipher,account_id,actor_id,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`,
  [id,plan.user_id,plan.item_id,plan.item_id,kind,quantity,intent,JSON.stringify(payload),connection.base_url,
    connection.token_cipher,connection.account_id,connection.actor_id,timestamp()]);
}

export async function confirmPendingProxy(userId,itemId,data) {
  if (!uuid(data.operationId) || !Number.isInteger(data.quantity) || data.quantity < 1 || data.quantity > 10000
    || !Number.isSafeInteger(data.expectedRevision) || data.expectedRevision < 1) fail('Provide a confirmation UUID, usable quantity, and reviewed pending print revision.',400);
  const intent = JSON.stringify({itemId,quantity:data.quantity,containerId:data.containerId || null,
    expectedConnection:data.expectedConnection,expectedRevision:data.expectedRevision});
  const previous = get('SELECT * FROM manasync_print_operations WHERE id=?',[data.operationId]);
  if (previous) {
    if (previous.user_id !== userId || previous.intent_json !== intent) fail('This confirmation ID is already used with a different quantity or destination.');
    return publicAction(previous);
  }
  transaction(() => {
    const plan = planFor(userId,itemId), item = itemFor(userId,itemId);
    if (!plan || !item || item.cancelled) fail('Pending print item not found or dismissed.',404);
    const connection = assertExpectedConnection(userId,data.expectedConnection);
    if (!matches(connection,plan) || !plan.remote_json) fail('Wait for this print plan to publish to its original ManaSync account, then refresh before confirming.');
    const pending = JSON.parse(plan.remote_json);
    if (plan.cancel_requested || get("SELECT id FROM manasync_print_operations WHERE pending_id=? AND status IN ('pending','reconnect')",[itemId])) fail('Resolve the outstanding quantity decision before confirming more copies.');
    if (data.expectedRevision !== pending.revision || data.quantity > pending.remainingQuantity) fail('This pending print quantity changed. Refresh and review the remaining copies.');
    const destinations = JSON.parse(connection.containers_json || '[]').filter(value => !['list','incoming'].includes(value.kind));
    const destination = data.containerId ? destinations.find(value => value.id === data.containerId) : destinations.find(value => value.kind === 'unassigned');
    if (!destination) fail('Choose a physical destination for these printed proxies.',400);
    saveAction(plan,connection,data.operationId,'acquire',data.quantity,intent,
      {operationId:data.operationId,quantity:data.quantity,containerId:destination.id,expectedRevision:data.expectedRevision});
  });
  await reportPendingAction(userId,data.operationId);
  return publicAction(get('SELECT * FROM manasync_print_operations WHERE id=?',[data.operationId]));
}

export async function reportPendingAction(userId,id,manual=false) {
  if (!isBridgeUserActive(userId)) return;
  const operation = get('SELECT * FROM manasync_print_operations WHERE id=? AND user_id=? AND pending_id IS NOT NULL',[id,userId]);
  if (!operation || activeActions.has(id) || operation.status === 'reported'
    || (!manual && (operation.status !== 'pending' || operation.next_attempt > Date.now() || operation.attempts >= 6))) return;
  const connection = connectionFor(userId), plan = planFor(userId,operation.pending_id);
  if (!matches(connection,plan)) return;
  if (connection.actor_id !== operation.actor_id) {
    run("UPDATE manasync_print_operations SET status='reconnect',last_error=? WHERE id=?",
      ['This decision belongs to the original token. Refresh or reconcile its receipt before making another decision; retry requires the original token.',id]);
    return;
  }
  activeActions.add(id);
  try {
    run("UPDATE manasync_print_operations SET status='pending',attempts=attempts+1,next_attempt=? WHERE id=?",
      [Date.now()+Math.min(300000,15000*2**Math.min(operation.attempts,5)),id]);
    const result = await remote(operation,`/api/v1/pending-proxies/${encodeURIComponent(operation.pending_id)}/${operation.kind === 'dismiss' ? 'dismiss' : 'confirm'}`,
      {method:'POST',body:operation.payload_json});
    const receipt = result.receipt;
    if (receipt?.operationId !== id || !Number.isSafeInteger(receipt.revision) || !Array.isArray(receipt.changes)) fail('Invalid quantity decision receipt; delivery remains uncertain.',502);
    const pending = validatePending(plan,result.pending);
    const confirmation = pending.confirmations.find(entry => entry.operationId === id && entry.actorId === operation.actor_id);
    if (operation.kind === 'acquire' && (!confirmation || confirmation.quantity !== operation.quantity)) fail('The quantity decision receipt is missing its confirmed proxy holding.',502);
    transaction(() => {
      savePending(plan,pending,true);
      run("UPDATE manasync_print_operations SET status='reported',receipt_json=?,lot_id=?,last_error=NULL WHERE id=?",
        [JSON.stringify(receipt),confirmation?.lotId || null,id]);
      if (operation.kind === 'dismiss') run('UPDATE manasync_pending_proxy_plans SET cancel_requested=0 WHERE item_id=?',[plan.item_id]);
    });
    invalidatePendingRead(userId);
  } catch (error) {
    const status = error.status === 401 ? 'reconnect' : error.status >= 400 && error.status < 500 && ![408,429].includes(error.status) ? 'review' : 'pending';
    run('UPDATE manasync_print_operations SET status=?,last_error=? WHERE id=?',[status,error.message,id]);
    if (status === 'review') {
      // A definitive rejection did not consume copies. Refresh before a new reviewed decision.
      if (operation.kind === 'dismiss') run('UPDATE manasync_pending_proxy_plans SET cancel_requested=0,cancel_operation_id=NULL WHERE item_id=?',[plan.item_id]);
      try { await getRemotePlan(plan,connection); } catch { /* Retain the last known state and the action error. */ }
    }
  } finally { activeActions.delete(id); }
}

async function deliverCancellation(plan,manual=false) {
  const pending = plan.remote_json ? JSON.parse(plan.remote_json) : null;
  if (!pending) return;
  if (pending.remainingQuantity === 0) {
    if (plan.cancel_requested) run('UPDATE manasync_pending_proxy_plans SET cancel_requested=0 WHERE item_id=?',[plan.item_id]);
    return;
  }
  validatePending(plan,pending);
  const existing = get('SELECT * FROM manasync_print_operations WHERE id=?',[plan.cancel_operation_id]);
  if (existing) { await reportPendingAction(plan.user_id,existing.id,manual); return; }
  const connection = connectionFor(plan.user_id);
  if (!matches(connection,plan)) return;
  transaction(() => saveAction(plan,connection,plan.cancel_operation_id,'dismiss',0,
    JSON.stringify({itemId:plan.item_id,kind:'dismiss'}),{operationId:plan.cancel_operation_id,expectedRevision:pending.revision}));
  await reportPendingAction(plan.user_id,plan.cancel_operation_id,manual);
}

export async function cancelPendingProxy(userId,itemId) {
  let plan = planFor(userId,itemId);
  if (!plan) fail('Pending print item not found.',404);
  if (!plan.create_payload) {
    transaction(() => {
      run("UPDATE manasync_pending_proxy_plans SET status='dismissed',cancel_requested=0,last_error=NULL WHERE item_id=?",[itemId]);
      run('UPDATE manasync_print_items SET cancelled=1 WHERE id=?',[itemId]);
    });
  } else {
    if (plan.remote_json && JSON.parse(plan.remote_json).remainingQuantity === 0) return;
    run('UPDATE manasync_pending_proxy_plans SET cancel_requested=1,cancel_operation_id=COALESCE(cancel_operation_id,?),next_attempt=0 WHERE item_id=?',[randomUUID(),itemId]);
    await syncPendingProxy(userId,itemId,true);
    plan = planFor(userId,itemId);
    if (plan.cancel_requested && !plan.last_error && !matches(connectionFor(userId),plan)) {
      run('UPDATE manasync_pending_proxy_plans SET last_error=? WHERE item_id=?',['Dismissal is saved. Reconnect the original account and backend to dismiss the remaining copies in ManaSync.',itemId]);
    }
  }
  return listQueue(userId).find(item => item.id === itemId);
}

export function pendingProxyRefreshScope(scope = {}) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || (scope.deckId !== undefined && (!Number.isSafeInteger(scope.deckId) || scope.deckId < 1))
    || (scope.printJobId !== undefined && !uuid(scope.printJobId))) fail('Provide a valid deck or print batch to refresh.',400);
  return {deckId:scope.deckId ?? null,printJobId:scope.printJobId ?? null};
}

/** User review is one shared owner read, never an upload/retry of held publication. */
export async function refreshPendingProxyPlans(userId,scope = {}) {
  const {deckId,printJobId} = pendingProxyRefreshScope(scope);
  if (!isBridgeUserActive(userId)) return;
  const connection = connectionFor(userId);
  if (!connection?.connected) return;
  const rows = all(`SELECT p.* FROM manasync_pending_proxy_plans p
    JOIN manasync_print_items i ON i.id=p.item_id AND i.user_id=p.user_id
    WHERE p.user_id=? AND p.status!='dismissed' AND p.create_payload IS NOT NULL
    AND (? IS NULL OR i.deck_id=?) AND (? IS NULL OR i.print_job_id=?)
    AND p.account_id=? AND p.base_url=?`,[userId,deckId,deckId,printJobId,printJobId,connection.account_id,connection.base_url]);
  if (!rows.length) return;
  const result = await cachedRemoteRead(connection,'/api/v1/pending-proxies');
  assertCurrentConnection(connection);
  if (!Array.isArray(result.items) || result.items.length > 100000) fail('ManaSync returned an invalid pending print collection.',502);
  const byId = new Map();
  for (const value of result.items) {
    if (!value || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value.id) || byId.has(value.id)) {
      fail('ManaSync returned an invalid pending print collection.',502);
    }
    byId.set(value.id,value);
  }
  // Validate all recognized entries before any write. Unknown or omitted IDs are
  // never interpreted as confirmations, dismissals, or permission to republish.
  for (const plan of rows) if (byId.has(plan.item_id)) validatePending(plan,byId.get(plan.item_id));
  transaction(() => {
    assertCurrentConnection(connection);
    for (const original of rows) {
      const plan = planFor(userId,original.item_id);
      if (!plan || plan.status === 'dismissed' || !matches(connection,plan)) continue;
      if (byId.has(plan.item_id)) savePending(plan,byId.get(plan.item_id),true);
      else if (plan.remote_json) run('UPDATE manasync_pending_proxy_plans SET last_error=? WHERE item_id=?',
        ['ManaSync did not return this pending print. The last known record is retained; refresh or inspect it before another quantity decision.',plan.item_id]);
    }
  });
}

/** A deliberate new retry budget still reuses the original immutable publication. */
export async function retryPendingProxyPublication(userId,id,data = {}) {
  const plan = planFor(userId,id);
  if (!plan) fail('Pending print item not found.',404);
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('Refresh the connection before retrying publication.',400);
  const connection = assertExpectedConnection(userId,data.expectedConnection);
  if (!matches(connection,plan)) fail('Reconnect this plan’s original ManaSync account and backend before retrying publication.');
  if (!isBridgeUserActive(userId)) fail('ManaSync delivery is paused because this CLC account is suspended or unavailable.',503);
  if (plan.remote_json || plan.status === 'dismissed') return listQueue(userId).find(item => item.id === id);
  if (activePlans.has(id)) fail('This publication attempt is already in progress. Refresh its record before retrying.',409);
  run("UPDATE manasync_pending_proxy_plans SET attempts=0,next_attempt=0,status=CASE WHEN create_payload IS NULL THEN 'local' ELSE 'publishing' END,last_error=NULL WHERE item_id=?",[id]);
  // A pre-existing frozen payload makes sync read its original id first, without
  // spending an extra attempt or generating replacement publication bytes.
  await syncPendingProxy(userId,id,true);
  return listQueue(userId).find(item => item.id === id);
}

export async function processPendingProxyPlans() {
  if (workerActive) return;
  workerActive = true;
  try {
    const jobs = all(`SELECT id,user_id FROM print_jobs WHERE manifest_json IS NOT NULL
      AND state IN ('ready','queued','claimed','submitted','submitting','awaiting_refeed','backs_pending','awaiting_paper_reset','uncertain','completed')
      AND COALESCE(proxy_staging_next_attempt,0)<=? AND NOT EXISTS
      (SELECT 1 FROM manasync_print_items WHERE print_job_id=print_jobs.id AND user_id=print_jobs.user_id)
      ORDER BY created_at LIMIT 2`,[Date.now()]);
    for (const job of jobs) await stagePreparedPrintJob(job.user_id,job.id);
    const plans = all(`SELECT p.item_id,p.user_id FROM manasync_pending_proxy_plans p JOIN manasync_connections c ON c.user_id=p.user_id
      JOIN users u ON u.id=p.user_id
      WHERE u.suspended=0 AND p.status!='dismissed' AND p.next_attempt<=? AND c.connected=1
      AND ((p.remote_json IS NULL AND p.status!='held' AND p.attempts<?) OR (p.remote_json IS NOT NULL AND p.cancel_requested=1))
      AND (p.account_id IS NULL OR (p.account_id=c.account_id AND p.base_url=c.base_url))
      ORDER BY p.next_attempt,p.created_at LIMIT 4`,[Date.now(),PUBLICATION_ATTEMPT_LIMIT]);
    for (const plan of plans) await syncPendingProxy(plan.user_id,plan.item_id);
  } finally { workerActive = false; }
}
