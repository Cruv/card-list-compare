import { useCallback, useEffect, useState } from 'react';
import { getPrintQueue, getManaSyncContainers, getManaSyncConnection, confirmPrinted, cancelPrintItem,
  retryPrintReport, bindPrintReport, reconcilePrintReport, correctPrintReport, refreshPendingProxyPrints } from '../lib/api';
import { createOperationId } from '../lib/operationId';
import PrintQueueArtwork from './PrintQueueArtwork';
import './ManaSync.css';

function expectedConnection(connection) {
  return connection?.connected ? {accountId:connection.accountId,actorId:connection.actorId,baseUrl:connection.baseUrl} : null;
}
function savedRequest(key, build) {
  const saved = localStorage.getItem(key);
  const request = saved ? JSON.parse(saved) : build();
  localStorage.setItem(key,JSON.stringify(request));
  return request;
}
export default function PrintQueue({deckId,printJobId,refreshKey,onReported}) {
  const [items,setItems] = useState([]);
  const [connection,setConnection] = useState(null);
  const [locations,setLocations] = useState([]);
  const [destination,setDestination] = useState('');
  const [quantities,setQuantities] = useState({});
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [inspection,setInspection] = useState(null);
  const [correction,setCorrection] = useState({quantity:0,reason:'',containerId:''});
  const refresh = useCallback(async (syncPending = false) => {
    const [queue,c] = await Promise.all([syncPending ? refreshPendingProxyPrints() : getPrintQueue(deckId),getManaSyncConnection()]);
    const deckItems = deckId ? queue.items.filter(item => item.deckId === Number(deckId)) : queue.items;
    setItems(printJobId ? deckItems.filter(item => item.printJobId === printJobId) : deckItems);setConnection(c);
    if (c.connected) {
      try {const result = await getManaSyncContainers();setLocations(result.containers);}
      catch {setLocations([]);}
    } else setLocations([]);
  },[deckId,printJobId]);
  useEffect(() => {refresh().catch(e => setError(e.message));},[refresh,refreshKey]);
  useEffect(() => {
    if (!printJobId && !items.some(item => item.printJobId || item.operations.some(o => o.status === 'pending' && o.attempts < 6))) return;
    const timer = setInterval(() => {refresh(true).catch(e => setError(e.message));},15000);
    return () => clearInterval(timer);
  },[items,printJobId,refresh]);
  async function act(action) {
    if (busy) return;setBusy(true);setError('');
    try {await action();await refresh();onReported?.();}
    catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  async function confirm(item) {
    const key = `clc-print-confirmation:${item.id}`;
    const request = savedRequest(key,() => ({operationId:createOperationId(),quantity:Number(quantities[item.id] ?? item.remaining),containerId:destination || null,expectedConnection:expectedConnection(connection),...(item.pendingProxy && item.pendingProxy.status !== 'legacy' ? {expectedRevision:item.pendingProxy.revision} : {})}));
    try {await confirmPrinted(item.id,request);}
    catch(error) {if (error.status >= 400 && error.status < 500) localStorage.removeItem(key);throw error;}
    localStorage.removeItem(key);
    setQuantities(previous => {const next = {...previous};delete next[item.id];return next;});
  }
  async function inspect(operation) {
    const result = await reconcilePrintReport(operation.id);
    setInspection(result);
    setCorrection({quantity:result.lots[0]?.quantity || 0,reason:'',containerId:result.lots[0]?.containerId || ''});
  }
  async function correct(type) {
    const operation = inspection.operation;
    const key = `clc-print-correction:${operation.id}`;
    const request = savedRequest(key,() => ({operationId:createOperationId(),type,quantity:Number(correction.quantity),
      reason:correction.reason,containerId:correction.containerId,expectedRevision:inspection.lots[0].revision}));
    let result;
    try {result = await correctPrintReport(operation.id,request);}
    catch(error) {if (error.status >= 400 && error.status < 500) localStorage.removeItem(key);throw error;}
    localStorage.removeItem(key);setInspection(null);
    if (result.operation.status !== 'reported') setError(result.operation.error || 'Correction saved for delivery.');
  }
  return <details className="mana-sync-print-queue" open={!!printJobId || items.length > 0}>
    <summary>{printJobId ? 'Printed proxies from this batch' : 'Print queue and confirmed physical prints'} {items.length ? `(${items.length})` : ''}</summary>
    <p>Prepared batches appear in ManaSync&rsquo;s Proxy binder under Pending prints with their actual artwork. Confirm usable copies there or here after printing; the result stays in sync. Dismiss any failed or cancelled copies. Pending prints are separate from your available proxies.</p>
    <p>{!connection ? 'Loading ManaSync connection…' : connection.connected ? `Reports go to ${connection.username} (${connection.accountId}).` : 'ManaSync is disconnected. Prepared batches wait in CLC until the connection is restored.'}</p>
    <div className="mana-sync-actions"><label>Physical destination <select value={destination} onChange={e => setDestination(e.target.value)} disabled={!connection?.connected || busy}>
      <option value="">Unassigned</option>{locations.filter(v => v.kind !== 'unassigned').map(v => <option key={v.id} value={v.id}>{v.name} ({v.kind})</option>)}</select></label>
      <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => act(() => refresh(true))}>Refresh queue</button></div>
    {error && <p role="alert">{error} If a response was lost, retry the same action to recover its saved operation.</p>}
    {!items.length && <p>{printJobId ? 'No confirmation items loaded for this batch. Refresh the queue to try again.' : 'Use a card’s Queue button above to plan a later inventory confirmation. Generate PDFs and manage Mac print batches in the Printing tab.'}</p>}
    {items.map(item => <div className="mana-sync-print-item" key={item.id}>
      <strong>{item.card.name}</strong> · {item.confirmed} confirmed of {item.quantity} queued{item.cancelled ? ' · remaining prints cancelled' : ''}
      {item.pendingProxy && item.pendingProxy.status !== 'legacy' && <div role="status">
        <p>{item.pendingProxy.dismissedQuantity > 0 && `${item.pendingProxy.dismissedQuantity} dismissed · `}{item.pendingProxy.remainingQuantity > 0 ? `${item.pendingProxy.remainingQuantity} awaiting quantity confirmation` : 'Quantity confirmation complete'}</p>
        {item.pendingProxy.status === 'publishing' && <p>Sending this batch and its artwork to ManaSync&rsquo;s Pending prints…</p>}
        {item.pendingProxy.status === 'disconnected' && <p>Connect ManaSync to publish and confirm this pending batch.</p>}
        {item.pendingProxy.actionPending && <p>Your saved decision is awaiting a response. Refresh to check its result.</p>}
        {item.pendingProxy.error && <p>{item.pendingProxy.error}</p>}
        {item.pendingProxy.confirmations.filter(value => !item.operations.some(operation => operation.id === value.operationId)).map(value => <p key={value.operationId}>{value.quantity} usable {value.quantity === 1 ? 'copy' : 'copies'} confirmed in ManaSync</p>)}
      </div>}
      {item.printJobId && <p>From print batch {item.printJobId.slice(0, 8)} · {item.artwork?.front ? 'Actual proxy artwork attached' : 'Artwork unavailable'}</p>}
      {item.artwork?.front && <PrintQueueArtwork item={item} />}
      {item.remaining > 0 && <div className="mana-sync-actions">
        <label>Actually printed <input type="number" min="1" max={item.remaining} value={quantities[item.id] ?? item.remaining} onChange={e => setQuantities(previous => ({...previous,[item.id]:e.target.value}))} disabled={busy} /></label>
        <button className="btn btn-primary btn-sm" type="button" disabled={busy || (item.pendingProxy && item.pendingProxy.status !== 'legacy' && (!connection?.connected || !['pending','partial'].includes(item.pendingProxy.status) || item.pendingProxy.actionPending)) || !Number.isInteger(Number(quantities[item.id] ?? item.remaining)) || Number(quantities[item.id] ?? item.remaining) < 1 || Number(quantities[item.id] ?? item.remaining) > item.remaining} onClick={() => act(() => confirm(item))}>Confirm printed quantity</button>
        <button className="btn btn-secondary btn-sm" type="button" disabled={busy || item.pendingProxy?.actionPending} onClick={() => act(() => cancelPrintItem(item.id))}>{item.pendingProxy && item.pendingProxy.status !== 'legacy' ? 'Dismiss remaining' : 'Cancel remaining'}</button></div>}
      {item.operations.map(operation => <div className="mana-sync-operation" key={operation.id}>
        <span>{operation.kind === 'acquire' ? `${operation.quantity} usable copies` : operation.kind === 'dismiss' ? 'Dismiss remaining copies' : `${operation.kind} correction`} · <strong>{operation.status === 'local' ? 'Saved in CLC' : operation.status}</strong>{operation.attempts >= 6 && operation.status === 'pending' ? ' · automatic retry limit reached' : ''}</span>
        <small>Operation {operation.id}{operation.lotId ? ` · holding ${operation.lotId}` : ''}</small>
        {operation.error && <p>{operation.error}</p>}
        <div className="mana-sync-actions">
          {operation.status === 'local' && connection?.connected && <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => act(() => bindPrintReport(operation.id,destination,expectedConnection(connection)))}>Report to {connection.username}</button>}
          {['pending','reconnect','review'].includes(operation.status) && <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => act(() => retryPrintReport(operation.id))}>Retry original operation</button>}
          {operation.status !== 'local' && <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => act(() => inspect(operation))}>{operation.kind === 'dismiss' ? 'Inspect decision receipt' : 'Inspect receipt and holding'}</button>}
        </div>
      </div>)}
    </div>)}
    {inspection && <div className="mana-sync-inspection">
      <h4>{inspection.operation.kind === 'dismiss' ? 'Review dismissal receipt' : 'Review recorded proxy holding'}</h4>
      <p>Operation {inspection.operation.id}: {inspection.operation.status}</p>
      {!inspection.lots.length && <p>{inspection.operation.kind === 'dismiss' ? 'Dismissal closes unproduced copies without creating or removing a holding.' : 'No corresponding holding was found. A holding may have been moved, changed, or deleted. Keep this operation for review; never resubmit an uncertain print through a replacement token.'}</p>}
      {inspection.lots.map(lot => <p key={lot.id}>{lot.card.name}: {lot.quantity} proxies · holding {lot.id} · revision {lot.revision} · location {locations.find(v => v.id === lot.containerId)?.name || lot.containerId}</p>)}
      {inspection.operation.status === 'reported' && inspection.lots.length === 1 && <>
        <label>Reviewed total / quantity to move <input type="number" min="0" value={correction.quantity} onChange={e => setCorrection(previous => ({...previous,quantity:e.target.value}))} /></label>
        <label>Adjustment reason <input value={correction.reason} onChange={e => setCorrection(previous => ({...previous,reason:e.target.value}))} /></label>
        <label>Move destination <select value={correction.containerId} onChange={e => setCorrection(previous => ({...previous,containerId:e.target.value}))}>{locations.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
        <div className="mana-sync-actions"><button type="button" className="btn btn-secondary btn-sm" disabled={busy || !correction.reason.trim()} onClick={() => act(() => correct('adjust'))}>Apply reviewed total</button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || Number(correction.quantity) < 1} onClick={() => act(() => correct('move'))}>Move reviewed quantity</button></div>
        <p>Concurrent changes require another inspection and review. Corrections use new operation IDs.</p>
      </>}
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setInspection(null)}>Close review</button>
    </div>}
  </details>;
}
