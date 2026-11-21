import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { previewPrintPlan, savePrintArtToDeck, createPrintJob, getPrintJobs, getPrintJob, getPrintJobActivity, getPrintQueue, queuePrintJob, cancelPrintJob, expirePrintArtifacts, downloadPrintArtifact, stagePrintJobConfirmations,
  getStandalonePrintJobs, getStandalonePrintJob, getStandalonePrintJobActivity, previewStandalonePrintJob, createStandalonePrintJob, queueStandalonePrintJob, cancelStandalonePrintJob, expireStandalonePrintArtifacts } from '../lib/api';
import DeckInput from './DeckInput';
import PrintPaperProof from './PrintPaperProof';
import PrintArtPicker from './PrintArtPicker';
import PrintRegenerationDialog from './PrintRegenerationDialog';
import PrintListReview from './PrintListReview';
import PrintQueue from './PrintQueue';
import { batchDetailRefresh, loadPrintCreationIntent, loadStandalonePrintDraft, saveStandaloneDraftReplacement, printArtOverridesAfterSave, printCreationRequestKey, printReviewReady, printReviewSummary, printCopyBreakdown, printSourceCopies, canCancelReviewedPrintJob, mixedPrintCompanionWait, rejectedPrintCreation, waitingPrintArtifact } from '../lib/printReview';
import { CROWNED_A4_PORTRAIT_SIX_PRESET, DAHLE_A4_LAYOUT, DAHLE_A4_PRESET, PRINT_PAPER, availablePrintPaperChoices, isCrownedPrintPreset, loadDefaultPrintPaper, newPrintPaperChoice, printMarksLabel, printPaperChoice, printPaperLabel, printPaperRequest, printPaperUnavailable, selectAvailablePrintPaper, stationPaperChoice } from '../lib/printPaper';
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
  if (job.state === 'backs_pending') return <section className="print-panel-confirmation" aria-label="Backs saved for later"><strong>Fronts are printed. Backs are saved for later.</strong><p>Other front jobs can continue. Set aside the labeled sheets that need backs, then choose their matching packets in <a href="#print-station">Printer → Backs for later</a> whenever you are ready. Select a packet before reloading paper.</p></section>;
  if (['awaiting_clearance', 'awaiting_paper_reset'].includes(job.state)) return <section className="print-panel-confirmation"><strong>{job.state === 'awaiting_clearance' ? 'Canceled-job paper needs clearing' : 'Backs finished — restore blank paper'}</strong><p>Remove printed or flipped paper, leave only blank paper in the rear feeder and confirm in <a href="#print-station">Printer</a> before other front jobs continue.</p></section>;
  if (job.state !== 'awaiting_refeed') return null;
  const artifact = waitingPrintArtifact(job);
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

function mergePrintJobs(current, incoming, focusedId) {
  const byId = new Map(current.map(job => [job.id, job]));
  for (const job of incoming) {
    const existing = byId.get(job.id);
    if (!existing || job.updatedAt >= existing.updatedAt) byId.set(job.id, job);
  }
  const ordered = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return [...ordered.slice(0, 50), ...ordered.slice(50).filter(job => job.id === focusedId)];
}

export default function PrintPanel({ deck, snapshots = [], standalone = false, initialComparison, onComparisonConsumed, initialJobId, onDeckChanged }) {
  const { user } = useAuth();
  const deckId = deck?.id;
  const requestStorageKey = `clc-print-job-request:${user.id}:${standalone ? 'adhoc' : deckId}`;
  const draftStorageKey = `clc-print-list-draft:${user.id}`;
  const paperDefaultKey = `clc-print-paper-default:${user.id}`;
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
  const [defaultPaper, setDefaultPaper] = useState(() => loadDefaultPrintPaper(localStorage, paperDefaultKey));
  const savedPaper = storedRequest?.paperSize ? storedRequest : storedDraft;
  const [paperOverride, setPaperOverride] = useState(savedPaper?.paperSize ? newPrintPaperChoice(printPaperChoice(savedPaper)) : null);
  const [registrationMarks, setRegistrationMarks] = useState(() => (storedRequest ?? storedDraft)?.registrationMarks ?? true);
  const [dahleCutGuides, setDahleCutGuides] = useState(() => (storedRequest ?? storedDraft)?.dahleCutGuides === true);
  const [includeSideboard, setIncludeSideboard] = useState(standalone ? storedRequest?.includeSideboard ?? storedDraft?.includeSideboard ?? false : false);
  const [replacePrintings, setReplacePrintings] = useState(storedRequest?.replacePrintings ?? storedDraft?.replacePrintings ?? false);
  const [excludeBasicLands, setExcludeBasicLands] = useState(storedRequest ? storedRequest.excludeBasicLands ?? false : storedDraft?.excludeBasicLands ?? true);
  const [additionalCardText, setAdditionalCardText] = useState(storedRequest?.additionalCardText ?? storedDraft?.additionalCardText ?? '');
  const [excludedCards, setExcludedCards] = useState(storedRequest?.excludedCards ?? storedDraft?.excludedCards ?? []);
  const [removedCards, setRemovedCards] = useState(storedDraft?.removedCards ?? []);
  const [printingOverrides, setPrintingOverrides] = useState(storedRequest?.printingOverrides ?? storedDraft?.printingOverrides ?? []);
  const [selectedArtCard, setSelectedArtCard] = useState(null);
  const [pendingArt, setPendingArt] = useState([]);
  const [deckArtConflict, setDeckArtConflict] = useState(false);
  const [plan, setPlan] = useState(null);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [editingSource, setEditingSource] = useState(true);
  const [activeView, setActiveView] = useState(initialJobId ? 'batches' : 'prepare');
  const [focusedJobId, setFocusedJobId] = useState(initialJobId || null);
  const [jobs, setJobs] = useState([]);
  const [activity, setActivity] = useState({ activeCount: 0, jobs: [] });
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [confirmationItems, setConfirmationItems] = useState([]);
  const [confirmationError, setConfirmationError] = useState('');
  const [capabilities, setCapabilities] = useState({});
  const [generator, setGenerator] = useState(null);
  const [station, setStation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [notice, setNotice] = useState('');
  const [startingDownload, setStartingDownload] = useState(null);
  const [regeneratingJob, setRegeneratingJob] = useState(null);
  const [pendingRequest, setPendingRequest] = useState(storedRequest);
  const [recordingJobId, setRecordingJobId] = useState(null);
  const [recordError, setRecordError] = useState(null);
  const stagedJobsRef = useRef(new Set());
  const requestRef = useRef(storedRequest);
  const revisionRef = useRef(0);
  const creationPending = !!pendingRequest;
  const pendingAction = pendingRequest?.queueOnReady ?? null;
  const availablePaper = availablePrintPaperChoices(capabilities);
  const preferredPaper = paperOverride ?? defaultPaper;
  const selectedPaper = pendingRequest ? printPaperChoice(pendingRequest)
    : selectAvailablePrintPaper(preferredPaper, availablePaper);
  const showPendingPaper = creationPending && !availablePaper.includes(selectedPaper);
  const paperPreset = PRINT_PAPER[selectedPaper];
  const manualPunch = selectedPaper === DAHLE_A4_PRESET;
  const selectedRegistrationMarks = !manualPunch && (pendingRequest ? pendingRequest.registrationMarks ?? true : registrationMarks);
  const selectedDahleCutGuides = manualPunch && (pendingRequest ? pendingRequest.dahleCutGuides === true : dahleCutGuides);
  const draftPaper = paperOverride ?? (dahleCutGuides && defaultPaper === DAHLE_A4_PRESET ? defaultPaper : null);
  const canQueueSelectedPaper = capabilities.canQueue && !manualPunch;
  const needsReview = reviewDirty || !!pendingArt.length || (!!plan
    && (selectedPaper !== printPaperChoice(plan) || selectedDahleCutGuides !== (plan.dahleCutGuides === true)));
  const deckArtChoices = pendingArt.filter(choice => choice.saveToDeck);
  const unavailableArtChoices = deckArtChoices.filter(choice => choice.unavailable);
  const selectedArtChoice = pendingArt.find(choice => choice.selectionKey === selectedArtCard?.selectionKey);
  const newDeckVersionNeedsReview = deckArtConflict || (!!plan?.target && target !== 'latest' && Number(target) !== plan.target.id);
  const canSaveArtToDeck = !standalone && !!plan?.target?.textHash && plan.target.id === snapshots[0]?.id
    && !newDeckVersionNeedsReview && selectedArtCard?.baseQuantity > 0;
  const reviewedPaper = PRINT_PAPER[printPaperChoice(plan)];
  const paperUnavailable = canQueueSelectedPaper ? printPaperUnavailable(printPaperRequest(selectedPaper), station) : '';
  const summary = printReviewSummary(plan);
  const doubleFacedFirst = plan?.sheetPacking === 'double-faced-first';
  const sourceCopies = useMemo(() => standalone && plan ? printSourceCopies(cardText, plan.includeSideboard) : undefined, [standalone, plan, cardText]);
  const copyCounts = printCopyBreakdown(plan, sourceCopies);
  const incomingComparison = initialComparison && initialComparison.id !== handledComparisonId ? initialComparison : null;
  const activeJob = activity.jobs[0];
  const prominentJob = jobs.find(job => job.id === (focusedJobId || activeJob?.id)) || jobs[0];
  const historyJobs = jobs.filter(job => job.id !== prominentJob?.id);
  const autoConsumedRef = useRef(false);
  const readJobs = useEffectEvent(() => jobs);
  const readFocus = useEffectEvent(() => focusedJobId);

  useEffect(() => {
    if (!initialJobId) return;
    setFocusedJobId(initialJobId);
    setActiveView('batches');
  }, [initialJobId]);

  useEffect(() => {
    if (!standalone) return;
    try {
      localStorage.setItem(draftStorageKey, JSON.stringify({ listName, cardText, comparison, replacePrintings, includeSideboard, excludeBasicLands, additionalCardText, excludedCards, removedCards, printingOverrides, registrationMarks, ...(draftPaper ? printPaperRequest(draftPaper, { dahleCutGuides }) : {}) }));
      setDraftError('');
      if (autoComparison && !autoConsumedRef.current) {
        autoConsumedRef.current = true;
        onComparisonConsumed?.(autoComparison.id);
      }
    } catch { setDraftError('This browser could not save your draft. Keep a copy of your card list before leaving this page.'); }
  }, [standalone, draftStorageKey, listName, cardText, comparison, replacePrintings, includeSideboard, excludeBasicLands, additionalCardText, excludedCards, removedCards, printingOverrides, registrationMarks, draftPaper, dahleCutGuides, autoComparison, onComparisonConsumed]);

  function switchDraft(draft, comparisonId) {
    if (requestRef.current || busy) return;
    const nextPaper = draft.paperSize ? newPrintPaperChoice(printPaperChoice(draft)) : null;
    const current = { listName, cardText, comparison, replacePrintings, includeSideboard, excludeBasicLands, additionalCardText, excludedCards, removedCards, printingOverrides, registrationMarks, ...(draftPaper ? printPaperRequest(draftPaper, { dahleCutGuides }) : {}) };
    const next = { listName: draft.listName || '', cardText: draft.cardText || '', comparison: draft.comparison || null,
      replacePrintings: draft.replacePrintings ?? false, includeSideboard: draft.includeSideboard ?? false,
      excludeBasicLands: draft.excludeBasicLands ?? true, additionalCardText: draft.additionalCardText || '',
      excludedCards: draft.excludedCards || [], removedCards: draft.removedCards || [], printingOverrides: draft.printingOverrides || [],
      registrationMarks: draft.registrationMarks ?? registrationMarks,
      ...(nextPaper ? printPaperRequest(nextPaper, { dahleCutGuides: draft.dahleCutGuides }) : {}) };
    try { saveStandaloneDraftReplacement(localStorage, draftStorageKey, recoveryStorageKey, current, next); }
    catch { setError('The browser could not save both drafts. Your current draft and compared lists are unchanged. Free browser storage and try again.'); return; }
    setPreviousDraft(current);
    revisionRef.current += 1;
    setListName(draft.listName || ''); setCardText(draft.cardText || ''); setComparison(draft.comparison || null);
    setReplacePrintings(draft.replacePrintings ?? false); setIncludeSideboard(draft.includeSideboard ?? false);
    setExcludeBasicLands(draft.excludeBasicLands ?? true); setAdditionalCardText(draft.additionalCardText || '');
    setExcludedCards(draft.excludedCards || []); setRemovedCards(draft.removedCards || []);
    setPaperOverride(nextPaper); setRegistrationMarks(next.registrationMarks);
    setDahleCutGuides(next.dahleCutGuides === true);
    setPrintingOverrides(draft.printingOverrides || []); setPendingArt([]); setSelectedArtCard(null);
    setPlan(null); setEditingSource(true); setActiveView('prepare'); setFocusedJobId(null); setError(''); setNotice('');
    if (comparisonId) { setHandledComparisonId(comparisonId); onComparisonConsumed?.(comparisonId); }
  }

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    if (activeView !== 'batches') return;
    const controller = new AbortController();
    const history = standalone ? getStandalonePrintJobs(controller.signal) : getPrintJobs(deckId, controller.signal);
    history.then(data => {
      if (controller.signal.aborted) return;
      const focusedId = readFocus();
      setJobs(old => mergePrintJobs(old, data.jobs, focusedId));
      setHistoryError('');
      setHistoryLoaded(true);
    }).catch(err => { if (!controller.signal.aborted) setHistoryError(err.message); });
    getPrintQueue(deckId, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setConfirmationItems(data.items);
      setConfirmationError('');
    }).catch(err => { if (!controller.signal.aborted) setConfirmationError(err.message); });
    return () => controller.abort();
  }, [activeView, deckId, standalone, refreshRevision]);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer;
    let missingFocus = '';
    async function poll() {
      let delay = 4000;
      try {
        const batches = activeView === 'batches';
        const shown = batches ? readJobs() : [];
        const watch = shown.map(job => job.id);
        const data = standalone ? await getStandalonePrintJobActivity(signal, watch) : await getPrintJobActivity(deckId, signal, watch);
        if (signal.aborted) return;
        setActivity(data);
        setCapabilities(data.capabilities);
        setGenerator(data.generator);
        setStation(data.station);
        if (!data.watching && !data.generator?.updating) delay = batches || data.capabilities.canQueue ? 15000 : 0;
        if (!batches) {
          setConnectionError('');
          return;
        }
        const { changed, removed } = batchDetailRefresh(shown, data, missingFocus ? null : focusedJobId);
        const changes = await Promise.all(changed.map(async id => {
          try {
            const { job } = standalone ? await getStandalonePrintJob(id, signal) : await getPrintJob(deckId, id, signal);
            return { job };
          } catch (err) {
            return { id, err };
          }
        }));
        if (signal.aborted) return;
        const unavailable = new Set(removed);
        const refreshed = [];
        let detailError = '';
        for (const { job, id, err } of changes) {
          if (job) refreshed.push(job);
          else if (err.status === 404) unavailable.add(id);
          else detailError = `Batch details could not refresh: ${err.message}`;
          if (err && id === focusedJobId) {
            detailError = `The linked batch could not be opened: ${err.message}`;
            if (err.status === 404) missingFocus = detailError;
          }
        }
        if (unavailable.size || refreshed.length) {
          setJobs(old => mergePrintJobs(old.filter(row => !unavailable.has(row.id)), refreshed, focusedJobId));
        }
        setConnectionError(missingFocus || detailError);
      } catch (err) {
        if (!signal.aborted) {
          setStation(null);
          setConnectionError(err.message);
        }
      } finally {
        if (!signal.aborted && delay) timer = setTimeout(poll, delay);
      }
    }
    poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [activeView, deckId, standalone, focusedJobId, visible, refreshRevision]);

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
      setPendingArt([]);
      setDeckArtConflict(false);
    }
    setError('');
    setNotice(!keepReview && deckArtChoices.length ? 'Staged deck art was cleared because the source changed.' : '');
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

  function applySourceImport(text) {
    if (requestRef.current) return null;
    replaceSourceText(text);
    return () => {
      if (requestRef.current) return false;
      change(setCardText, cardText);
      setComparison(comparison);
      if (comparison && listName === 'Compared lists') setListName(current => current || listName);
      setExcludedCards(excludedCards);
      setRemovedCards(removedCards);
      setPrintingOverrides(printingOverrides);
      setPendingArt(pendingArt);
      setNotice('The previous source list has been restored.');
      return true;
    };
  }

  function pickArt(choice, saveToDeck) {
    if (!selectedArtCard || requestRef.current || busy) return;
    if (saveToDeck && !canSaveArtToDeck) return;
    const { selectionKey, displayName } = selectedArtCard;
    const { id: scryfallId, setCode, collectorNumber } = choice;
    const printingLabel = [setCode.toUpperCase(), collectorNumber].filter(Boolean).join(' ');
    change(setPendingArt, previous => [
      ...previous.filter(item => item.selectionKey !== selectionKey),
      { selectionKey, scryfallId, displayName, printingLabel, saveToDeck },
    ], true);
    setPrintingOverrides(previous => [
      ...previous.filter(item => item.selectionKey !== selectionKey),
      ...(!saveToDeck ? [{ selectionKey, scryfallId }] : []),
    ]);
    setSelectedArtCard(null);
  }

  function resetArt(card) {
    if (requestRef.current || busy) return;
    change(setPrintingOverrides, printingOverrides.filter(item => item.selectionKey !== card.selectionKey), true);
    setPendingArt(previous => previous.filter(item => item.selectionKey !== card.selectionKey));
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

  function savePaperDefault() {
    try {
      localStorage.setItem(paperDefaultKey, selectedPaper);
      setDefaultPaper(selectedPaper);
      setPaperOverride(null);
      setNotice(`${paperPreset.label} saved as your default in this browser.`);
    } catch { setError('This browser could not save your default print preset. You can still use it for this batch.'); }
  }

  function chooseAnotherBaseline() {
    setBaseline('');
    setEditingSource(true);
    setReviewDirty(true);
    setError('The comparison version is no longer available. Choose another earlier version.');
  }

  async function preview(event) {
    event.preventDefault();
    if (requestRef.current) return;
    const comparingVersions = !standalone && mode === 'changes';
    if (comparingVersions && !snapshots.some(snapshot => String(snapshot.id) === baseline)) {
      chooseAnotherBaseline();
      return;
    }
    if (unavailableArtChoices.length && !deckArtConflict) {
      setError('Remove artwork choices for changed or missing cards before reviewing again.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    const revision = revisionRef.current;
    let targetSnapshotId = target === 'latest' ? undefined : Number(target);
    let nextOverrides = printingOverrides;
    let nextExcludedCards = excludedCards;
    let savingDeckArt = false;
    try {
      if (deckArtChoices.length && !deckArtConflict) {
        savingDeckArt = true;
        const result = await savePrintArtToDeck(deckId, {
          targetSnapshotId: plan.target.id, targetTextHash: plan.target.textHash,
          includeSideboard: plan.includeSideboard,
          choices: deckArtChoices.map(({ selectionKey, scryfallId }) => ({ selectionKey, scryfallId })),
        });
        savingDeckArt = false;
        const changes = new Map(result.choices.map(({ previousSelectionKey, selectionKey }) => [previousSelectionKey, selectionKey]));
        targetSnapshotId = result.snapshot.id;
        nextOverrides = printArtOverridesAfterSave(printingOverrides, result.choices, artSource, additionalCardText, includeSideboard);
        nextExcludedCards = [...new Set(excludedCards.map(key => changes.get(key) ?? key))];
        // Record the completed save before the preview, which can fail independently.
        setPendingArt(previous => previous.filter(choice => !choice.saveToDeck));
        setTarget(String(targetSnapshotId));
        setPrintingOverrides(nextOverrides);
        setExcludedCards(nextExcludedCards);
        const savedMessage = result.changed ? 'Artwork saved together in a new deck version.' : 'This artwork is already saved in the deck.';
        const excludedDestinations = result.choices.some(choice => nextExcludedCards.includes(choice.selectionKey));
        setNotice(excludedDestinations
          ? `${savedMessage} A selected printing is excluded from this batch. Use Edit selection to include it.`
          : savedMessage);
        if (result.changed) await onDeckChanged?.();
      }
      const data = standalone ? await previewStandalonePrintJob({
        mode: 'adhoc', listName, cardText, comparison: comparison || undefined, artSource: 'scryfall', includeSideboard, replacePrintings,
        excludeBasicLands, additionalCardText, excludedCards: nextExcludedCards, printingOverrides: nextOverrides, ...printPaperRequest(selectedPaper, { dahleCutGuides: selectedDahleCutGuides }),
      }) : await previewPrintPlan(deckId, {
        mode, targetSnapshotId,
        baselineSnapshotId: mode === 'changes' ? Number(baseline) : undefined,
        artSource, includeSideboard, replacePrintings, excludeBasicLands, additionalCardText,
        excludedCards: nextExcludedCards, printingOverrides: nextOverrides, ...printPaperRequest(selectedPaper, { dahleCutGuides: selectedDahleCutGuides }),
      });
      if (revision !== revisionRef.current) return;
      if ((data.plan.dahleCutGuides === true) !== selectedDahleCutGuides || data.plan.dahleAlignmentMarks === true) throw new Error('The reviewed marks did not match this layout. Review the print list again.');
      setPlan(data.plan);
      if (deckArtConflict) {
        const included = new Set([...data.plan.cards, ...(data.plan.removedCards || []), ...(data.plan.excludedBasicLands || [])]
          .filter(card => card.baseQuantity > 0).map(card => card.selectionKey));
        setPendingArt(deckArtChoices.map(choice => ({ ...choice, unavailable: !included.has(choice.selectionKey) })));
        setNotice('Latest deck reviewed. Your saved-deck artwork choices are still staged.');
      } else {
        setPendingArt([]);
      }
      setDeckArtConflict(false);
      setRemovedCards((data.plan.removedCards || []).map(card => ({ key: card.selectionKey, name: card.displayName, quantity: card.quantity })));
      setReviewDirty(false);
      setEditingSource(false);
      setCapabilities(data.capabilities);
      setGenerator(data.generator);
      requestRef.current = null;
      setPendingRequest(null);
    } catch (err) {
      if (revision !== revisionRef.current) return;
      if (savingDeckArt && err.status === 409) {
        setDeckArtConflict(true);
        setTarget('latest');
        setReviewDirty(true);
        setError('The deck changed. Review the latest version to keep working with your artwork choices.');
        await onDeckChanged?.();
      } else if (comparingVersions && err.status === 404 && err.message === 'Baseline snapshot not found') {
        chooseAnotherBaseline();
        void onDeckChanged?.();
      } else {
        setError(err.message);
      }
    } finally { setBusy(false); }
  }

  async function generate(queueOnReady) {
    if (!requestRef.current && (needsReview || !printReviewReady(plan) || (queueOnReady && (!canQueueSelectedPaper || paperUnavailable)))) return;
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
          expectedPlanHash: plan.planHash, ...printPaperRequest(printPaperChoice(plan), plan), registrationMarks: selectedRegistrationMarks, queueOnReady, idempotencyKey: printCreationRequestKey(),
        } : {
          mode, targetSnapshotId: plan.target.id, baselineSnapshotId: plan.source?.id,
          artSource, includeSideboard, replacePrintings, excludeBasicLands, additionalCardText, excludedCards, printingOverrides, expectedPlanHash: plan.planHash,
          ...printPaperRequest(printPaperChoice(plan), plan), registrationMarks: selectedRegistrationMarks, queueOnReady, idempotencyKey: printCreationRequestKey(),
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
      setJobs(old => mergePrintJobs(old, [data.job], data.job.id));
      setPlan(null);
      setPaperOverride(null);
      setDahleCutGuides(false);
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
    setStartingDownload(artifact.downloadUrl);
    setError('');
    setNotice('');
    try {
      const name = artifact.packetIndex && artifact.packetCount ? `double-faced-packet-${artifact.packetIndex}-of-${artifact.packetCount}` : artifact.id;
      await downloadPrintArtifact(artifact.downloadUrl, `${job.deckName || deck?.deck_name || 'Print-list'}-${job.id.slice(0, 8)}-${name}.pdf`);
      setNotice('Check your browser’s downloads for progress.');
    } catch (err) { setError(err.message); }
    finally { setStartingDownload(null); }
  }

  async function downloadManifest(job) {
    try {
      const path = standalone ? `/api/print-lists/jobs/${job.id}/manifest` : `/api/decks/${deckId}/print-jobs/${job.id}/manifest`;
      await downloadPrintArtifact(path, `clc-${job.id}-manifest.json`);
    } catch (err) { setError(err.message); }
  }

  function showRegeneratedJob(job, existing) {
    setJobs(old => mergePrintJobs(old, [job], job.id));
    setFocusedJobId(job.id);
    setRegeneratingJob(null);
    setError('');
    setNotice(existing ? 'Recovered the saved alternate-layout batch.' : 'Alternate-layout batch created. Your PDFs will appear below.');
  }

  async function recordPrintedProxies(job) {
    if (busy || job.alternateLayoutOf) return;
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
    const punchBatch = printPaperChoice(job) === DAHLE_A4_PRESET;
    const canQueueBatch = capabilities.canQueue && !punchBatch;
    const queueUnavailable = job.state === 'ready' && canQueueBatch ? printPaperUnavailable(job, station) : '';
    const companionWait = mixedPrintCompanionWait(job, station);
    const sourceBatchId = job.alternateLayoutOf?.id;
    const confirmationBatchId = job.confirmationJobId || sourceBatchId;
    const batchLink = (id, label) => <a href={standalone ? `#print-list?batch=${encodeURIComponent(id)}` : `#library/${deckId}?printBatch=${encodeURIComponent(id)}`} onClick={event => {
      if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) setFocusedJobId(id);
    }}>{label} {id.slice(0, 8)}</a>;
    const canConfirm = job.manifestSha256 && !sourceBatchId;
    return <article className="print-panel-card print-batch" key={job.id}>
      <div className="print-panel-heading"><div><h4>{job.deckName || 'Print batch'}</h4><p className="print-panel-meta">{job.totalCopies} cards · {printPaperLabel(job)}{(punchBatch || job.registrationMarks === false) && ` · ${printMarksLabel(job)}`} · Batch {job.id.slice(0, 8)}</p></div><span className={`print-panel-status print-batch-status print-batch-status--${job.state}`}>{STATES[job.state] || job.state}</span></div>
      {sourceBatchId && <p className="print-panel-meta">Alternate layout of {batchLink(sourceBatchId, 'source batch')}. Confirm usable copies on {confirmationBatchId === sourceBatchId ? 'that batch' : batchLink(confirmationBatchId, 'original batch')}.</p>}
      {job.state === 'preparing' && <p>Creating your PDFs{job.progress?.totalSheets ? ` · ${job.progress.completedSheets || 0}/${job.progress.totalSheets} sheets ready` : '…'}</p>}
      {job.state === 'ready' && (punchBatch
        ? <p>Download the PDFs and print at Actual Size (100%). <a href="#guide/dahle-punch">Dahle cutting guide</a></p>
        : <p>Your PDFs are ready. Download them or send this batch to the Mac.</p>)}
      {['queued', 'claimed', 'submitting', 'submitted'].includes(job.state) && <p>{companionWait ? `${companionWait}. Open ` : 'Follow this batch in '}<a href="#print-station">Printer</a>.</p>}
      {job.error && <div className="print-panel-error" role="alert">{job.error}</div>}
      {job.proxyStagingError && <p className="print-panel-error" role="alert">Pending proxy review: {job.proxyStagingError}</p>}
      <WaitingPrintPacket job={job} />
      {job.state === 'uncertain' && <p>The Mac needs to reconcile this batch with Epson’s queue. Check <a href="#print-station">Printer</a> before creating another batch.</p>}
      {job.state === 'completed' && <p>Printing finished according to the spooler. Check the sheets, then confirm the usable copies{sourceBatchId && ' on the original batch'}.</p>}
      {job.state === 'canceled' && job.frontsCompleted && job.backsCanceled > 0 && <p>The fronts finished, and remaining backs were canceled. This job did not print every planned face.</p>}
      {job.cancelRequested && <p>Cancellation requested. Follow any paper-clearance instructions in <a href="#print-station">Printer</a>.</p>}
      {queueUnavailable && <p className="print-panel-meta">{queueUnavailable} You can download the PDFs.</p>}
      <div className="print-panel-actions">
        {job.state === 'ready' && canQueueBatch && <button className="btn btn-primary" type="button" disabled={busy || !!queueUnavailable} onClick={() => jobAction(standalone ? queueStandalonePrintJob : queuePrintJob, job)}>Send to Mac</button>}
        {(job.artifacts || []).filter(a => a.downloadUrl).map(artifact => <button className="btn btn-secondary btn-sm" type="button" key={artifact.id} title={artifact.label || undefined} disabled={!!startingDownload} onClick={() => download(artifact, job)}>{startingDownload === artifact.downloadUrl ? 'Starting download…' : `Download ${artifactName(artifact)} PDF${artifact.kind === 'dfc' ? ' · fronts + backs' : ''}`}</button>)}
        {job.manifestSha256 && <button className="btn btn-secondary btn-sm" type="button" disabled={busy} aria-haspopup="dialog" onClick={() => setRegeneratingJob(job)}>Regenerate with another layout</button>}
        {canConfirm && <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => recordPrintedProxies(job)}>Confirm usable copies</button>}
      </div>
      {recordError?.jobId === job.id && <p className="print-panel-error" role="alert">{recordError.message}</p>}
      {recordingJobId === job.id && <section className="mana-sync" aria-label={`Printed proxies for batch ${job.id}`}>
        <PrintQueue key={job.id} deckId={deckId} printJobId={job.id} />
        <button className="btn btn-secondary btn-sm" type="button" onClick={() => setRecordingJobId(null)}>Close proxy confirmation</button>
      </section>}
      <details className="print-batch-details"><summary>Batch details and options</summary>
        <p className="print-panel-meta">{new Date(job.createdAt).toLocaleString()} · {job.mode === 'adhoc' ? job.comparison?.mode === 'changes' ? 'Compared lists · changes' : 'Independent print list' : job.mode === 'changes' ? `Snapshots #${job.source?.id} → #${job.target?.id}` : `Snapshot #${job.target?.id}`} · {job.artSource === 'saved-mpc' ? job.printingOverrideCount ? 'MPC + selected Scryfall art' : 'Saved MPC artwork' : 'Scryfall artwork'}{job.printingOverrideCount ? ` · ${job.printingOverrideCount} art selections` : ''}</p>
        {canConfirm && <ProxyConfirmationStatus items={confirmationItems.filter(item => item.printJobId === job.id)} />}
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
      <p>{pendingRequest?.mode === 'adhoc' ? pendingRequest.listName.trim() || 'Print list' : `Snapshot #${pendingRequest?.targetSnapshotId}`} · {printPaperLabel(pendingRequest)}{(manualPunch || pendingRequest?.registrationMarks === false) && ` · ${printMarksLabel(pendingRequest)}`} · {pendingAction ? 'Generate and print' : 'Generate PDFs only'}.</p>
      <p>The result is not confirmed. Retry the saved request to recover the same batch without printing twice. Your card list stays locked until it is resolved.</p>
      <button className="btn btn-primary" type="button" disabled={busy} onClick={() => generate(pendingAction)}>Retry same batch request</button>
    </section>}

    <div className="print-prepare-view" hidden={activeView !== 'prepare'}>
    {!!activity.activeCount && <div className="print-active-summary"><span>{activity.activeCount} active {activity.activeCount === 1 ? 'batch' : 'batches'} · {STATES[activeJob.state] || activeJob.state}</span><button type="button" className="print-text-button" onClick={() => setActiveView('batches')}>View batches</button></div>}
    <PrintPaperProof userId={user.id} selectedPaper={selectedPaper} selectedMarks={selectedRegistrationMarks} selectedDahleCutGuides={selectedDahleCutGuides} generator={generator} />
    {editingSource && !creationPending && <form className="print-panel-card print-source" onSubmit={preview}>
      <h3>Choose cards</h3>
      {standalone ? <fieldset className="print-list-inputs" disabled={busy || creationPending}>
        {comparison && <div className="print-comparison-source"><span className="print-panel-status">From Compare</span><p>Your before and after lists are copied here. Your comparison stays unchanged.</p><label className="print-list-name">What to print<select value={comparison.mode} onChange={event => change(setComparison, { ...comparison, mode: event.target.value })}><option value="changes">Added or increased cards</option><option value="full">Whole after list</option></select></label><details><summary>View before list</summary><textarea aria-label="Before list for printing" value={comparison.beforeText} readOnly rows={5} /></details></div>}
        <label className="print-list-name">List name <span className="print-panel-meta">Optional · helps identify this batch at the printer</span><input type="text" value={listName} maxLength={120} placeholder="For example, Jin Sakai" onChange={event => change(setListName, event.target.value, true)} /></label>
        {!comparison && <p className="print-comparison-scope"><strong>Printing the whole list.</strong> Your basic-land and selection options apply below.</p>}
        <DeckInput label={comparison ? 'After list' : 'Cards to print'} value={cardText} onChange={replaceSourceText} onApplyImport={applySourceImport} />
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
      {needsReview && <div className="print-panel-confirmation print-review-dirty" role="status">
        <strong>{pendingArt.length ? `${pendingArt.length} artwork ${pendingArt.length === 1 ? 'choice' : 'choices'} staged` : 'Changes need a fresh review.'}</strong>
        <p>{deckArtConflict ? 'Review the latest deck to check your staged choices.'
          : deckArtChoices.length ? 'Review updated list saves your staged deck choices together and refreshes this batch.'
          : 'Use Review updated list to see the latest artwork and counts.'}</p>
        {!!unavailableArtChoices.length && <p>Artwork choices are unavailable for {unavailableArtChoices.map(choice => choice.displayName).join(', ')}. <button type="button" className="print-text-button" disabled={busy || creationPending} onClick={() => change(setPendingArt, pendingArt.filter(choice => !choice.unavailable), true)}>Discard unavailable choices</button></p>}
      </div>}
      <details className="print-review-edit"><summary>Edit selection{additionalCardText ? ' · extras added' : ''}{removedCards.length ? ` · ${removedCards.length} removed` : ''}</summary><div className="print-review-tools"><details className="print-add-cards"><summary>Add extra cards{additionalCardText ? ' · included' : ''}</summary><label className="print-list-name">Extra cards<textarea aria-label="Extra cards to print" value={additionalCardText} maxLength={100000} rows={4} placeholder={'1 Lightning Bolt\n2 Sol Ring'} disabled={busy || creationPending} onChange={event => change(setAdditionalCardText, event.target.value, true)} /></label><p className="print-panel-meta">Added only to this batch. Edit these lines to remove extra copies.{artSource === 'saved-mpc' && ' Extra cards also need saved MPC art, or switch the whole batch to Scryfall.'}</p></details>
        <details><summary>Selection options{excludeBasicLands ? ' · basics excluded' : ''}{includeSideboard ? ' · sideboard included' : ''}</summary>{options}</details>
        {removedCards.length > 0 && <details className="print-list-removed"><summary>Removed cards ({removedCards.length})</summary><ul>{removedCards.map(card => <li key={card.key}><span>{card.quantity}× {card.name}</span><button type="button" className="btn btn-secondary btn-sm" disabled={busy || creationPending} onClick={() => restoreCard(card.key)}>Include again</button></li>)}</ul></details>}
      </div></details>
      {!!plan.excludedBasicLands?.length && <details className="print-skipped-basics"><summary>{copyCounts.basicCopies} basic-land copies skipped</summary><ul>{plan.excludedBasicLands.map((card, index) => <li key={`${card.selectionKey}:${index}`}>{card.quantity}× {card.displayName}</li>)}</ul><p className="print-panel-meta">To include these copies, open Edit selection → Selection options and clear Exclude basic lands.</p></details>}
      {plan.totalCopies > 0 && <PrintListReview key={plan.planHash} plan={plan} onRemove={removeCard} excludedCards={excludedCards} disabled={busy || creationPending || newDeckVersionNeedsReview} shoppingDisabled={needsReview} printingOverrides={printingOverrides} pendingArt={pendingArt} onPickArt={setSelectedArtCard} onResetArt={resetArt} />}
      {plan.missingArtwork?.length > 0 && <div className="print-panel-error" role="alert">Choose artwork for:{'\n'}{plan.missingArtwork.map(card => `${card.quantity}× ${card.displayName} (${card.face})`).join('\n')}</div>}
      {plan.totalCopies === 0 && <p>No copies remain. Restore removed cards, add extras or change the selection options.</p>}
      {summary?.doubleFaced > 0 && (manualPunch
        ? <p className="print-dfc-note">Print double-faced PDFs with a portrait long-edge flip. Finish both sides before trimming.</p>
        : doubleFacedFirst
        ? <p className="print-dfc-note">Sheets with double-sided cards print first. {summary.ordinary > 0 && 'Single-sided cards fill any open slots on those sheets. '}Set sheets marked <strong>REFEED FOR BACK</strong> aside to dry, then choose their matching backs in <a href="#print-station">Printer</a>.</p>
        : <p className="print-dfc-note">{summary.doubleFaced} double-sided {summary.doubleFaced === 1 ? 'card' : 'cards'} will use {summary.packets} separate labeled {summary.packets === 1 ? 'sheet' : 'sheets'}. With companion 2.55.0 or newer, all fronts print first. Keep those sheets and choose their backs later in Printer. Other front jobs can continue. Older companions keep their original front/back sequence.</p>)}
      {station?.online && stationPaperChoice(station) === selectedPaper && station.duplexVerified === false && summary?.doubleFaced > 0 && <p className="print-panel-meta">Double-sided alignment for {paperPreset.label} is still unverified. Check <a href="#print-station">Printer</a> before continuing.</p>}
      <div className="print-paper-controls">
        {(availablePaper.length > 1 || showPendingPaper) && <>
          <label className="print-list-name">Paper and layout<select value={selectedPaper} disabled={busy || creationPending} onChange={event => change(setPaperOverride, event.target.value, true)}>
            {showPendingPaper && <option value={selectedPaper}>{paperPreset.optionLabel || paperPreset.label}</option>}
            {availablePaper.map(choice => <option key={choice} value={choice}>{PRINT_PAPER[choice].optionLabel || PRINT_PAPER[choice].label}</option>)}
          </select></label>
          <button type="button" className="btn btn-secondary" disabled={busy || creationPending || selectedPaper === defaultPaper} onClick={savePaperDefault}>Save as default</button>
          <span className="print-panel-meta">Browser default: {PRINT_PAPER[defaultPaper].label}</span>
        </>}
        {manualPunch
          ? <label className="print-panel-check"><input type="checkbox" checked={selectedDahleCutGuides} disabled={busy || creationPending} onChange={event => change(setDahleCutGuides, event.target.checked, true)} />Include strip cut lines and R3 corner guides</label>
          : <label className="print-panel-check"><input type="checkbox" checked={selectedRegistrationMarks} disabled={busy || creationPending} onChange={event => setRegistrationMarks(event.target.checked)} />Include Cameo registration marks</label>}
      </div>
      {manualPunch && !creationPending && <p className="print-panel-meta">63 × 88 mm finished cards · {DAHLE_A4_LAYOUT.bleedMm} mm bleed per edge · {DAHLE_A4_LAYOUT.stripSize} row strips. Print the PDFs at 100% and proof one sheet with your punch. <a href="#guide/dahle-punch">Dahle cutting guide</a></p>}
      {selectedPaper === CROWNED_A4_PORTRAIT_SIX_PRESET && <p className="print-panel-meta">Prints six cards in the top two rows, leaving the bottom row free of cards.{selectedRegistrationMarks && <> Get the matching Silhouette Studio cut paths in the <a href="#guide/printing">printing guide</a>.</>}</p>}
      {isCrownedPrintPreset(selectedPaper) && <p className="print-panel-meta">Feed Crowned 313 gsm stock through the Epson Rear Paper Feeder at 100% with Thick Paper and Envelopes enabled. Let the finished sheets cure overnight before cutting or sleeving.</p>}
      {paperUnavailable && <p className="print-panel-meta">{paperUnavailable} You can still generate PDFs.</p>}
      <div className="print-review-footer"><div><strong>
        {plan.totalCopies} {plan.totalCopies === 1 ? 'copy' : 'copies'}
        {summary?.ordinarySheets > 0 && ` · ${summary.ordinarySheets} ${doubleFacedFirst ? 'front-only' : 'single-sided'} ${summary.ordinarySheets === 1 ? 'sheet' : 'sheets'}`}
        {summary?.packets > 0 && (doubleFacedFirst
          ? ` · ${summary.packets} ${summary.packets === 1 ? 'sheet' : 'sheets'} to flip`
          : ` · ${summary.packets} double-sided ${summary.packets === 1 ? 'sheet' : 'sheets'}`)}
      </strong><span>{reviewedPaper.label} · {printPaperChoice(plan) === DAHLE_A4_PRESET ? printMarksLabel(plan) : selectedRegistrationMarks ? `${reviewedPaper.templateVersion || reviewedPaper.template} cut template` : 'No registration marks'}</span></div><div className="print-panel-actions">
        {needsReview ? <button type="button" className="btn btn-primary" disabled={busy || creationPending} onClick={preview}>{busy ? 'Checking artwork…' : deckArtConflict ? 'Review latest deck' : 'Review updated list'}</button> : <><button className={`btn ${canQueueSelectedPaper && !paperUnavailable ? 'btn-secondary' : 'btn-primary'}`} disabled={busy || !generator?.available || !printReviewReady(plan) || pendingAction === true} onClick={() => generate(false)} type="button">Generate PDFs</button>{canQueueSelectedPaper && <button className="btn btn-primary" disabled={busy || !!paperUnavailable || !generator?.available || !printReviewReady(plan) || pendingAction === false} onClick={() => generate(true)} type="button">Generate & print</button>}</>}
      </div></div>
    </section>}

    </div>
    <section className="print-batches-view" hidden={activeView !== 'batches'} aria-label={standalone ? 'Print-list batches' : 'This deck’s batches'}>
      <p className="print-panel-meta"><a href="#print-station">View all batches at the Printer</a></p>
      <div className="print-panel-heading"><div><h3>{standalone ? 'Print-list batches' : 'This deck’s batches'}</h3><p className="print-panel-meta">{standalone ? 'Batches created from card lists here. Deck batches remain in each deck’s Print tab.' : 'PDFs, printer progress and usable-copy confirmations for this deck.'}</p></div><button className="btn btn-secondary btn-sm" type="button" disabled={busy || creationPending} onClick={openPrepare}>{plan ? 'Return to review' : 'Prepare another batch'}</button></div>
      <button className="btn btn-secondary btn-sm" type="button" onClick={() => setRefreshRevision(value => value + 1)}>Refresh batches</button>
      {historyError && <p role="status">Batch history could not refresh: {historyError}</p>}
      {confirmationError && <p role="status">ManaSync confirmation records could not refresh: {confirmationError}</p>}
      {prominentJob && <section className="print-panel-jobs" aria-label="Current print batch">{renderJob(prominentJob)}</section>}
      {!!historyJobs.length && <details className="print-history" open={!prominentJob || undefined}><summary>Other print batches ({historyJobs.length})</summary><div className="print-panel-jobs">{historyJobs.map(renderJob)}</div></details>}
      {!jobs.length && (historyLoaded ? <p>No batches yet. Prepare a list and review its artwork to get started.</p> : !historyError && <p role="status">Loading print batches…</p>)}
    </section>

    <details className="print-help" aria-label="PDF generator status"><summary>{generator?.available ? 'PDF setup' : generator?.updating ? 'Preparing the PDF generator…' : 'PDF generator unavailable'}</summary>
      <p>{generator?.available ? manualPunch ? `Dahle 550 strip cuts · ${DAHLE_A4_LAYOUT.bleedMm} mm output bleed · 9 cards per sheet.` : `Silhouette Card Maker ${generator.revision?.slice(0, 8)} · ${paperPreset.template} · 600 PPI · 1 mm crop · ${paperPreset.cardsPerSheet} cards per sheet.` : 'CLC needs a working Silhouette Card Maker installation. Check the server setup or restart to retry the update.'}</p>
      {generator?.fallbackReason && <p>{generator.fallbackReason}</p>}
      <p>{manualPunch ? 'Open an artwork thumbnail to enlarge it. Use the exported PDF to check the actual printed layout.' : 'Open an artwork thumbnail to enlarge it; the PDF applies the household crop. Double-sided packets are handled in Printer.'}</p>

      {!capabilities.stationConfigured && <p>PDF downloads work without a printer. Configure the Mac companion to enable the household queue.</p>}
      {capabilities.stationConfigured && !capabilities.canQueue && <p>Your administrator can enable household queue access. You can still download PDFs.</p>}
      <a href="#print-station">Open Printer</a>
    </details>
    {selectedArtCard && <PrintArtPicker card={selectedArtCard} currentScryfallId={selectedArtChoice?.scryfallId || printingOverrides.find(item => item.selectionKey === selectedArtCard.selectionKey)?.scryfallId || selectedArtCard.scryfallId} stagedSaveToDeck={selectedArtChoice?.saveToDeck} onChoose={pickArt} onClose={() => setSelectedArtCard(null)} canSaveToDeck={canSaveArtToDeck} disabled={busy || creationPending || newDeckVersionNeedsReview} />}
    {regeneratingJob && <PrintRegenerationDialog job={regeneratingJob} deckId={deckId} availablePaper={availablePaper} onClose={() => setRegeneratingJob(null)} onCreated={showRegeneratedJob} />}
  </div>;
}
