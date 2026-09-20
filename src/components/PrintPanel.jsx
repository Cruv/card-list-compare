import { useEffect, useRef, useState } from 'react';
import { previewPrintPlan, createPrintJob, getPrintJobs, getPrintQueue, queuePrintJob, cancelPrintJob, expirePrintArtifacts, downloadPrintArtifact, stagePrintJobConfirmations } from '../lib/api';
import PrintPlanOwnership from './PrintPlanOwnership';
import PrintQueue from './PrintQueue';
import './PrintPanel.css';

const STATES = {
  preparing: 'Preparing PDFs', ready: 'PDFs ready', queued: 'Waiting for the Mac',
  claimed: 'Preparing on the Mac', submitting: 'Submitting to Epson', submitted: 'In the Epson queue',
  awaiting_refeed: 'Waiting for manual flip / reload', completed: 'Spooler completed',
  uncertain: 'Submission needs review on the Mac', failed: 'Failed', canceled: 'Canceled', expired: 'PDFs expired',
};
const CANCELABLE = new Set(['preparing', 'ready', 'queued', 'claimed']);

function ProxyConfirmationStatus({ items }) {
  if (!items.length) return <p className="print-panel-meta">This prepared batch is waiting to appear in ManaSync&rsquo;s Pending prints.</p>;
  const confirmed = items.reduce((sum,item) => sum + item.confirmed,0);
  const dismissed = items.reduce((sum,item) => sum + (item.pendingProxy?.dismissedQuantity || 0),0);
  const remaining = items.reduce((sum,item) => sum + item.remaining,0);
  const error = items.find(item => item.pendingProxy?.error)?.pendingProxy.error;
  return <div className="print-panel-confirmation" role="status">
    <strong>{remaining > 0 ? 'Awaiting quantity confirmation' : 'Quantity confirmation complete'}</strong>
    <p>{confirmed} confirmed · {dismissed} dismissed · {remaining} pending</p>
    {items.some(item => item.pendingProxy?.status === 'disconnected') && <p>Connect ManaSync to send this batch to Pending prints.</p>}
    {error && <p>{error}</p>}
  </div>;
}

function snapshotLabel(snapshot) {
  if (!snapshot) return 'Unknown snapshot';
  const time = snapshot.created_at || snapshot.createdAt;
  const date = time ? new Date(time.endsWith('Z') ? time : `${time}Z`).toLocaleString() : '';
  return `${snapshot.nickname || `Snapshot #${snapshot.id}`} · ${date}`;
}

function requestId() {
  // getRandomValues also works on a household HTTP LAN origin without randomUUID.
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export default function PrintPanel({ deck, snapshots }) {
  const [mode, setMode] = useState(deck.paper_snapshot_id ? 'changes' : 'full');
  const [target, setTarget] = useState('latest');
  const [baseline, setBaseline] = useState(String(deck.paper_snapshot_id || snapshots[1]?.id || ''));
  const [artSource, setArtSource] = useState('scryfall');
  const [includeSideboard, setIncludeSideboard] = useState(false);
  const [replacePrintings, setReplacePrintings] = useState(true);
  const [plan, setPlan] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [confirmationItems, setConfirmationItems] = useState([]);
  const [capabilities, setCapabilities] = useState({});
  const [generator, setGenerator] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingAction, setPendingAction] = useState(null);
  const [recordingJobId, setRecordingJobId] = useState(null);
  const [recordError, setRecordError] = useState(null);
  const stagedJobsRef = useRef(new Set());
  const requestRef = useRef(null);
  const revisionRef = useRef(0);

  useEffect(() => {
    let active = true;
    let timer;
    let pollCount = 0;
    async function poll() {
      try {
        const [data, queue] = await Promise.all([getPrintJobs(deck.id),pollCount++ % 4 === 0 ? getPrintQueue(deck.id) : null]);
        if (!active) return;
        setJobs(data.jobs);
        if (queue) setConfirmationItems(queue.items);
        setCapabilities(data.capabilities);
        setGenerator(data.generator);
        setConnectionError('');
      } catch (err) {
        if (active) setConnectionError(err.message);
      } finally {
        if (active) timer = setTimeout(poll, 4000);
      }
    }
    poll();
    return () => { active = false; clearTimeout(timer); };
  }, [deck.id]);

  function change(setter, value) {
    revisionRef.current += 1;
    setter(value);
    setPlan(null);
    setError('');
    setNotice('');
    requestRef.current = null;
    setPendingAction(null);
  }

  async function preview(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    setPlan(null);
    const revision = revisionRef.current;
    try {
      const data = await previewPrintPlan(deck.id, {
        mode, targetSnapshotId: target === 'latest' ? undefined : Number(target),
        baselineSnapshotId: mode === 'changes' ? Number(baseline) : undefined,
        artSource, includeSideboard, replacePrintings,
      });
      if (revision !== revisionRef.current) return;
      setPlan(data.plan);
      setCapabilities(data.capabilities);
      setGenerator(data.generator);
      requestRef.current = null;
      setPendingAction(null);
    } catch (err) {
      if (revision === revisionRef.current) setError(err.message);
    } finally { setBusy(false); }
  }

  async function generate(queueOnReady) {
    setBusy(true);
    setError('');
    try {
      // Keep the same key after an ambiguous network response; a retry is the same job.
      if (!requestRef.current) {
        requestRef.current = {
          mode, targetSnapshotId: plan.target.id, baselineSnapshotId: plan.source?.id,
          artSource, includeSideboard, replacePrintings, expectedPlanHash: plan.planHash,
          queueOnReady, idempotencyKey: requestId(),
        };
        setPendingAction(queueOnReady);
      }
      const data = await createPrintJob(deck.id, requestRef.current);
      setJobs(old => [data.job, ...old.filter(job => job.id !== data.job.id)]);
      setPlan(null);
      requestRef.current = null;
      setPendingAction(null);
      setNotice(queueOnReady ? 'Batch created. The Mac will pick it up when its PDFs are ready.' : 'Batch created. Your PDFs will appear below.');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function jobAction(action, job) {
    setBusy(true);
    setError('');
    try {
      const result = await action(deck.id, job.id);
      setJobs(old => old.map(item => item.id === job.id ? result.job : item));
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function download(artifact, job) {
    setError('');
    try {
      await downloadPrintArtifact(artifact.downloadUrl, `${deck.deck_name}-${job.id.slice(0, 8)}-${artifact.id}.pdf`);
    } catch (err) { setError(err.message); }
  }

  async function downloadManifest(job) {
    try {
      await downloadPrintArtifact(`/api/decks/${deck.id}/print-jobs/${job.id}/manifest`, `clc-${job.id}-manifest.json`);
    } catch (err) { setError(err.message); }
  }

  async function recordPrintedProxies(job) {
    if (busy) return;
    setBusy(true);
    setRecordError(null);
    try {
      // Staging is idempotent for the batch; confirming physical quantities is separate.
      if (!stagedJobsRef.current.has(job.id)) {
        await stagePrintJobConfirmations(job.id);
        stagedJobsRef.current.add(job.id);
      }
      setRecordingJobId(job.id);
    } catch (err) { setRecordError({ jobId: job.id, message: err.message }); }
    finally { setBusy(false); }
  }

  return (
    <div className="print-panel">
      <form className="print-panel-card" onSubmit={preview}>
        <h3>Prepare cards for your next game</h3>
        <p>Print a whole snapshot or just the copies needed since another version. Double-faced cards get a separate PDF for manual flip and reload.</p>
        <div className="print-panel-fields">
          <label>What to print
            <select value={mode} disabled={busy} onChange={e => change(setMode, e.target.value)}>
              <option value="full">Whole snapshot</option><option value="changes">Changes between snapshots</option>
            </select>
          </label>
          <label>Target version
            <select value={target} disabled={busy} onChange={e => change(setTarget, e.target.value)}>
              <option value="latest">Latest snapshot</option>
              {snapshots.map(s => <option key={s.id} value={s.id}>{snapshotLabel(s)}</option>)}
            </select>
          </label>
          {mode === 'changes' && <label>Compare from
            <select value={baseline} disabled={busy} onChange={e => change(setBaseline, e.target.value)} required>
              <option value="">Choose an earlier version</option>
              {snapshots.map(s => <option key={s.id} value={s.id}>{snapshotLabel(s)}{s.id === deck.paper_snapshot_id ? ' · Paper deck' : ''}</option>)}
            </select>
          </label>}
          <label>Artwork
            <select value={artSource} disabled={busy} onChange={e => change(setArtSource, e.target.value)}>
              <option value="scryfall">Scryfall — snapshot printings</option>
              <option value="saved-mpc">Saved MPC artwork</option>
            </select>
          </label>
        </div>
        <label className="print-panel-check"><input type="checkbox" checked={includeSideboard} disabled={busy} onChange={e => change(setIncludeSideboard, e.target.checked)} />Include sideboard</label>
        {mode === 'changes' && <label className="print-panel-check"><input type="checkbox" checked={replacePrintings} disabled={busy} onChange={e => change(setReplacePrintings, e.target.checked)} />Replace copies when the set or printing changes</label>}
        <p className="print-panel-meta">Review the print list to check ManaSync ownership and shop for missing originals in Mana Pool. When the PDFs are ready, the batch and its artwork appear in ManaSync&rsquo;s Proxy binder under Pending prints. After printing, confirm usable copies in either app or dismiss failed copies. Foil-only changes do not need a new proxy.</p>
        {artSource === 'saved-mpc' && <p className="print-panel-meta">Save your selections in Proxy Printing first. Every required face must have saved art; missing choices stop the batch.</p>}
        <button className="btn btn-primary" type="submit" disabled={busy || !snapshots.length || (mode === 'changes' && !baseline)}>{busy ? 'Working…' : 'Review print list'}</button>
      </form>

      {error && <div className="print-panel-error" role="alert">{error}</div>}
      {connectionError && <p role="status">Print status could not refresh: {connectionError}</p>}
      {notice && <p role="status">{notice}</p>}

      {plan && <section className="print-panel-card" aria-label="Print list review">
        <h3>{plan.totalCopies} {plan.totalCopies === 1 ? 'card' : 'cards'} to prepare</h3>
        <p>{plan.source ? `Snapshot #${plan.source.id} → ` : ''}Snapshot #{plan.target.id}{plan.includeSideboard ? ' · Mainboard and sideboard' : ' · Mainboard'}</p>
        <p className="print-panel-meta">Letter · v6 · 600 PPI · 1 mm crop · 7 cards per sheet. Sheet counts appear after artwork and both faces have been verified.</p>
        <ul className="print-panel-cards">{plan.cards.map((card, index) => <li key={index}>{card.quantity}× {card.displayName}{card.setCode ? ` (${card.setCode}) ${card.collectorNumber || ''}` : ''}</li>)}</ul>
        {plan.totalCopies > 0 && <PrintPlanOwnership key={plan.planHash} plan={plan} />}
        {plan.missingArtwork?.length > 0 && <div className="print-panel-error" role="alert">Save artwork for these cards before generating:{'\n'}{plan.missingArtwork.map(card => `${card.quantity}× ${card.displayName} (${card.face})`).join('\n')}</div>}
        {plan.totalCopies === 0 ? <p>There are no new copies to print for these options.</p> : <div className="print-panel-actions">
          <button className="btn btn-primary" disabled={busy || !generator?.available || !!plan.missingArtwork?.length || pendingAction === true} onClick={() => generate(false)} type="button">Generate PDFs</button>
          {capabilities.canQueue && <button className="btn btn-secondary" disabled={busy || !generator?.available || !!plan.missingArtwork?.length || pendingAction === false} onClick={() => generate(true)} type="button">Generate and send to Mac</button>}
        </div>}
      </section>}

      <section className="print-panel-card" aria-label="PDF generator status">
        <h4>{generator?.available ? 'PDF generator ready' : generator?.updating ? 'Preparing the PDF generator…' : 'PDF generator unavailable'}</h4>
        <p className="print-panel-meta">{generator?.available ? `Silhouette Card Maker ${generator.revision?.slice(0, 8)} · household v6 recipe` : 'CLC needs a working Silhouette Card Maker installation in its data folder. Check the server setup or restart to retry the update.'}</p>
        {generator?.fallbackReason && <p className="print-panel-meta">{generator.fallbackReason}</p>}
        {!capabilities.stationConfigured && <p className="print-panel-meta">PDF downloads work without a printer. Configure the Mac companion to enable the household queue.</p>}
        {capabilities.stationConfigured && !capabilities.canQueue && <p className="print-panel-meta">Your administrator can enable household queue access for your account. You can still download PDFs.</p>}
        <p><a href="#print-station">Open Print Station</a> to check the Mac, pause new work, or resume a reloaded batch.</p>
      </section>

      <section className="print-panel-jobs" aria-label="Print batches">
        <h3>Print batches</h3>
        {jobs.length === 0 && <p>Your prepared batches will appear here, with PDFs and print status.</p>}
        {jobs.map(job => <article className="print-panel-card" key={job.id}>
          <div className="print-panel-heading"><h4>{job.totalCopies} cards · {job.mode === 'changes' ? 'Changes' : 'Whole snapshot'}</h4><span className="print-panel-status">{STATES[job.state] || job.state}</span></div>
          <p className="print-panel-meta">Batch {job.id.slice(0, 8)} · {new Date(job.createdAt).toLocaleString()}</p>
          <p className="print-panel-meta">{job.source ? `Snapshot #${job.source.id} → ` : ''}Snapshot #{job.target?.id} · {job.artSource === 'saved-mpc' ? 'Saved MPC artwork' : 'Scryfall printings'}{job.progress?.totalSheets ? ` · ${job.progress.completedSheets || 0}/${job.progress.totalSheets} sheets generated` : ''}</p>
          {job.error && <div className="print-panel-error" role="alert">{job.error}</div>}
          {job.proxyStagingError && <p className="print-panel-error" role="alert">Pending proxy review: {job.proxyStagingError}</p>}
          {job.state === 'awaiting_refeed' && <p>Flip and reload this batch at the rear feeder, then confirm the matching batch in <a href="#print-station">Print Station</a>. Other CLC batches wait until this batch is finished.</p>}
          {job.state === 'uncertain' && <p>The Mac needs to reconcile this batch with Epson’s queue. Check the companion before creating another batch.</p>}
          {job.state === 'completed' && <p className="print-panel-meta">The spooler reports completion. Check the sheets before laminating; update your paper-deck marker after assembly.</p>}
          <div className="print-panel-actions">
            {(job.artifacts || []).filter(a => a.downloadUrl).map(artifact => <button className="btn btn-secondary btn-sm" type="button" key={artifact.id} onClick={() => download(artifact, job)}>Download {artifact.id === 'fronts' ? 'fronts' : 'double-faced'} PDF{artifact.pageCount ? ` · ${artifact.pageCount} ${artifact.pageCount === 1 ? 'page' : 'pages'}` : ''}</button>)}
            {job.state === 'ready' && capabilities.canQueue && <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => jobAction(queuePrintJob, job)}>Send to Mac</button>}
            {CANCELABLE.has(job.state) && <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => jobAction(cancelPrintJob, job)}>Cancel batch</button>}
            {job.manifestSha256 && <button className="btn btn-secondary btn-sm" type="button" onClick={() => downloadManifest(job)}>Download batch details</button>}
            {job.manifestSha256 && <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => recordPrintedProxies(job)}>View proxy confirmation</button>}
            {['ready', 'completed', 'failed', 'canceled'].includes(job.state) && job.artifacts?.length > 0 && <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => jobAction(expirePrintArtifacts, job)}>Remove PDFs</button>}
          </div>
          {job.manifestSha256 && <ProxyConfirmationStatus items={confirmationItems.filter(item => item.printJobId === job.id)} />}
          {recordError?.jobId === job.id && <p className="print-panel-error" role="alert">{recordError.message}</p>}
          {recordingJobId === job.id && <section className="mana-sync" aria-label={`Printed proxies for batch ${job.id}`}>
            <p>This is the same pending batch shown in ManaSync&rsquo;s Proxy binder. A quantity confirmed or dismissed in either app updates both. Its saved artwork stays attached to the copies you keep.</p>
            <PrintQueue key={job.id} deckId={deck.id} printJobId={job.id} />
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => setRecordingJobId(null)}>Close proxy confirmation</button>
          </section>}
          {job.state === 'ready' && <p className="print-panel-meta">PDFs are kept for seven days. Removing PDFs keeps the batch record; create a new batch to generate them again.</p>}
        </article>)}
      </section>
    </div>
  );
}
