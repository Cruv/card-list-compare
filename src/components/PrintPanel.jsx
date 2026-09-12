import { useEffect, useMemo, useRef, useState } from 'react';
import { previewPrintPlan, createPrintJob, getPrintJobs, getPrintJob, getPrintQueue, getPrintStationStatus, queuePrintJob, cancelPrintJob, expirePrintArtifacts, downloadPrintArtifact, stagePrintJobConfirmations,
  getStandalonePrintJobs, getStandalonePrintJob, previewStandalonePrintJob, createStandalonePrintJob, queueStandalonePrintJob, cancelStandalonePrintJob, expireStandalonePrintArtifacts } from '../lib/api';
import DeckInput from './DeckInput';
import PrintArtPicker from './PrintArtPicker';
import PrintListReview from './PrintListReview';
import PrintQueue from './PrintQueue';
import { loadPrintCreationIntent, loadStandalonePrintDraft, saveStandaloneDraftReplacement, printReviewReady, printReviewSummary, printCopyBreakdown, printSourceCopies, canCancelReviewedPrintJob, rejectedPrintCreation } from '../lib/printReview';
import { useAuth } from '../context/AuthContext';
import './PrintPanel.css';

const STATES = {
  preparing: 'Preparing PDFs', ready: 'PDFs ready', queued: 'Waiting for the Mac',
  claimed: 'Preparing on the Mac', submitting: 'Submitting to Epson', submitted: 'In the Epson queue',
  awaiting_refeed: 'Waiting for manual flip / reload', completed: 'Spooler completed',
  backs_pending: 'Fronts printed · backs saved', awaiting_paper_reset: 'Backs printed · restore blank paper',
  awaiting_clearance: 'Canceled pages · clear paper',
  uncertain: 'Submission needs review on the Mac', failed: 'Failed', canceled: 'Canceled', expired: 'PDFs expired',
};

function artifactName(artifact) {
  if (artifact.kind === 'ordinary') return 'ordinary fronts';
  return artifact.packetIndex && artifact.packetCount
    ? `double-faced packet ${artifact.packetIndex} of ${artifact.packetCount}` : 'legacy double-faced stack';
}

function WaitingPrintPacket({ job }) {
  if (job.state === 'backs_pending') return <section className="print-panel-confirmation" aria-label="Backs saved for later"><strong>Fronts are printed. Backs are saved for later.</strong><p>Other front jobs can continue. Keep the labeled double-sided sheets, then choose their matching packets in <a href="#print-station">Printer → Backs for later</a> whenever you are ready. Select a packet before reloading paper.</p></section>;
  if (['awaiting_clearance', 'awaiting_paper_reset'].includes(job.state)) return <section className="print-panel-confirmation"><strong>{job.state === 'awaiting_clearance' ? 'Canceled-job paper needs clearing' : 'Backs finished — restore blank paper'}</strong><p>Remove printed or flipped paper, leave only blank paper in the rear feeder and confirm in <a href="#print-station">Printer</a> before other front jobs continue.</p></section>;
  if (job.state !== 'awaiting_refeed') return null;
  const next = job.steps?.find(step => step.artifactId === job.backRequest?.artifactId && step.phase === 'backs') || job.steps?.find(step => step.state === 'awaiting_refeed');
  const artifact = job.artifacts?.find(item => item.id === next?.artifactId);
  return <section className="print-panel-confirmation" aria-label="Waiting for paper reload">
    <strong>{artifact ? `Flip and reload ${artifactName(artifact)}` : 'Paper reload is waiting'}</strong>
    {artifact?.label && <p>Match the printed margin label: <strong>{artifact.label}</strong></p>}
    <p>{artifact?.sheetCount ? `${artifact.sheetCount} ${artifact.sheetCount === 1 ? 'sheet' : 'sheets'}. ` : ''}Set aside the other completed output and remove unused blank paper from the rear feeder. Reload only the paper for this packet, following the verified flip direction and page order. Return blank paper after its backs finish. {artifact && !artifact.label && 'Match this older stack against its downloaded double-faced PDF. '}
      Confirm this exact selected packet in <a href="#print-station">Printer</a>. Other jobs wait only while this packet is selected and its paper is being handled.</p>
  </section>;
}

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

export default function PrintPanel({ deck, snapshots = [], standalone = false, initialComparison, onComparisonConsumed, initialJobId }) {
  const { user } = useAuth();
  const deckId = deck?.id;
  const requestStorageKey = `clc-print-job-request:${user.id}:${standalone ? 'adhoc' : deckId}`;
  const draftStorageKey = `clc-print-list-draft:${user.id}`;
  const [storedRequest] = useState(() => loadPrintCreationIntent(localStorage, requestStorageKey));
  const [storedDraft] = useState(() => standalone ? loadStandalonePrintDraft(localStorage, draftStorageKey) : null);
  const [autoComparison] = useState(() => standalone && initialComparison && !storedRequest && !storedDraft?.cardText?.trim() && !storedDraft?.additionalCardText?.trim() ? initialComparison : null);
  const [handledComparisonId, setHandledComparisonId] = useState(autoComparison?.id ?? null);
  const [comparison, setComparison] = useState(storedRequest ? storedRequest.comparison ?? null : autoComparison?.comparison ?? storedDraft?.comparison ?? null);
  const [listName, setListName] = useState(storedRequest?.listName ?? autoComparison?.listName ?? storedDraft?.listName ?? '');
  const [cardText, setCardText] = useState(storedRequest?.cardText ?? autoComparison?.cardText ?? storedDraft?.cardText ?? '');
  const recoveryStorageKey = `clc-print-list-previous-draft:${user.id}`;
  const [previousDraft, setPreviousDraft] = useState(() => standalone ? loadStandalonePrintDraft(localStorage, recoveryStorageKey) : null);
  const [draftError, setDraftError] = useState('');
  const [mode, setMode] = useState(standalone ? 'adhoc' : deck.paper_snapshot_id ? 'changes' : 'full');
  const [target, setTarget] = useState('latest');
  const [baseline, setBaseline] = useState(String(deck?.paper_snapshot_id || snapshots[1]?.id || ''));
  const [artSource, setArtSource] = useState('scryfall');
  const [includeSideboard, setIncludeSideboard] = useState(standalone ? storedRequest?.includeSideboard ?? storedDraft?.includeSideboard ?? false : false);
  const [replacePrintings, setReplacePrintings] = useState(storedRequest?.replacePrintings ?? storedDraft?.replacePrintings ?? false);
  const [excludeBasicLands, setExcludeBasicLands] = useState(storedRequest ? storedRequest.excludeBasicLands ?? false : storedDraft?.excludeBasicLands ?? true);
  const [additionalCardText, setAdditionalCardText] = useState(storedRequest?.additionalCardText ?? storedDraft?.additionalCardText ?? '');
  const [excludedCards, setExcludedCards] = useState(storedRequest?.excludedCards ?? storedDraft?.excludedCards ?? []);
  const [removedCards, setRemovedCards] = useState(storedDraft?.removedCards ?? []);
  const [printingOverrides, setPrintingOverrides] = useState(storedRequest?.printingOverrides ?? storedDraft?.printingOverrides ?? []);
  const [selectedArtCard, setSelectedArtCard] = useState(null);
  const [plan, setPlan] = useState(null);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [editingSource, setEditingSource] = useState(true);
  const [activeView, setActiveView] = useState(initialJobId ? 'batches' : 'prepare');
  const [focusedJobId, setFocusedJobId] = useState(initialJobId || null);
  const [jobs, setJobs] = useState([]);
  const [confirmationItems, setConfirmationItems] = useState([]);
  const [capabilities, setCapabilities] = useState({});
  const [generator, setGenerator] = useState(null);
  const [station, setStation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingRequest, setPendingRequest] = useState(storedRequest);
  const [recordingJobId, setRecordingJobId] = useState(null);
  const [recordError, setRecordError] = useState(null);
  const stagedJobsRef = useRef(new Set());
  const requestRef = useRef(storedRequest);
  const revisionRef = useRef(0);
  const creationPending = !!pendingRequest;
  const pendingAction = pendingRequest?.queueOnReady ?? null;
  const summary = printReviewSummary(plan);
  const sourceCopies = useMemo(() => standalone && plan ? printSourceCopies(cardText, plan.includeSideboard) : undefined, [standalone, plan, cardText]);
  const copyCounts = printCopyBreakdown(plan, sourceCopies);
  const incomingComparison = initialComparison && initialComparison.id !== handledComparisonId ? initialComparison : null;
  const activeJobs = jobs.filter(job => !['completed', 'canceled', 'failed', 'expired'].includes(job.state));
  const prominentJob = jobs.find(job => job.id === focusedJobId) || activeJobs[0] || (!editingSource && !plan ? jobs[0] : null);
  const historyJobs = jobs.filter(job => job.id !== prominentJob?.id);
  const autoConsumedRef = useRef(false);

  useEffect(() => {
    if (!initialJobId) return;
    setFocusedJobId(initialJobId);
    setActiveView('batches');
  }, [initialJobId]);

  useEffect(() => {
    if (!standalone) return;
    try {
      localStorage.setItem(draftStorageKey, JSON.stringify({ listName, cardText, comparison, replacePrintings, includeSideboard, excludeBasicLands, additionalCardText, excludedCards, removedCards, printingOverrides }));
      setDraftError('');
      if (autoComparison && !autoConsumedRef.current) {
        autoConsumedRef.current = true;
        onComparisonConsumed?.(autoComparison.id);
      }
    } catch { setDraftError('This browser could not save your draft. Keep a copy of your card list before leaving this page.'); }
  }, [standalone, draftStorageKey, listName, cardText, comparison, replacePrintings, includeSideboard, excludeBasicLands, additionalCardText, excludedCards, removedCards, printingOverrides, autoComparison, onComparisonConsumed]);

  function switchDraft(draft, comparisonId) {
    if (requestRef.current || busy) return;
    const current = { listName, cardText, comparison, replacePrintings, includeSideboard, excludeBasicLands, additionalCardText, excludedCards, removedCards, printingOverrides };
    const next = { listName: draft.listName || '', cardText: draft.cardText || '', comparison: draft.comparison || null,
      replacePrintings: draft.replacePrintings ?? false, includeSideboard: draft.includeSideboard ?? false,
      excludeBasicLands: draft.excludeBasicLands ?? true, additionalCardText: draft.additionalCardText || '',
      excludedCards: draft.excludedCards || [], removedCards: draft.removedCards || [], printingOverrides: draft.printingOverrides || [] };
    try { saveStandaloneDraftReplacement(localStorage, draftStorageKey, recoveryStorageKey, current, next); }
    catch { setError('The browser could not save both drafts. Your current draft and compared lists are unchanged. Free browser storage and try again.'); return; }
    setPreviousDraft(current);
    revisionRef.current += 1;
    setListName(draft.listName || ''); setCardText(draft.cardText || ''); setComparison(draft.comparison || null);
    setReplacePrintings(draft.replacePrintings ?? false); setIncludeSideboard(draft.includeSideboard ?? false);
    setExcludeBasicLands(draft.excludeBasicLands ?? true); setAdditionalCardText(draft.additionalCardText || '');
    setExcludedCards(draft.excludedCards || []); setRemovedCards(draft.removedCards || []);
    setPrintingOverrides(draft.printingOverrides || []); setSelectedArtCard(null);
    setPlan(null); setEditingSource(true); setActiveView('prepare'); setFocusedJobId(null); setError(''); setNotice('');
    if (comparisonId) { setHandledComparisonId(comparisonId); onComparisonConsumed?.(comparisonId); }
  }

  useEffect(() => {
    let active = true;
    let timer;
    let pollCount = 0;
    async function poll() {
      try {
        const [data, queue] = await Promise.all([standalone ? getStandalonePrintJobs() : getPrintJobs(deckId),pollCount++ % 4 === 0 ? getPrintQueue(deckId) : null]);
        if (initialJobId && !data.jobs.some(job => job.id === initialJobId)) {
          // A persisted queue link can outlive the latest 50 history entries.
          // Use the same owner-scoped route; never guess or recreate that job.
          try {
            const selected = standalone ? await getStandalonePrintJob(initialJobId) : await getPrintJob(deckId, initialJobId);
            data.jobs = [selected.job, ...data.jobs];
          } catch (err) {
            if (!active) return;
            setError(`The linked batch could not be opened: ${err.message}`);
          }
        }
        if (!active) return;
        setJobs(data.jobs);
        if (queue) setConfirmationItems(queue.items);
        setCapabilities(data.capabilities);
        setGenerator(data.generator);
        setConnectionError('');
        if (!data.capabilities.canQueue) setStation(null);
        else if (pollCount % 4 === 1) {
          // Setup information is optional; a restricted/offline station must not
          // prevent a user from reviewing or downloading their PDFs.
          getPrintStationStatus().then(result => { if (active) setStation(result.station); })
            .catch(() => { if (active) setStation(null); });
        }
      } catch (err) {
        if (active) setConnectionError(err.message);
      } finally {
        if (active) timer = setTimeout(poll, 4000);
      }
    }
    poll();
    return () => { active = false; clearTimeout(timer); };
  }, [deckId, standalone, initialJobId]);

  function change(setter, value, keepReview = false) {
    if (requestRef.current) return;
    revisionRef.current += 1;
    setter(value);
    setReviewDirty(true);
    if (!keepReview) { setPlan(null); setEditingSource(true); }
    if (!keepReview) {
      setExcludedCards([]);
      setRemovedCards([]);
      setPrintingOverrides([]);
    }
    setError('');
    setNotice('');
    requestRef.current = null;
    setPendingRequest(null);
  }

  function replaceSourceText(value) {
    // Text imports can finish after a creation starts. Keep that original
    // request immutable, including its before list and printing scope.
    if (requestRef.current) return;
    change(setCardText, value);
    if (comparison) {
      setComparison(null);
      if (listName === 'Compared lists') setListName('');
      setNotice('The source list changed. Printing now uses the whole list; the previous comparison is no longer applied.');
    }
  }

  function pasteSourceText(event) {
    // React may skip onChange when pasted text equals the existing after list.
    // A deliberate paste still replaces the source, including its old baseline.
    if (!comparison || requestRef.current || event.target.tagName !== 'TEXTAREA') return;
    change(setComparison, null);
    if (listName === 'Compared lists') setListName('');
    setNotice('Pasted cards use the whole list. The previous comparison is no longer applied.');
  }

  function pickArt(scryfallId) {
    if (!selectedArtCard || requestRef.current || busy) return;
    change(setPrintingOverrides, [...printingOverrides.filter(item => item.selectionKey !== selectedArtCard.selectionKey), { selectionKey: selectedArtCard.selectionKey, scryfallId }], true);
    setSelectedArtCard(null);
  }

  function resetArt(card) {
    if (requestRef.current || busy) return;
    change(setPrintingOverrides, printingOverrides.filter(item => item.selectionKey !== card.selectionKey), true);
  }

  function removeCard(card) {
    if (requestRef.current || !card.selectionKey) return;
    change(setExcludedCards, [...new Set([...excludedCards, card.selectionKey])], true);
    setRemovedCards(previous => previous.some(item => item.key === card.selectionKey) ? previous
      : [...previous, { key: card.selectionKey, name: card.displayName, quantity: card.baseQuantity ?? card.quantity }]);
  }

  function restoreCard(key) {
    if (requestRef.current) return;
    change(setExcludedCards, excludedCards.filter(item => item !== key), true);
    setRemovedCards(previous => previous.filter(item => item.key !== key));
  }

  async function preview(event) {
    event.preventDefault();
    if (requestRef.current) return;
    setBusy(true);
    setError('');
    setNotice('');
    const revision = revisionRef.current;
    try {
      const data = standalone ? await previewStandalonePrintJob({
        mode: 'adhoc', listName, cardText, comparison: comparison || undefined, artSource: 'scryfall', includeSideboard, replacePrintings,
        excludeBasicLands, additionalCardText, excludedCards, printingOverrides,
      }) : await previewPrintPlan(deckId, {
        mode, targetSnapshotId: target === 'latest' ? undefined : Number(target),
        baselineSnapshotId: mode === 'changes' ? Number(baseline) : undefined,
        artSource, includeSideboard, replacePrintings, excludeBasicLands, additionalCardText, excludedCards, printingOverrides,
      });
      if (revision !== revisionRef.current) return;
      setPlan(data.plan);
      setRemovedCards((data.plan.removedCards || []).map(card => ({ key: card.selectionKey, name: card.displayName, quantity: card.quantity })));
      setReviewDirty(false);
      setEditingSource(false);
      setCapabilities(data.capabilities);
      setGenerator(data.generator);
      requestRef.current = null;
      setPendingRequest(null);
    } catch (err) {
      if (revision === revisionRef.current) setError(err.message);
    } finally { setBusy(false); }
  }

  async function generate(queueOnReady) {
    if (!requestRef.current && (reviewDirty || !printReviewReady(plan))) return;
    setBusy(true);
    setError('');
    try {
      // Keep the same key after an ambiguous network response; a retry is the same job.
      if (!requestRef.current) {
        const persisted = loadPrintCreationIntent(localStorage, requestStorageKey);
        if (persisted) {
          requestRef.current = persisted;
          setPendingRequest(persisted);
        }
      }
      if (!requestRef.current) {
        const request = standalone ? {
          mode: 'adhoc', listName, cardText, comparison: comparison || undefined, artSource: 'scryfall', includeSideboard, replacePrintings,
          excludeBasicLands, additionalCardText, excludedCards, printingOverrides,
          expectedPlanHash: plan.planHash, queueOnReady, idempotencyKey: requestId(),
        } : {
          mode, targetSnapshotId: plan.target.id, baselineSnapshotId: plan.source?.id,
          artSource, includeSideboard, replacePrintings, excludeBasicLands, additionalCardText, excludedCards, printingOverrides, expectedPlanHash: plan.planHash,
          queueOnReady, idempotencyKey: requestId(),
        };
        // Save before POST: a reload or lost response must recover this exact
        // request instead of creating a second potentially queued batch.
        try { localStorage.setItem(requestStorageKey, JSON.stringify(request)); }
        catch { throw new Error('The browser could not save this batch request. No request was sent. Free browser storage and retry.'); }
        requestRef.current = request;
        setPendingRequest(request);
      }
      const submitted = requestRef.current;
      const data = standalone ? await createStandalonePrintJob(submitted) : await createPrintJob(deckId, submitted);
      setJobs(old => [data.job, ...old.filter(job => job.id !== data.job.id)]);
      setPlan(null);
      setEditingSource(false);
      setFocusedJobId(data.job.id);
      setActiveView('batches');
      try { localStorage.removeItem(requestStorageKey); } catch { /* A retained key safely replays the known batch after reload. */ }
      requestRef.current = null;
      setPendingRequest(null);
      setNotice(submitted.queueOnReady ? 'Batch created. The Mac will pick it up when its PDFs are ready.' : 'Batch created. Your PDFs will appear below.');
    } catch (err) {
      if (rejectedPrintCreation(err)) {
        try { localStorage.removeItem(requestStorageKey); } catch { /* A retry remains the same rejected request. */ }
        requestRef.current = null;
        setPendingRequest(null);
        setReviewDirty(true);
      }
      setError(err.message);
    }
    finally { setBusy(false); }
  }

  async function jobAction(action, job) {
    setBusy(true);
    setError('');
    try {
      const result = standalone ? await action(job.id) : await action(deckId, job.id);
      setJobs(old => old.map(item => item.id === job.id ? result.job : item));
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function download(artifact, job) {
    setError('');
    try {
      const name = artifact.packetIndex && artifact.packetCount ? `double-faced-packet-${artifact.packetIndex}-of-${artifact.packetCount}` : artifact.id;
      await downloadPrintArtifact(artifact.downloadUrl, `${job.deckName || deck?.deck_name || 'Print-list'}-${job.id.slice(0, 8)}-${name}.pdf`);
    } catch (err) { setError(err.message); }
  }

  async function downloadManifest(job) {
    try {
      const path = standalone ? `/api/print-lists/jobs/${job.id}/manifest` : `/api/decks/${deckId}/print-jobs/${job.id}/manifest`;
      await downloadPrintArtifact(path, `clc-${job.id}-manifest.json`);
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

  function renderJob(job) {
    return <article className="print-panel-card print-batch" key={job.id}>
      <div className="print-panel-heading"><div><h4>{job.deckName || 'Print batch'}</h4><p className="print-panel-meta">{job.totalCopies} cards · Batch {job.id.slice(0, 8)}</p></div><span className={`print-panel-status print-batch-status print-batch-status--${job.state}`}>{STATES[job.state] || job.state}</span></div>
      {job.state === 'preparing' && <p>Creating your PDFs{job.progress?.totalSheets ? ` · ${job.progress.completedSheets || 0}/${job.progress.totalSheets} sheets ready` : '…'}</p>}
      {job.state === 'ready' && <p>Your PDFs are ready. Download them or send this batch to the Mac.</p>}
      {['queued', 'claimed', 'submitting', 'submitted'].includes(job.state) && <p>The Mac is handling this batch. Follow its progress in <a href="#print-station">Printer</a>.</p>}
      {job.error && <div className="print-panel-error" role="alert">{job.error}</div>}
      {job.proxyStagingError && <p className="print-panel-error" role="alert">Pending proxy review: {job.proxyStagingError}</p>}
      <WaitingPrintPacket job={job} />
      {job.state === 'uncertain' && <p>The Mac needs to reconcile this batch with Epson’s queue. Check <a href="#print-station">Printer</a> before creating another batch.</p>}
      {job.state === 'completed' && <p>Printing finished according to the spooler. Check the sheets, then confirm the usable copies.</p>}
      {job.state === 'canceled' && job.frontsCompleted && job.backsCanceled > 0 && <p>The fronts finished, and remaining backs were canceled. This job did not print every planned face.</p>}
      {job.cancelRequested && <p>Cancellation requested. Follow any paper-clearance instructions in <a href="#print-station">Printer</a>.</p>}
      <div className="print-panel-actions">
        {job.state === 'ready' && capabilities.canQueue && <button className="btn btn-primary" type="button" disabled={busy} onClick={() => jobAction(standalone ? queueStandalonePrintJob : queuePrintJob, job)}>Send to Mac</button>}
        {(job.artifacts || []).filter(a => a.downloadUrl).map(artifact => <button className="btn btn-secondary btn-sm" type="button" key={artifact.id} title={artifact.label || undefined} onClick={() => download(artifact, job)}>Download {artifactName(artifact)} PDF{artifact.kind === 'dfc' ? ' · fronts + backs' : ''}</button>)}
        {job.manifestSha256 && <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => recordPrintedProxies(job)}>Confirm usable copies</button>}
      </div>
      {recordError?.jobId === job.id && <p className="print-panel-error" role="alert">{recordError.message}</p>}
      {recordingJobId === job.id && <section className="mana-sync" aria-label={`Printed proxies for batch ${job.id}`}>
        <PrintQueue key={job.id} deckId={deckId} printJobId={job.id} />
        <button className="btn btn-secondary btn-sm" type="button" onClick={() => setRecordingJobId(null)}>Close proxy confirmation</button>
      </section>}
      <details className="print-batch-details"><summary>Batch details and options</summary>
        <p className="print-panel-meta">{new Date(job.createdAt).toLocaleString()} · {job.mode === 'adhoc' ? job.comparison?.mode === 'changes' ? 'Compared lists · changes' : 'Independent print list' : job.mode === 'changes' ? `Snapshots #${job.source?.id} → #${job.target?.id}` : `Snapshot #${job.target?.id}`} · {job.artSource === 'saved-mpc' ? job.printingOverrideCount ? 'MPC + selected Scryfall art' : 'Saved MPC artwork' : 'Scryfall artwork'}{job.printingOverrideCount ? ` · ${job.printingOverrideCount} art selections` : ''}</p>
        {job.manifestSha256 && <ProxyConfirmationStatus items={confirmationItems.filter(item => item.printJobId === job.id)} />}
        <div className="print-panel-actions">
          {canCancelReviewedPrintJob(job) && (['preparing', 'ready', 'queued'].includes(job.state) ? <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => jobAction(standalone ? cancelStandalonePrintJob : cancelPrintJob, job)}>Cancel batch</button> : <a className="btn btn-secondary btn-sm" href="#print-station">Manage cancellation in Printer</a>)}
          {job.canCancelBacks && <a className="btn btn-secondary btn-sm" href="#print-station">Manage remaining backs</a>}
          {job.manifestSha256 && <button className="btn btn-secondary btn-sm" type="button" onClick={() => downloadManifest(job)}>Download batch details</button>}
          {['ready', 'completed', 'failed', 'canceled'].includes(job.state) && job.artifacts?.length > 0 && <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => jobAction(standalone ? expireStandalonePrintArtifacts : expirePrintArtifacts, job)}>Remove PDFs</button>}
        </div>
        <p className="print-panel-meta">Saved backs remain available until completed or canceled. Ready and finished PDFs normally expire after seven days. Removing PDFs keeps the batch record.</p>
      </details>
    </article>;
  }

  const options = <div className="print-choice-options">
    <label className="print-panel-check"><input type="checkbox" checked={excludeBasicLands} disabled={busy || creationPending} onChange={e => change(setExcludeBasicLands, e.target.checked, true)} />Exclude basic lands</label>
    <label className="print-panel-check"><input type="checkbox" checked={includeSideboard} disabled={busy || creationPending} onChange={e => change(setIncludeSideboard, e.target.checked, true)} />Include sideboard</label>
    {(mode === 'changes' || comparison?.mode === 'changes') && <label className="print-panel-check"><input type="checkbox" checked={replacePrintings} disabled={busy || creationPending} onChange={e => change(setReplacePrintings, e.target.checked, true)} />Replace copies when the set or printing changes</label>}
  </div>;
  function openPrepare() {
    setActiveView('prepare');
    if (!plan && !creationPending) setEditingSource(true);
  }

  return <div className="print-panel">
    <div className="print-workspace-views" role="group" aria-label="Print workspace views">
      <button type="button" aria-pressed={activeView === 'prepare'} onClick={openPrepare}>Prepare</button>
      <button type="button" aria-pressed={activeView === 'batches'} onClick={() => setActiveView('batches')}>Batches{jobs.length ? ` (${jobs.length})` : ''}</button>
    </div>

    {incomingComparison && <section className="print-panel-confirmation" aria-label="Print compared lists">
      <h3>Print the lists you compared?</h3><p>{creationPending ? 'Resolve the pending batch below first. Your compared lists will wait here.' : 'Your current draft is still here. Use the compared lists and keep this draft available to restore, or continue your current list.'}</p>
      <div className="print-panel-actions"><button type="button" className="btn btn-primary" disabled={busy || creationPending} onClick={() => switchDraft(incomingComparison, incomingComparison.id)}>Use compared lists</button><button type="button" className="btn btn-secondary" onClick={() => { setHandledComparisonId(incomingComparison.id); onComparisonConsumed?.(incomingComparison.id); }}>Keep current draft</button></div>
    </section>}
    {error && <div className="print-panel-error" role="alert">{error}</div>}
    {connectionError && <p role="status">Print status could not refresh: {connectionError}</p>}
    {notice && <p role="status">{notice}</p>}

    {creationPending && <section className="print-panel-confirmation" aria-label="Recover print batch request">
      <h3>{busy ? 'Creating your batch…' : 'Checking your batch request'}</h3>
      <p>{pendingRequest?.mode === 'adhoc' ? pendingRequest.listName.trim() || 'Print list' : `Snapshot #${pendingRequest?.targetSnapshotId}`} · {pendingAction ? 'Generate and print' : 'Generate PDFs only'}.</p>
      <p>The result is not confirmed. Retry the saved request to recover the same batch without printing twice. Your card list stays locked until it is resolved.</p>
      <button className="btn btn-primary" type="button" disabled={busy} onClick={() => generate(pendingAction)}>Retry same batch request</button>
    </section>}

    <div className="print-prepare-view" hidden={activeView !== 'prepare'}>
    {!!activeJobs.length && <div className="print-active-summary"><span>{activeJobs.length} active {activeJobs.length === 1 ? 'batch' : 'batches'} · {STATES[activeJobs[0].state] || activeJobs[0].state}</span><button type="button" className="print-text-button" onClick={() => setActiveView('batches')}>View batches</button></div>}
    {editingSource && !creationPending && <form className="print-panel-card print-source" onSubmit={preview}>
      <h3>Choose cards</h3>
      {standalone ? <fieldset className="print-list-inputs" disabled={busy || creationPending}>
        {comparison && <div className="print-comparison-source"><span className="print-panel-status">From Compare</span><p>Your before and after lists are copied here. Your comparison stays unchanged.</p><label className="print-list-name">What to print<select value={comparison.mode} onChange={event => change(setComparison, { ...comparison, mode: event.target.value })}><option value="changes">Added or increased cards</option><option value="full">Whole after list</option></select></label><details><summary>View before list</summary><textarea aria-label="Before list for printing" value={comparison.beforeText} readOnly rows={5} /></details></div>}
        <label className="print-list-name">List name <span className="print-panel-meta">Optional · helps identify this batch at the printer</span><input type="text" value={listName} maxLength={120} placeholder="For example, Jin Sakai" onChange={event => change(setListName, event.target.value, true)} /></label>
        {!comparison && <p className="print-comparison-scope"><strong>Printing the whole list.</strong> Your basic-land and selection options apply below.</p>}
        <div onPasteCapture={pasteSourceText}><DeckInput label={comparison ? 'After list' : 'Cards to print'} value={cardText} onChange={replaceSourceText} /></div>
        <p className="print-panel-meta">Paste cards, use a file or import a deck URL. Up to 250 copies. Your draft saves in this browser.</p>
        {cardText.length > 100000 && <p role="alert">This list is too large. Use at most 100,000 characters.</p>}
        {draftError && <p role="status">{draftError}</p>}
      </fieldset> : <div className="print-panel-fields">
        <label>What to print<select value={mode} disabled={busy} onChange={e => change(setMode, e.target.value)}><option value="full">Whole snapshot</option><option value="changes">Changes between snapshots</option></select></label>
        <label>Target version<select value={target} disabled={busy} onChange={e => change(setTarget, e.target.value)}><option value="latest">Latest snapshot</option>{snapshots.map(s => <option key={s.id} value={s.id}>{snapshotLabel(s)}</option>)}</select></label>
        {mode === 'changes' && <label>Compare from<select value={baseline} disabled={busy} onChange={e => change(setBaseline, e.target.value)} required><option value="">Choose an earlier version</option>{snapshots.map(s => <option key={s.id} value={s.id}>{snapshotLabel(s)}{s.id === deck.paper_snapshot_id ? ' · Paper deck' : ''}</option>)}</select></label>}
        <label>Artwork<select value={artSource} disabled={busy} onChange={e => change(setArtSource, e.target.value, true)}><option value="scryfall">Scryfall — snapshot printings</option><option value="saved-mpc">Saved MPC artwork</option></select></label>
      </div>}
      {options}
      {artSource === 'saved-mpc' && <p className="print-panel-meta">Every face needs saved MPC art. Missing choices stop the batch.</p>}
      <div className="print-panel-actions"><button className="btn btn-primary" type="submit" disabled={busy || (standalone ? !cardText.trim() || cardText.length > 100000 : !snapshots.length) || (mode === 'changes' && !baseline)}>{busy ? 'Checking artwork…' : 'Review print list'}</button>{plan && <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => setEditingSource(false)}>Back to review</button>}</div>
      {standalone && previousDraft?.cardText?.trim() && <details><summary>Previous draft</summary><p>{previousDraft.listName || 'Unnamed print list'} is saved in this browser.</p><button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => switchDraft(previousDraft)}>Restore previous draft</button></details>}
    </form>}

    {plan && !editingSource && <section className="print-panel-card print-review-step" aria-label="Print list review">
      <div className="print-panel-heading"><div><h3>Review your cards</h3><p className="print-panel-meta">{standalone ? plan.list?.name || plan.deckName : plan.source ? `Snapshots #${plan.source.id} → #${plan.target.id}` : `Snapshot #${plan.target.id}`}{plan.comparison ? plan.comparison.mode === 'changes' ? ' · Added or increased cards' : ' · Whole after list' : standalone ? ' · Whole list' : ''}</p></div><button type="button" className="btn btn-secondary btn-sm" disabled={busy || creationPending} onClick={() => setEditingSource(true)}>Edit source list</button></div>
      {plan.comparison?.mode === 'changes' && <p className="print-comparison-scope"><strong>Printing changes only.</strong> Copies already in the before list are left out. To print the whole deck, use Edit source list and choose Whole after list.</p>}
      <div className="print-copy-breakdown" aria-label="Print copy breakdown">
        <span>{copyCounts.sourceCopies} {standalone ? plan.comparison ? 'copies in after list' : 'copies in source' : 'suggested copies'}</span>
        {copyCounts.unchangedCopies > 0 && <span>− {copyCounts.unchangedCopies} already in before list</span>}
        {copyCounts.extraCopies > 0 && <span>+ {copyCounts.extraCopies} extras</span>}
        {copyCounts.removedCopies > 0 && <span>− {copyCounts.removedCopies} removed</span>}
        {copyCounts.basicCopies > 0 && <span>− {copyCounts.basicCopies} basic lands</span>}
        <strong>= {copyCounts.totalCopies} to print</strong>
      </div>
      {reviewDirty && <div className="print-panel-confirmation print-review-dirty" role="status"><strong>Changes need a fresh review.</strong><p>Counts and artwork below are from your last review. Use Review updated list below before continuing.</p></div>}
      <details className="print-review-edit"><summary>Edit selection{additionalCardText ? ' · extras added' : ''}{removedCards.length ? ` · ${removedCards.length} removed` : ''}</summary><div className="print-review-tools"><details className="print-add-cards"><summary>Add extra cards{additionalCardText ? ' · included' : ''}</summary><label className="print-list-name">Extra cards<textarea aria-label="Extra cards to print" value={additionalCardText} maxLength={100000} rows={4} placeholder={'1 Lightning Bolt\n2 Sol Ring'} disabled={busy || creationPending} onChange={event => change(setAdditionalCardText, event.target.value, true)} /></label><p className="print-panel-meta">Added only to this batch. Edit these lines to remove extra copies.{artSource === 'saved-mpc' && ' Extra cards also need saved MPC art, or switch the whole batch to Scryfall.'}</p></details>
        <details><summary>Selection options{excludeBasicLands ? ' · basics excluded' : ''}{includeSideboard ? ' · sideboard included' : ''}</summary>{options}</details>
        {removedCards.length > 0 && <details className="print-list-removed"><summary>Removed cards ({removedCards.length})</summary><ul>{removedCards.map(card => <li key={card.key}><span>{card.quantity}× {card.name}</span><button type="button" className="btn btn-secondary btn-sm" disabled={busy || creationPending} onClick={() => restoreCard(card.key)}>Include again</button></li>)}</ul></details>}
      </div></details>
      {!!plan.excludedBasicLands?.length && <details className="print-skipped-basics"><summary>{copyCounts.basicCopies} basic-land copies skipped</summary><ul>{plan.excludedBasicLands.map((card, index) => <li key={`${card.selectionKey}:${index}`}>{card.quantity}× {card.displayName}</li>)}</ul><p className="print-panel-meta">To include these copies, open Edit selection → Selection options and clear Exclude basic lands.</p></details>}
      {plan.totalCopies > 0 && <PrintListReview key={plan.planHash} plan={plan} onRemove={removeCard} excludedCards={excludedCards} disabled={busy || creationPending} shoppingDisabled={reviewDirty} printingOverrides={printingOverrides} onPickArt={setSelectedArtCard} onResetArt={resetArt} />}
      {plan.missingArtwork?.length > 0 && <div className="print-panel-error" role="alert">Choose artwork for:{'\n'}{plan.missingArtwork.map(card => `${card.quantity}× ${card.displayName} (${card.face})`).join('\n')}</div>}
      {plan.totalCopies === 0 && <p>No copies remain. Restore removed cards, add extras or change the selection options.</p>}
      {summary?.doubleFaced > 0 && <p className="print-dfc-note">{summary.doubleFaced} double-sided {summary.doubleFaced === 1 ? 'card' : 'cards'} will use {summary.packets} separate labeled {summary.packets === 1 ? 'sheet' : 'sheets'}. With companion 2.55.0 or newer, all fronts print first. Keep those sheets and choose their backs later in Printer; other front jobs continue. Older companions keep their original front/back sequence.</p>}
      {station?.online && station.duplexVerified === false && summary?.doubleFaced > 0 && <p className="print-panel-meta">Double-sided alignment has not been verified. Check Printer before continuing. <a href="#print-station">Printer</a></p>}
      <div className="print-review-footer"><div><strong>{plan.totalCopies} {plan.totalCopies === 1 ? 'copy' : 'copies'}{summary ? ` · ${summary.sheets} ${summary.sheets === 1 ? 'sheet' : 'sheets'}` : ''}</strong><span>Entire reviewed batch · Letter paper</span></div><div className="print-panel-actions">
        {reviewDirty ? <button type="button" className="btn btn-primary" disabled={busy || creationPending} onClick={preview}>{busy ? 'Checking artwork…' : 'Review updated list'}</button> : <><button className={`btn ${capabilities.canQueue ? 'btn-secondary' : 'btn-primary'}`} disabled={busy || !generator?.available || !printReviewReady(plan) || pendingAction === true} onClick={() => generate(false)} type="button">Generate PDFs</button>{capabilities.canQueue && <button className="btn btn-primary" disabled={busy || !generator?.available || !printReviewReady(plan) || pendingAction === false} onClick={() => generate(true)} type="button">Generate & print</button>}</>}
      </div></div>
    </section>}

    </div>
    <section className="print-batches-view" hidden={activeView !== 'batches'} aria-label={standalone ? 'Print-list batches' : 'This deck’s batches'}>
      <p className="print-panel-meta"><a href="#print-station">View all batches at the Printer</a></p>
      <div className="print-panel-heading"><div><h3>{standalone ? 'Print-list batches' : 'This deck’s batches'}</h3><p className="print-panel-meta">{standalone ? 'Batches created from card lists here. Deck batches remain in each deck’s Print tab.' : 'PDFs, printer progress and usable-copy confirmations for this deck.'}</p></div><button className="btn btn-secondary btn-sm" type="button" disabled={busy || creationPending} onClick={openPrepare}>{plan ? 'Return to review' : 'Prepare another batch'}</button></div>
      {prominentJob && <section className="print-panel-jobs" aria-label="Current print batch">{renderJob(prominentJob)}</section>}
      {!!historyJobs.length && <details className="print-history" open={!prominentJob || undefined}><summary>Other print batches ({historyJobs.length})</summary><div className="print-panel-jobs">{historyJobs.map(renderJob)}</div></details>}
      {!jobs.length && <p>No batches yet. Prepare a list and review its artwork to get started.</p>}
    </section>

    <details className="print-help" aria-label="PDF generator status"><summary>{generator?.available ? 'PDF setup' : generator?.updating ? 'Preparing the PDF generator…' : 'PDF generator unavailable'}</summary>
      <p>{generator?.available ? `Silhouette Card Maker ${generator.revision?.slice(0, 8)} · Letter · v6 · 600 PPI · 1 mm crop · 7 cards per sheet.` : 'CLC needs a working Silhouette Card Maker installation. Check the server setup or restart to retry the update.'}</p>
      {generator?.fallbackReason && <p>{generator.fallbackReason}</p>}
      <p>Open an artwork thumbnail to enlarge it; the PDF applies the household crop. Double-sided packets are handled in Printer.</p>

      {!capabilities.stationConfigured && <p>PDF downloads work without a printer. Configure the Mac companion to enable the household queue.</p>}
      {capabilities.stationConfigured && !capabilities.canQueue && <p>Your administrator can enable household queue access. You can still download PDFs.</p>}
      <a href="#print-station">Open Printer</a>
    </details>
    {selectedArtCard && <PrintArtPicker card={selectedArtCard} currentScryfallId={printingOverrides.find(item => item.selectionKey === selectedArtCard.selectionKey)?.scryfallId || selectedArtCard.scryfallId} onChoose={pickArt} onClose={() => setSelectedArtCard(null)} disabled={busy || creationPending} />}
  </div>;
}
