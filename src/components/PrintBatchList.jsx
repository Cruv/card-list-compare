import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { cancelHouseholdPrintJob, cancelPrintJobBacks, getPrintBatches } from '../lib/api';
import ConfirmModal from './ConfirmModal';
import Icon from './Icon';
import './PrintBatchList.css';

const STATES = {
  preparing: 'Generating PDFs', ready: 'PDFs ready', queued: 'Waiting in CLC',
  claimed: 'Preparing on the Mac', submitting: 'Submitting to Epson',
  submitted: 'In the Epson queue', awaiting_refeed: 'Flip and reload needed',
  backs_pending: 'Fronts printed · backs saved', awaiting_paper_reset: 'Backs printed · restore blank paper',
  awaiting_clearance: 'Canceled pages · clear paper',
  uncertain: 'Needs review at the Mac', completed: 'Spooler completed',
  failed: 'Failed', canceled: 'Canceled', expired: 'PDFs expired',
};
const ATTENTION = new Set(['awaiting_refeed', 'awaiting_paper_reset', 'awaiting_clearance', 'uncertain', 'failed']);

function timestamp(value) {
  const normalized = typeof value === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const date = value ? new Date(normalized) : null;
  return !date || Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleString();
}

function queueDetail(job) {
  if (job.state === 'canceled' && job.frontsCompleted && job.backsCanceled > 0) return 'Fronts printed; remaining backs were canceled';
  if (job.state === 'preparing') return job.queueOnReady ? 'Will join the print queue when ready' : 'PDF generation only';
  if (job.state === 'ready') return job.queueOnReady ? 'Saved in CLC; waiting to be queued' : 'Saved PDFs; not queued for printing';
  if (job.state === 'queued') return 'Saved in CLC; not sent to Epson';
  if (job.state === 'claimed') return 'The Mac has taken this batch';
  if (job.state === 'awaiting_refeed') return 'Match the packet at the printer before resuming';
  if (job.state === 'backs_pending') return 'Saved backs can be printed later; other front jobs continue';
  if (job.state === 'awaiting_paper_reset') return 'Remove the printed sheet and confirm only blank paper is loaded';
  if (job.state === 'awaiting_clearance') return 'Clear canceled-job paper at the printer before continuing';
  if (job.state === 'completed') return 'The print spooler reported completion';
  return null;
}

function BatchRow({ job, scope, fresh, busy, onCancel }) {
  const detail = queueDetail(job);
  const href = job.canOpen ? (job.deckId == null
    ? `#print-list?batch=${encodeURIComponent(job.id)}`
    : Number.isSafeInteger(job.deckId) && job.deckId > 0 ? `#library/${job.deckId}?printBatch=${encodeURIComponent(job.id)}` : null) : null;
  return <li className="batch-list-row">
    <div className="batch-list-identity">
      <strong>{job.deckName || 'Card batch'}</strong>
      <p>{job.totalCopies} {job.totalCopies === 1 ? 'copy' : 'copies'} · {job.sourceKind === 'deck' ? 'Deck' : 'Print list'}{scope === 'all' && job.requesterName ? ` · ${job.requesterName}` : ''}</p>
      <time dateTime={job.createdAt}>{timestamp(job.createdAt)}</time>
      <details className="batch-list-details"><summary>Batch ID</summary><code>{job.id}</code></details>
    </div>
    <div className="batch-list-status">
      <span className={`batch-list-badge${ATTENTION.has(job.state) ? ' batch-list-badge--attention' : ''}${job.state === 'completed' ? ' batch-list-badge--done' : ''}`}>{job.state === 'canceled' && job.frontsCompleted && job.backsCanceled > 0 ? 'Finished · backs canceled' : STATES[job.state] || 'Status unavailable'}</span>
      {detail && <p>{detail}</p>}
      {job.cancelRequested && <p>Cancellation requested · waiting for the Mac</p>}
      {job.progress && Number.isFinite(job.progress.completed) && Number.isFinite(job.progress.total) && job.progress.total > 0 && job.state === 'preparing' && <p>{job.progress.completed} of {job.progress.total} prepared</p>}
      {job.error && <p className="batch-list-error-detail">{job.error}</p>}
    </div>
    <div className="batch-list-actions">
      {href && <a className="btn btn-secondary btn-sm" href={href}>View batch</a>}
      {job.canCancel && <button type="button" className="batch-list-cancel" disabled={!fresh || busy || !!job.cancelRequested} onClick={event => { event.currentTarget.focus(); onCancel(job); }}>Cancel batch</button>}
      {job.canCancelBacks && <button type="button" className="batch-list-cancel" disabled={!fresh || busy || !!job.cancelRequested} onClick={event => { event.currentTarget.focus(); onCancel(job, 'backs'); }}>Cancel only backs</button>}
    </div>
  </li>;
}

function BatchHistory({ state, order, onBusyChange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fetchedAt, setFetchedAt] = useState(0);
  const [cancelBatch, setCancelBatch] = useState(null);
  const [canceling, setCanceling] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const pagesRef = useRef(1);
  const refreshRef = useRef(() => {});
  const mountedRef = useRef(false);
  const mutationRef = useRef(false);
  const modalRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    let controller;
    let generation = 0;
    let running = false;
    async function refresh(more = false) {
      if (mutationRef.current) return;
      const request = ++generation;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      running = true;
      setLoading(true);
      const targetPages = pagesRef.current + (more ? 1 : 0);
      try {
        const seen = new Set();
        const jobs = [];
        let cursor;
        let response;
        let loadedPages = 0;
        do {
          response = await getPrintBatches({ state, order, cursor }, signal);
          if (!Array.isArray(response.jobs) || !['all', 'mine'].includes(response.scope) || !Number.isInteger(response.totalCount) || (response.nextCursor !== null && typeof response.nextCursor !== 'string')) throw new Error('The batch history response was incomplete. Try refreshing.');
          for (const job of response.jobs) if (!seen.has(job.id)) { seen.add(job.id); jobs.push(job); }
          cursor = response.nextCursor;
          loadedPages += 1;
        } while (cursor && loadedPages < targetPages);
        if (!mountedRef.current || generation !== request) return;
        pagesRef.current = loadedPages;
        setData({ ...response, jobs });
        setFetchedAt(Date.now()); setError('');
      } catch (failure) {
        if (mountedRef.current && generation === request && !signal.aborted) {
          setError(failure.message || 'Batch history could not be loaded.');
          setFetchedAt(0);
        }
      } finally {
        if (mountedRef.current && generation === request) { running = false; setLoading(false); }
      }
    }
    refreshRef.current = refresh;
    refresh();
    const poll = () => { if (!document.hidden && !running && !mutationRef.current && !modalRef.current) refresh(); };
    const timer = setInterval(poll, 30_000);
    document.addEventListener('visibilitychange', poll);
    window.addEventListener('online', poll);
    return () => { mountedRef.current = false; generation += 1; controller?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', poll); window.removeEventListener('online', poll); };
  }, [state, order]);

  function chooseCancel(job, mode = 'all') { const selected = { job, mode }; modalRef.current = selected; setCancelBatch(selected); }
  function dismissCancel() { modalRef.current = null; setCancelBatch(null); }
  async function cancel() {
    const selected = modalRef.current;
    if (!selected || mutationRef.current) return;
    const { job, mode } = selected;
    dismissCancel();
    if (loading || error || !fetchedAt || Date.now() - fetchedAt > 60_000 || !(mode === 'backs' ? job.canCancelBacks : job.canCancel)) {
      setActionError('Refresh the batch list before canceling this batch.'); return;
    }
    mutationRef.current = true; setCanceling(true); onBusyChange(true);
    setActionError(''); setNotice('');
    try {
      await (mode === 'backs' ? cancelPrintJobBacks(job.id) : cancelHouseholdPrintJob(job.id));
      if (mountedRef.current) setNotice(`Cancellation requested for ${mode === 'backs' ? 'the remaining backs of ' : ''}${job.deckName || 'Card batch'} · batch ${job.id}. Check the updated status. If pages were submitted, wait for the Mac to stop them and follow the paper-clearance instructions above.`);
    } catch (failure) {
      if (mountedRef.current) setActionError(`Cancellation could not be confirmed for ${job.deckName || 'Card batch'} (batch ${job.id}). ${failure.message} Check its refreshed status before retrying this same batch.`);
    } finally {
      mutationRef.current = false;
      if (mountedRef.current) { setCanceling(false); onBusyChange(false); refreshRef.current(); }
    }
  }

  const fresh = !loading && !error && !!fetchedAt;
  return <>
    <div className="batch-list-summary">
      <p aria-live="polite">{data ? `${data.scope === 'all' ? 'Household batches' : 'Your batches'} · Showing ${data.jobs.length} of ${data.totalCount}${state !== 'all' ? ` · ${STATES[state]}` : ''}` : 'Loading batch history…'}</p>
      <button className="btn btn-secondary btn-sm" type="button" disabled={loading || canceling} onClick={() => refreshRef.current()}><Icon name="refresh" size={16} />{loading ? 'Refreshing…' : 'Refresh batches'}</button>
    </div>
    {error && <p className="batch-list-message batch-list-message--error" role="alert">{data ? 'Showing the last loaded batches; their status may have changed. ' : ''}{error}</p>}
    {actionError && <p className="batch-list-message batch-list-message--error" role="alert">{actionError}</p>}
    {notice && <p className="batch-list-message" role="status">{notice}</p>}
    {data && data.jobs.length > 0 && <ol className="batch-list-rows" aria-label={data.scope === 'all' ? 'Household print batches' : 'Your print batches'} aria-busy={loading}>{data.jobs.map(job => <BatchRow key={job.id} job={job} scope={data.scope} fresh={fresh} busy={canceling} onCancel={chooseCancel} />)}</ol>}
    {data && !data.jobs.length && <div className="batch-list-empty"><Icon name="print" size={28} /><p>{state === 'all' ? 'No saved print batches yet.' : `No batches with status “${STATES[state]}”.`}</p><a href="#print-list">Create a print list</a></div>}
    {data?.nextCursor && <button className="btn btn-secondary batch-list-more" type="button" disabled={loading || canceling} onClick={() => refreshRef.current(true)}>{loading ? 'Loading…' : 'Load more batches'}</button>}
    {fetchedAt > 0 && <p className="batch-list-updated">Updated {timestamp(fetchedAt)} · Refreshes every 30 seconds while this page is visible.</p>}
    {cancelBatch && <ConfirmModal title={cancelBatch.mode === 'backs' ? 'Cancel remaining backs?' : 'Cancel this batch?'} message={`${cancelBatch.job.deckName || 'Card batch'} · ${cancelBatch.job.totalCopies} copies. Batch ${cancelBatch.job.id}. ${cancelBatch.mode === 'backs' ? 'Keep the fronts and stop every unfinished back pass.' : 'Stop its remaining fronts and backs.'} This does not undo paper already printed. If an affected pass is active, the Mac must stop that exact submission and you must clear its paper before other jobs continue.`} confirmLabel={cancelBatch.mode === 'backs' ? 'Cancel remaining backs' : 'Cancel this batch'} cancelLabel="Keep printing" danger onConfirm={cancel} onCancel={dismissCancel} />}
  </>;
}

export default function PrintBatchList() {
  const { user } = useAuth();
  const [state, setState] = useState('all');
  const [order, setOrder] = useState('queue');
  const [busy, setBusy] = useState(false);
  return <section className="print-batch-list" aria-labelledby="print-batch-list-title">
    <div className="batch-list-heading"><div><h2 id="print-batch-list-title">Print batches</h2><p>Decks and independent lists, from saved PDFs to completed print jobs.</p></div><a className="btn btn-secondary" href="#print-list"><Icon name="plus" size={16} />New print list</a></div>
    <div className="batch-list-filters">
      <label>Status<select aria-label="Batch status" value={state} disabled={busy} onChange={event => setState(event.target.value)}><option value="all">All statuses</option>{Object.entries(STATES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Order<select aria-label="Batch order" value={order} disabled={busy} onChange={event => setOrder(event.target.value)}><option value="queue">Printer order</option><option value="newest">Newest first</option></select></label>
      <p>{order === 'queue' ? 'Active batches first, then waiting batches in CLC queue order. Ready PDFs and history follow.' : 'Most recently created batches first.'} {state === 'all' && 'You can create another print list while other batches are waiting.'}</p>
    </div>
    <BatchHistory key={`${user.id}:${state}:${order}`} state={state} order={order} onBusyChange={setBusy} />
  </section>;
}
