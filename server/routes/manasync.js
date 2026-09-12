import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  initBridgeSchema, connectionStatus, connect, disconnect, checkConnection, readRemote, containers,
  queueItem, queueItems, listQueue, cancelItem, confirmIncrement, bindLocalIncrement, reportOperation,
  processPending, reconcile, correctLot, markOwnershipRead,
} from '../lib/manasyncBridge.js';

const router = Router();
router.use(requireAuth);
// Upstream authentication failure must not invalidate the user's independent CLC login.
const handle = fn => async (req,res) => {
  try { res.json(await fn(req)); }
  catch (error) { res.status(error.status === 401 ? 424 : error.status || 502).json({error:error.message}); }
};
router.get('/connection',handle(req => connectionStatus(req.user.userId)));
router.put('/connection',handle(req => connect(req.user.userId,req.body)));
router.post('/connection/check',handle(req => checkConnection(req.user.userId)));
router.delete('/connection',handle(req => disconnect(req.user.userId)));
router.get('/availability',handle(async req => {
  const by = req.query.by === 'printing' ? 'printing' : 'oracle';
  try {
    const before = connectionStatus(req.user.userId);
    const result = await readRemote(req.user.userId,`/api/v1/availability?by=${by}`);
    const after = connectionStatus(req.user.userId);
    if (!after.connected || before.accountId !== after.accountId || before.actorId !== after.actorId || before.baseUrl !== after.baseUrl) throw new Error('The ManaSync connection changed during refresh. Refresh ownership again.');
    if (!Array.isArray(result.availability)) throw new Error('ManaSync returned invalid ownership data.');
    markOwnershipRead(req.user.userId);
    return {known:true,availability:result.availability,connection:connectionStatus(req.user.userId)};
  } catch (error) {
    return {known:false,availability:[],error:error.message,connection:connectionStatus(req.user.userId)};
  }
}));
router.get('/containers',handle(async req => ({containers:await containers(req.user.userId)})));
router.get('/print-queue',handle(req => ({items:listQueue(req.user.userId,Number(req.query.deckId) || null)})));
router.post('/print-queue/batch',handle(req => ({items:queueItems(req.user.userId,req.body)})));
router.post('/print-queue/refresh',handle(async req => {
  await (await import('../lib/pendingProxyPlans.js')).refreshPendingProxyPlans(req.user.userId);
  return {items:listQueue(req.user.userId)};
}));
router.post('/print-queue',handle(req => ({item:queueItem(req.user.userId,req.body)})));
router.post('/print-jobs/:jobId/confirmation-queue',handle(async req => {
  const { stagePrintJob } = await import('../lib/printJobBridge.js');
  return stagePrintJob(req.user.userId, req.params.jobId);
}));
router.get('/print-queue/:id/artwork/:face',async (req,res,next) => {
  try {
    const { ownedQueueArtwork } = await import('../lib/printJobBridge.js');
    const artwork = ownedQueueArtwork(req.user.userId, req.params.id, req.params.face);
    res.set({ 'Content-Type':artwork.contentType, 'Content-Length':String(artwork.bytes.length),
      'Cache-Control':'private, no-store', 'X-Content-SHA256':artwork.sha256 });
    res.send(artwork.bytes);
  } catch (error) {
    if (error.status) res.status(error.status).json({error:error.message});
    else next(error);
  }
});
router.post('/print-queue/:id/cancel',handle(async req => { await cancelItem(req.user.userId,req.params.id);return {ok:true}; }));
router.post('/print-queue/:id/confirm',handle(async req => ({operation:await confirmIncrement(req.user.userId,req.params.id,req.body)})));
router.post('/operations/:id/retry',handle(async req => {await reportOperation(req.user.userId,req.params.id,true);return {ok:true};}));
router.post('/operations/:id/bind',handle(async req => {await bindLocalIncrement(req.user.userId,req.params.id,req.body.containerId,req.body.expectedConnection);return {ok:true};}));
router.get('/operations/:id/reconcile',handle(req => reconcile(req.user.userId,req.params.id)));
router.post('/operations/:id/correct',handle(async req => ({operation:await correctLot(req.user.userId,req.params.id,req.body)})));

export function startManaSyncRetryWorker() {
  initBridgeSchema();
  let running = false;
  const retry = async () => {
    if (running) return;
    running = true;
    try { await processPending(); } catch (error) { console.error('ManaSync retry worker:',error.message); }
    finally { running = false; }
  };
  const timer = setInterval(retry,15000);
  timer.unref();
  void retry();
  return () => clearInterval(timer);
}
export default router;
