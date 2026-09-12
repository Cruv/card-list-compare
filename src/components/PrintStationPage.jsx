import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import Icon from './Icon';
import PrintBatchList from './PrintBatchList';
import DeferredPrintBacks from './DeferredPrintBacks';
import { getPrintStationStatus, sendPrintStationCommand, configurePrintStationDiscord, testPrintStationDiscord, findPrintStationCommand, preparePrintJobBacks, cancelPrintJobBacks } from '../lib/api';
import { PRINT_JOB_STATES as JOB_STATES, printerHealthPresentation, printStationSummary, paperClearanceIdentity } from '../lib/printStationStatus';
import './PrintStationPage.css';

const COMMAND_NAMES = {
  pause: 'Pause station', unpause: 'Unpause station', resume: 'Print reloaded backs',
  clear_paper: 'Confirm paper cleared',
  configure_discord: 'Save Discord settings', test_discord: 'Send Discord test',
  check_update: 'Check for updates', update: 'Update companion', rollback: 'Roll back companion',
};
const isDiscordCommand = type => ['configure_discord', 'test_discord'].includes(type);
const COMMAND_STATES = { pending: 'Pending', applied: 'Applied', rejected: 'Rejected', expired: 'Expired' };
const UPDATE_STATES = {
  unsupported: 'Managed updates unavailable', idle: 'Idle', checking: 'Checking for updates',
  available: 'Update available', updating: 'Installing update', rollback: 'Rolling back',
  failed: 'Update needs attention',
};

function requestId() {
  // randomUUID is unavailable on some household HTTP origins.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readPending(key) {
  try {
    const value = JSON.parse(sessionStorage.getItem(key));
    return value && COMMAND_NAMES[value.type] && typeof value.idempotencyKey === 'string' ? value : null;
  } catch { return null; }
}

function timestamp(value) {
  if (!value) return 'Not reported';
  const normalized = typeof value === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? 'Not reported' : date.toLocaleString();
}

function Badge({ children, tone = 'neutral' }) {
  return <span className={`station-badge station-badge--${tone}`}>{children}</span>;
}

function ProofFlag({ verified, children }) {
  return <li><span aria-hidden="true">{verified ? '✓' : '○'}</span><span>{children}</span><Badge tone={verified ? 'good' : 'warning'}>{verified ? 'Verified on the Mac' : 'Not verified'}</Badge></li>;
}

export default function PrintStationPage() {
  const { user } = useAuth();
  const storageKey = `clc-station-request-${user.id}`;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState('');
  const [restricted, setRestricted] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [clock, setClock] = useState(Date.now);
  const [visible, setVisible] = useState(() => !document.hidden);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingRequest, setPendingRequest] = useState(() => readPending(storageKey));
  const [resumeJobId, setResumeJobId] = useState(null);
  const [resumeArtifactId, setResumeArtifactId] = useState(null);
  const [paperReloaded, setPaperReloaded] = useState(false);
  const [paperClearedBoundary, setPaperClearedBoundary] = useState(null);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [discordUserId, setDiscordUserId] = useState('');
  const [editingDiscord, setEditingDiscord] = useState(false);
  const pendingRef = useRef(pendingRequest);
  const mountedRef = useRef(false);
  const commandControllerRef = useRef(null);
  const refreshRef = useRef(() => {});

  useEffect(() => {
    mountedRef.current = true;
    let timer;
    let controller;
    let generation = 0;

    function reconcilePending(commands) {
      if (!pendingRef.current) return;
      const receipt = commands.find(command => command.idempotencyKey === pendingRef.current.idempotencyKey);
      if (!receipt) return;
      pendingRef.current = null;
      try { sessionStorage.removeItem(storageKey); } catch { /* A receipt is already visible. */ }
      setPendingRequest(null);
      setActionError('');
      setNotice(`${COMMAND_NAMES[receipt.type] || 'Station'} request found. See Recent requests for the Mac’s acknowledgement.`);
    }

    async function poll() {
      clearTimeout(timer);
      controller?.abort();
      if (!mountedRef.current || document.hidden) return;
      controller = new AbortController();
      const current = ++generation;
      try {
        const next = await getPrintStationStatus(controller.signal);
        if (!mountedRef.current || current !== generation || document.hidden) return;
        if (!next.station || !next.permissions) throw new Error('The server returned incomplete station status.');
        setData(next);
        setFetchedAt(Date.now());
        setClock(Date.now());
        setConnectionError('');
        setRestricted(false);
        reconcilePending(next.commands || []);
        // A navigation-safe recovery record contains no webhook. Look up old
        // operations directly even after they fall out of the latest 20 entries.
        const waiting = pendingRef.current;
        if (waiting && isDiscordCommand(waiting.type)) {
          const found = await findPrintStationCommand(waiting.idempotencyKey, controller.signal);
          if (mountedRef.current && current === generation && !document.hidden && found.command) reconcilePending([found.command]);
        }
      } catch (err) {
        if (!mountedRef.current || current !== generation || err.name === 'AbortError' || document.hidden) return;
        setConnectionError(err.message);
        if (err.status === 403) {
          setRestricted(true);
          setData(null);
        }
      } finally {
        if (mountedRef.current && current === generation && !document.hidden) {
          setLoading(false);
          timer = setTimeout(poll, 5000);
        }
      }
    }

    function visibilityChanged() {
      setVisible(!document.hidden);
      setFetchedAt(0);
      clearTimeout(timer);
      controller?.abort();
      generation += 1;
      if (!document.hidden) poll();
    }

    refreshRef.current = poll;
    document.addEventListener('visibilitychange', visibilityChanged);
    const clockTimer = setInterval(() => { if (!document.hidden) setClock(Date.now()); }, 1000);
    poll();
    return () => {
      mountedRef.current = false;
      generation += 1;
      controller?.abort();
      commandControllerRef.current?.abort();
      clearTimeout(timer);
      clearInterval(clockTimer);
      document.removeEventListener('visibilitychange', visibilityChanged);
      refreshRef.current = () => {};
    };
  }, [storageKey]);

  const station = data?.station;
  const commands = data?.commands || [];
  const events = data?.events || [];
  const fresh = !!data && visible && !connectionError && fetchedAt > 0 && clock - fetchedAt < 15_000;
  const online = fresh && station?.online === true;
  const commandWaiting = commands.some(command => command.status === 'pending');
  const canControl = online && data?.permissions.canControl && !busy && !pendingRequest && !commandWaiting;
  const activeJob = station?.activeJob;
  const deferredWorkflow = activeJob?.workflow === 'deferred-backs-v1';
  const packet = activeJob?.packet;
  const packetName = packet?.label ? `Packet ${packet.packetIndex} of ${packet.packetCount}` : 'Legacy double-faced PDF';
  const sheetWord = packet?.sheetCount === 1 ? 'sheet' : 'sheets';
  const canResume = canControl && !station.paused && !activeJob?.cancelRequested && activeJob?.state === 'awaiting_refeed'
    && !!activeJob.artifactId && packet?.artifactId === activeJob.artifactId;
  const matchingResume = activeJob?.id === resumeJobId && activeJob?.artifactId === resumeArtifactId;
  const needsPaperClearance = ['awaiting_clearance', 'awaiting_paper_reset'].includes(activeJob?.state);
  const clearanceBoundary = paperClearanceIdentity(activeJob);
  const canClearPaper = canControl && !!clearanceBoundary && paperClearedBoundary === clearanceBoundary;
  const deferredJobs = Array.isArray(data?.jobs?.deferred) ? data.jobs.deferred : [];
  const backPreparationUnavailable = !fresh ? 'Refresh status before selecting saved backs.' : !online ? 'The Mac must be online before you select backs.'
    : !data?.permissions.canControl ? 'Household printer access is required to select saved backs.' : station.paused ? 'Unpause the station before selecting backs.'
      : busy || pendingRequest || commandWaiting ? 'Wait for the current request to finish before selecting another packet.' : '';
  const update = station?.update;
  const updateBusy = ['checking', 'updating', 'rollback'].includes(update?.status);
  const canCheckUpdate = canControl && data?.permissions.canUpdate && update?.supported && !updateBusy;
  const canUpdate = canCheckUpdate && !activeJob;
  const nextVersion = update?.availableVersion;
  const currentVersion = update?.currentVersion || station?.version;
  const discord = station?.discord;
  const canManageDiscord = canControl && data?.permissions.canUpdate && discord?.supported;
  const discordPending = commands.some(item => isDiscordCommand(item.type) && item.status === 'pending');
  const canRetryDiscord = online && data?.permissions.canUpdate && discord?.supported && !busy && !commandWaiting;
  const connectionLabel = loading && !data ? 'Connecting' : !fresh ? 'Status unavailable' : station.online ? 'Online' : 'Offline';
  const health = printerHealthPresentation(station?.health, online);
  const stationSummary = printStationSummary(station, { fresh, online, loading });

  async function submit(command) {
    if (commandControllerRef.current) return;
    setBusy(true);
    setActionError('');
    setNotice('');
    const controller = new AbortController();
    commandControllerRef.current = controller;
    try {
      // Persist before sending: navigation or a lost response must reuse this exact request.
      sessionStorage.setItem(storageKey, JSON.stringify(command));
      pendingRef.current = command;
      setPendingRequest(command);
      const result = await sendPrintStationCommand(command, controller.signal);
      if (!mountedRef.current) return;
      sessionStorage.removeItem(storageKey);
      pendingRef.current = null;
      setPendingRequest(null);
      setResumeJobId(null);
      setResumeArtifactId(null);
      setPaperReloaded(false);
      setPaperClearedBoundary(null);
      setNotice(`${COMMAND_NAMES[command.type]} request received. See Recent requests for the Mac’s acknowledgement.`);
      setData(old => old ? { ...old, commands: [result.command, ...(old.commands || []).filter(item => item.id !== result.command.id)].slice(0, 20) } : old);
      refreshRef.current();
    } catch (err) {
      if (!mountedRef.current) return;
      if (err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status)) {
        pendingRef.current = null;
        setPendingRequest(null);
        try { sessionStorage.removeItem(storageKey); } catch { /* No request was accepted. */ }
      }
      setActionError(err.message);
      refreshRef.current();
    } finally {
      commandControllerRef.current = null;
      if (mountedRef.current) setBusy(false);
    }
  }

  async function submitDiscord(request) {
    if (commandControllerRef.current) return;
    setBusy(true); setActionError(''); setNotice('');
    const controller = new AbortController();
    commandControllerRef.current = controller;
    // Only these nonsecret fields may survive navigation or an uncertain reply.
    const recovery = { idempotencyKey: request.idempotencyKey, type: request.type,
      ...(request.type === 'configure_discord' ? { enabled: request.enabled, userId: request.userId } : { revision: request.revision }) };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(recovery));
      pendingRef.current = recovery; setPendingRequest(recovery);
      setWebhookUrl('');
      const response = request.type === 'configure_discord'
        ? await configurePrintStationDiscord(request, controller.signal)
        : await testPrintStationDiscord(request, controller.signal);
      if (!mountedRef.current) return;
      if (!response.command?.id || response.command.type !== request.type || response.command.idempotencyKey !== request.idempotencyKey) {
        throw new Error('The Discord request acknowledgement was incomplete. Its original request ID has been kept.');
      }
      sessionStorage.removeItem(storageKey);
      pendingRef.current = null; setPendingRequest(null); setEditingDiscord(false);
      setNotice(request.type === 'test_discord' ? 'Test requested. Wait for the Mac’s confirmation below before trying again.'
        : request.enabled ? 'Discord settings saved for the Mac. Connection is confirmed after the Mac applies them.' : 'Disconnect requested. Waiting for the Mac to apply it.');
      setData(old => old ? { ...old, commands: [response.command, ...(old.commands || []).filter(item => item.id !== response.command.id)].slice(0, 20) } : old);
      refreshRef.current();
    } catch (error) {
      if (!mountedRef.current) return;
      // Authentication, conflicts and network errors do not prove an earlier
      // attempt was absent. Retain its identity without retaining its secret.
      if (error.status === 400) {
        pendingRef.current = null; setPendingRequest(null);
        try { sessionStorage.removeItem(storageKey); } catch { /* Validation rejected this request. */ }
      }
      setActionError(error.message); refreshRef.current();
    } finally {
      commandControllerRef.current = null;
      if (mountedRef.current) setBusy(false);
    }
  }

  function saveDiscord(enabled) {
    if (!canManageDiscord) return;
    submitDiscord({ idempotencyKey: requestId(), type: 'configure_discord', enabled,
      webhookUrl: enabled ? webhookUrl.trim() : '', userId: enabled ? discordUserId.trim() : '' });
  }

  function retryDiscord() {
    const request = pendingRef.current;
    if (!request || !isDiscordCommand(request.type) || !canRetryDiscord) return;
    submitDiscord({ ...request, ...(request.type === 'configure_discord' ? { webhookUrl: request.enabled ? webhookUrl.trim() : '' } : {}) });
  }

  function command(type, extra = {}) {
    if (!canControl || pendingRef.current) return;
    if (type === 'resume' && (!canResume || !paperReloaded || !matchingResume)) return;
    if (type === 'clear_paper' && !canClearPaper) return;
    if (type === 'check_update' && !canCheckUpdate) return;
    if (['update', 'rollback'].includes(type) && !canUpdate) return;
    submit({ idempotencyKey: requestId(), type, ...extra });
  }

  async function backAction(type, job, selectedPacket) {
    if (commandControllerRef.current || !fresh || busy || pendingRef.current) return;
    if (type === 'prepare_backs' && (!canControl || !job.canPrepareBacks || !selectedPacket)) return;
    if (type === 'cancel_backs' && !job.canCancelBacks) return;
    const controller = new AbortController();
    commandControllerRef.current = controller;
    setBusy(true); setActionError(''); setNotice('');
    try {
      await (type === 'prepare_backs' ? preparePrintJobBacks(job.id, selectedPacket.artifactId, controller.signal) : cancelPrintJobBacks(job.id, controller.signal));
      if (!mountedRef.current) return;
      setNotice(type === 'prepare_backs'
        ? `Backs requested for ${job.deckName || 'Card batch'} · ${selectedPacket.label || selectedPacket.artifactId}. Keep blank paper loaded until the matching packet is ready to reload.`
        : `Cancellation requested for the remaining backs of ${job.deckName || 'Card batch'}. Check its status and follow any paper-clearance instructions.`);
    } catch (error) {
      if (mountedRef.current) setActionError(`The request could not be confirmed for batch ${job.id}. ${error.message} Check the refreshed status before retrying this same packet or cancellation.`);
    } finally {
      commandControllerRef.current = null;
      if (mountedRef.current) { setBusy(false); refreshRef.current(); }
    }
  }

  return (
    <section className="station-page">
      <header className="page-heading station-header">
        <div><h1>Printer</h1><p>Follow the household printer and handle sheets that need your attention.</p></div>
        <button className="btn btn-secondary" type="button" onClick={() => refreshRef.current()}><Icon name="refresh" size={17} />Refresh status</button>
      </header>

      {restricted ? <section className="station-card station-restricted"><h2>Household access required</h2><p>Your account does not have access to this print station. Ask the administrator to enable household printing for your account.</p><p className="station-small">{connectionError}</p><a href="#library">Return to your decks</a></section> : <>
        {connectionError && <div className="station-message station-message--error" role="alert"><strong>Station status could not refresh.</strong> {connectionError} Controls are disabled until status is current.</div>}
        {actionError && <div className="station-message station-message--error" role="alert">{actionError}</div>}
        {notice && <p className="station-message" role="status">{notice}</p>}
        {pendingRequest && !busy && <section className="station-message station-message--warning" aria-label="Request recovery"><strong>Checking the result of {COMMAND_NAMES[pendingRequest.type]?.toLowerCase()}.</strong><p>If the request is missing from recent activity, retry this same request. It keeps its original ID to prevent a duplicate action.</p>{pendingRequest.type === 'configure_discord' && pendingRequest.enabled && <label className="station-discord-field">Re-enter the same webhook URL to retry. It was not saved in this browser.<input type="password" autoComplete="off" spellCheck={false} value={webhookUrl} onChange={event => setWebhookUrl(event.target.value)} maxLength={340} /></label>}<button className="btn btn-secondary" type="button" disabled={isDiscordCommand(pendingRequest.type) ? !canRetryDiscord || (pendingRequest.type === 'configure_discord' && pendingRequest.enabled && !webhookUrl.trim()) : !online || !data?.permissions.canControl} onClick={() => isDiscordCommand(pendingRequest.type) ? retryDiscord() : submit(pendingRequest)}>Retry same request</button></section>}

        {station?.testPrintingEnabled === true && <section className="station-message station-message--warning" aria-label="Test printing enabled">
          <h2>Test printing enabled</h2>
          <p>{station.recipeVerified && station.duplexVerified ? 'The Mac permits queued test jobs with its current proof settings.' : 'Physical proofs remain unverified. The Mac permits queued jobs to print for testing with the current settings.'} Pausing still stops new station work.</p>
          <p>Double-faced cards still require you to flip and reload the matching sheet, then explicitly confirm its back pass. Inspect each test sheet before continuing.</p>
          <p className="station-small">This setting is controlled locally on the Mac. It does not mark either physical proof as verified.{!online && ' This is the last reported setting; the station is not currently confirmed online.'}</p>
        </section>}


        <section className="station-card station-overview" aria-label="Station connection">
          <div className="station-card-heading"><div className="station-device"><span className="station-device-icon"><Icon name="station" size={27} /></span><div><strong>{station?.stationId || 'Household Mac'}</strong><p className="station-small">Last seen: {timestamp(station?.lastSeenAt)}</p></div></div><Badge tone={online ? 'good' : fresh ? 'warning' : 'neutral'}>{connectionLabel}</Badge></div>
          <h2 className="station-readiness">{stationSummary}</h2>
          <div className={`station-printer-health station-printer-health--${health.tone}`} aria-label="Printer status">
            <strong>{health.label}</strong>
            <p>{health.message}</p>
          </div>
          {health.advisories.length > 0 && <section className="station-printer-advisories" aria-label="Printer information">
            <strong>Printer information</strong>
            <ul>{health.advisories.map(message => <li key={message}>{message}</li>)}</ul>
          </section>}
          {!loading && !station?.lastSeenAt && fresh && <p>The Mac has not checked in yet. Start the configured companion on the Mac to connect it.</p>}
          {!fresh && data && <p className="station-small">Showing the last received details. Connection and controls will return after a successful refresh.</p>}
          {fresh && !station.online && station.lastSeenAt && <p>The Mac is not checking in. It may be asleep, disconnected, or the companion may be stopped.</p>}
          <p className="station-small">{station?.queue || 'Printer not reported'} · {station?.version || 'Companion version not reported'}</p>
          <div className="station-actions"><button className="btn btn-secondary" type="button" disabled={!canControl || updateBusy} onClick={() => command(station?.paused ? 'unpause' : 'pause')}>{busy ? 'Sending request…' : station?.paused ? 'Unpause station' : 'Pause station'}</button></div><details className="station-pause-help"><summary>About pausing</summary><p className="station-small">Pausing stops new station work. Pages already sent to Epson keep printing.</p></details>
          {commandWaiting && <p className="station-small" role="status">A request is waiting for the Mac. Controls return when it is applied, rejected or expires.</p>}
        </section>

        {needsPaperClearance ? <section className="station-card station-refeed" aria-label="Clear the printer paper">
          <h2>{activeJob.state === 'awaiting_clearance' ? 'Remove canceled-job paper' : 'Backs finished — restore blank paper'}</h2>
          <h3>{activeJob.deckName || 'Card batch'}</h3><p className="station-batch-id">Batch {activeJob.id}</p>
          <p>{activeJob.state === 'awaiting_clearance' ? 'Wait for the printer to stop. Remove any partially printed or flipped sheets from this job and clear the rear feeder.' : 'Remove the finished double-sided sheet and any remaining flipped paper from the rear feeder.'} Load only blank paper before releasing the next front job.</p>
          <label className="station-paper-check"><input type="checkbox" checked={!!clearanceBoundary && paperClearedBoundary === clearanceBoundary} disabled={!canControl || !clearanceBoundary} onChange={event => setPaperClearedBoundary(event.target.checked ? clearanceBoundary : null)} /><span>I removed the printed or flipped paper, checked the printer has stopped, and left only blank paper in the rear feeder.</span></label>
          <button className="btn btn-primary" type="button" disabled={!canClearPaper} onClick={() => command('clear_paper', { jobId: activeJob.id, clearanceId: activeJob.clearanceId, paperCleared: true })}>Confirm blank paper is ready</button>
          {!clearanceBoundary && <p className="station-small">The Mac has not confirmed which paper-clearance step is waiting. Refresh status before confirming.</p>}
          <p className="station-small">The Mac checks the previous submission before releasing more pages. This does not restart a canceled pass.{station.paused && ' The station remains paused.'}</p>
        </section> : activeJob?.state === 'awaiting_refeed' ? <section className="station-card station-refeed" aria-label="Paper reload required">
          <h2>{packet ? `Flip and reload ${packet.sheetCount} ${sheetWord}` : 'Paper reload is waiting'}</h2>
          <h3>{activeJob.deckName || 'Card batch'}{packet ? ` · ${packetName}` : ''}</h3>
          <p className="station-batch-id">Batch {activeJob.id}</p>
          {packet ? <>
            {packet.label ? <p className="station-batch-id"><strong>Match the printed margin label: {packet.label}</strong></p>
              : <p>This older PDF has no saved packet label. Match all {packet.sheetCount} {sheetWord} against this batch’s downloaded double-faced PDF before continuing.</p>}
            <p>Set aside the other completed output and remove unused blank paper from the rear feeder. Reload only {packet.sheetCount === 1 ? 'this matching sheet' : `these ${packet.sheetCount} matching sheets`}, following {station.testPrintingEnabled && !station.duplexVerified ? 'the flip direction and page order you are testing' : 'your verified flip direction and page order'}. This packet contains {packet.cardCount} {packet.cardCount === 1 ? 'card' : 'cards'}.</p>
            <p>This selected back pass has reserved the printer. Other CLC jobs wait while you reload it. Confirm below only after the matching paper is loaded.</p>
            <p>{deferredWorkflow ? 'After its back pass finishes, remove the printed sheet and confirm blank paper is ready before other front jobs resume.' : 'This older job uses its saved alternating front/back sequence. Restore blank paper immediately after its backs finish for the next front pass.'}</p>
            {(!resumeJobId || !matchingResume) && <button className="btn btn-primary" type="button" disabled={!canResume} onClick={() => { setResumeJobId(activeJob.id); setResumeArtifactId(activeJob.artifactId); setPaperReloaded(false); }}>Confirm this paper is reloaded</button>}
          </> : <p>The waiting sheet details could not be verified. Refresh status before reloading or resuming.</p>}
          {!fresh && <p>Status is stale. Wait for a successful refresh before handling this packet.</p>}
          {station.paused && <p>Unpause the station before confirming this reloaded packet.</p>}
          {resumeJobId && <section className="station-refeed" aria-label="Confirm reloaded batch"><h3>Confirm the paper at the printer</h3>{!matchingResume && <p className="station-batch-id">Batch {resumeJobId}<br />Back pass: {resumeArtifactId}</p>}{!matchingResume && <p>This is no longer the waiting pass. Check the current batch before resuming.</p>}<label><input type="checkbox" autoFocus checked={paperReloaded && matchingResume} onChange={event => setPaperReloaded(event.target.checked)} disabled={!canResume || !matchingResume} /><span>I matched this packet to the completed output, then flipped and reloaded only its {packet?.sheetCount === 1 ? 'sheet' : 'sheets'} into the rear feeder using {station.testPrintingEnabled && !station.duplexVerified ? 'the direction and page order I am testing' : 'the verified direction and page order'}.</span></label><div className="station-actions"><button className="btn btn-primary" type="button" disabled={!canResume || !matchingResume || !paperReloaded} onClick={() => command('resume', { jobId: resumeJobId, artifactId: resumeArtifactId, paperReloaded: true })}>Confirm and print this packet’s backs</button><button className="btn btn-secondary" type="button" onClick={() => { setResumeJobId(null); setResumeArtifactId(null); setPaperReloaded(false); }}>Cancel</button></div></section>}
        </section> : <section className="station-card" aria-label="Current print batch">
            <div className="station-card-heading"><h2>Current batch</h2>{activeJob && <Badge tone={activeJob.state === 'uncertain' ? 'warning' : 'neutral'}>{JOB_STATES[activeJob.state] || activeJob.state}</Badge>}</div>
            {activeJob ? <><h3>{activeJob.deckName || 'Card batch'}</h3><p className="station-batch-id">Batch {activeJob.id}</p>
              {packet && <><p><strong>{packetName}</strong> · {packet.sheetCount} {sheetWord} · {packet.cardCount} cards</p>{packet.label && <p className="station-batch-id">Margin label: {packet.label}</p>}</>}
              {packet && activeJob.phase === 'fronts' && <p>{deferredWorkflow ? 'This is a front pass. Keep blank paper in the rear feeder and save the labeled sheet for its backs later. Other front jobs continue.' : 'This older job keeps its original front/back sequence. Keep blank paper loaded and follow its next reload instruction.'}</p>}
              {activeJob.cancelRequested && <p role="status">Cancellation requested. Wait for the Mac to stop affected pages before clearing any paper.</p>}
              {activeJob.state === 'uncertain' && <p className="station-message station-message--warning">Check this batch against Epson’s queue at the Mac. Reconcile the existing submission before sending any more pages.</p>}
              <p className="station-small">Spooler completion does not confirm color, sheet alignment or cutting readiness.</p>
            </> : <div className="station-empty-batch"><Icon name="print" size={32} /><p>{fresh ? 'No active batch reported by the Mac.' : 'Refresh status to confirm the current batch.'}</p><span className="station-small">Your next batch appears here when the Mac picks it up.</span></div>}
          </section>}

        <DeferredPrintBacks jobs={deferredJobs} fresh={fresh} canPrepare={canControl && !station?.paused} unavailableReason={backPreparationUnavailable} busy={busy || !!pendingRequest || commandWaiting} onAction={backAction} />
      </>}
      <PrintBatchList />
      {!restricted && <>

        <section className="station-settings" aria-label="Printer settings"><h2>Printer settings</h2>
          <details className="station-card station-management" aria-label="Print recipe and physical checks">
            <summary><span className="station-disclosure-title"><Icon name="settings" size={22} /><span>Print recipe<small>Color, layout and manual flip checks</small></span></span><Badge tone={online && station?.recipeVerified && station?.duplexVerified ? 'good' : 'neutral'}>{!online ? 'Not confirmed' : station.recipeVerified && station.duplexVerified ? 'Checks verified' : 'Checks pending'}</Badge></summary><div className="station-disclosure-content">
            <details className="station-proof-details"><summary>Physical print checks <span>{station?.recipeVerified === true && station?.duplexVerified === true ? '2 verified' : 'Review verification'}</span></summary><ul className="station-proofs"><ProofFlag verified={station?.recipeVerified === true}>Color and front layout</ProofFlag><ProofFlag verified={station?.duplexVerified === true}>Manual double-faced layout</ProofFlag></ul></details>
            {online && station?.duplexVerified === false && <p className="station-message station-message--warning">{station.testPrintingEnabled ? 'Use a small double-faced test batch to verify the manual flip direction, page order and alignment. Test printing still stops for your explicit paper reload confirmation.' : 'Verify the manual flip direction, page order and alignment on the Mac before sending a batch with double-faced cards. A mixed batch can otherwise stop after its ordinary fronts.'}</p>}
            <p className="station-small">Proofs are recorded on the Mac after physical testing. They cannot be changed here.</p>
            {station?.recipeFingerprint && <details><summary>Recipe fingerprint</summary><p className="station-fingerprint">{station.recipeFingerprint}</p></details>}
          </div></details>

        <details className="station-card station-management station-discord" aria-label="Discord notifications">
          <summary><span className="station-disclosure-title"><Icon name="connections" size={22} /><span>Discord printer alerts<small>Job completions, paper flips and printer errors</small></span></span><Badge tone={discord?.lastTest?.status && discord.lastTest.status !== 'confirmed' ? 'warning' : online && discord?.configured && !discordPending ? 'good' : 'neutral'}>{discord?.lastTest?.status && discord.lastTest.status !== 'confirmed' ? 'Test needs review' : discordPending ? 'Waiting for the Mac' : !fresh ? 'Status unavailable' : discord?.supported ? discord.configured ? online ? 'Connected' : 'Last reported connected' : 'Not connected' : 'Companion update required'}</Badge></summary><div className="station-disclosure-content">
          <p>With companion 2.54.0 or newer, get completion updates naming the job after the Mac confirms all its print passes are complete. Completion and test messages never mention you directly; personal mentions are reserved for alerts that need your help. Earlier completed jobs are not announced again.</p>
          <p>With companion 2.55.0 or newer, fronts-finished updates say when backs are saved for later without mentioning you. A packet you select alerts you when it is safe to reload; after its backs print, an alert asks you to restore blank paper. Those paper tasks and reported printer errors may directly mention you.</p>
          <p>Reload only the matching selected packet and confirm before its backs print. Repeated faults are quiet until the printer recovers; unknown or unavailable status does not count as recovery. Completion confirms the spooler result; check the physical sheets before using the cards.</p>
          {discord?.configured && <p className="station-small">{discord.managed ? 'Settings are managed here.' : 'The Mac is using its local Discord configuration.'} {discord.userId ? `Discord user ${discord.userId} is mentioned only when help is needed (companion 2.54.0 or newer).` : 'Messages do not mention a specific user.'}{!online && ' This is the last reported configuration; the Mac is not currently confirmed online.'}</p>}
          {discord?.lastTest && <p className={`station-message${discord.lastTest.status === 'confirmed' ? '' : ' station-message--warning'}`} role="status">{discord.lastTest.status === 'confirmed' ? 'Discord confirmed the test message.' : 'The test was not confirmed. Check Discord before requesting another test; it will not retry automatically.'} <span className="station-small">{timestamp(discord.lastTest.at)}</span></p>}
          {!discord?.supported && <p className="station-small">Install a companion version that supports managed Discord settings, then refresh this page.</p>}
          {data?.permissions.canUpdate ? <>
            {(editingDiscord || !discord?.configured) && !pendingRequest && <form className="station-discord-form" onSubmit={event => { event.preventDefault(); saveDiscord(true); }}>
              <label className="station-discord-field">Discord webhook URL<input type="password" value={webhookUrl} onChange={event => setWebhookUrl(event.target.value)} autoComplete="off" spellCheck={false} placeholder="https://discord.com/api/webhooks/…" maxLength={340} required disabled={!canManageDiscord} /></label>
              <label className="station-discord-field">Discord user ID for help <span className="station-small">Optional: mention this person when paper or printer help is needed</span><input type="text" inputMode="numeric" value={discordUserId} onChange={event => setDiscordUserId(event.target.value)} autoComplete="off" pattern="[1-9][0-9]{0,19}" maxLength={20} placeholder="Numeric user ID" disabled={!canManageDiscord} /></label>
              <div className="station-actions"><button className="btn btn-primary" type="submit" disabled={!canManageDiscord || !webhookUrl.trim()}>{discord?.configured ? 'Save Discord connection' : 'Connect Discord'}</button>{editingDiscord && <button className="btn btn-secondary" type="button" onClick={() => { setEditingDiscord(false); setWebhookUrl(''); }}>Cancel</button>}</div>
              <p className="station-small">The webhook is a secret. It is sent to your Mac through CLC and is never shown again here. Saving does not send a message.</p>
            </form>}
            <div className="station-actions">{discord?.configured && !editingDiscord && <button className="btn btn-secondary" type="button" disabled={!canManageDiscord} onClick={() => { setDiscordUserId(discord.userId || ''); setWebhookUrl(''); setEditingDiscord(true); }}>Change connection</button>}<button className="btn btn-secondary" type="button" disabled={!canManageDiscord || !discord?.configured || !discord?.revision} onClick={() => submitDiscord({ idempotencyKey: requestId(), type: 'test_discord', revision: discord.revision })}>Send test message</button><button className="btn btn-secondary" type="button" disabled={!canManageDiscord || !discord?.configured} onClick={() => saveDiscord(false)}>Disconnect Discord</button></div>
          </> : <p className="station-small">An administrator can connect Discord, send a test, or disconnect this household station.</p>}
          <details><summary>Where to get the webhook and user ID</summary><p className="station-small">In your Discord server’s settings, open Integrations → Webhooks, create a webhook for the channel, and copy its URL. To receive personal mentions when help is needed, enable Developer Mode in Discord’s Advanced settings, then copy your user ID. Leave the ID empty to send all messages to the channel without personal mentions.</p></details>
        </div></details>

        <details className="station-card station-management" aria-label="Companion updates">
          <summary><span className="station-disclosure-title"><Icon name="settings" size={22} /><span>Companion updates<small>Manage the software on your Mac</small></span></span><Badge tone={update?.status === 'failed' ? 'warning' : 'neutral'}>{UPDATE_STATES[update?.status] || 'Not reported'}</Badge></summary>
          <div className="station-disclosure-content"><p className="station-small">Updates install on the Mac when it has no active batch.</p>
          <dl className="station-facts"><div><dt>Current version</dt><dd>{currentVersion || 'Not reported'}</dd></div><div><dt>Available version</dt><dd>{nextVersion || 'Not reported'}</dd></div><div><dt>Rollback version</dt><dd>{update?.previousVersion || 'None reported'}</dd></div></dl>
          {update?.error && <p className="station-message station-message--error">{update.error}</p>}
          {update?.supported === false && <p>Managed updates are not available for this station. Its installation must support updates before these controls can be used.</p>}
          {!update && <p>The Mac has not reported managed update support.</p>}
          {data?.permissions.canUpdate ? <><div className="station-actions"><button className="btn btn-secondary" type="button" disabled={!canCheckUpdate} onClick={() => command('check_update')}>Check for updates</button><button className="btn btn-primary" type="button" disabled={!canUpdate || !nextVersion || nextVersion === currentVersion} onClick={() => command('update', { targetVersion: nextVersion })}>{nextVersion && nextVersion !== currentVersion ? `Install ${nextVersion}` : 'Install update'}</button><button className="btn btn-secondary" type="button" disabled={!canUpdate || !update?.previousVersion || update.previousVersion === currentVersion} onClick={() => command('rollback', { targetVersion: update.previousVersion })}>{update?.previousVersion ? `Roll back to ${update.previousVersion}` : 'Roll back'}</button></div>{activeJob && <p className="station-small">Finish or reconcile the current batch before updating the companion.</p>}</> : <p className="station-small">Only an administrator can check for, install, or roll back companion updates.</p>}
          </div>
        </details>
        </section>

        <div className="station-grid station-history">
          <details className="station-card station-management" aria-label="Recent requests"><summary><span className="station-disclosure-title"><Icon name="check" size={22} /><span>Recent requests<small>{commands.length} requests{commandWaiting ? ' · awaiting the Mac' : ''}</small></span></span></summary><div className="station-disclosure-content"><p className="station-small">A pending request has not yet been confirmed by the Mac.</p>{commands.length ? <ol>{commands.slice(0, 20).map(item => <li key={item.id}><div className="station-card-heading"><strong>{COMMAND_NAMES[item.type] || item.type}</strong><Badge tone={item.status === 'applied' ? 'good' : ['rejected', 'expired'].includes(item.status) ? 'warning' : 'neutral'}>{COMMAND_STATES[item.status] || item.status}</Badge></div><time className="station-small">{timestamp(item.createdAt)}</time>{item.targetVersion && <p className="station-small">Version {item.targetVersion}</p>}{item.jobId && <p className="station-batch-id">Batch {item.jobId}</p>}{item.artifactId && <p className="station-small">Back pass: {item.artifactId}</p>}{item.message && <p>{item.message}</p>}{item.acknowledgedAt && <p className="station-small">Acknowledged {timestamp(item.acknowledgedAt)}</p>}</li>)}</ol> : <p>No station requests yet.</p>}</div></details>
          <details className="station-card station-management" aria-label="Station activity"><summary><span className="station-disclosure-title"><Icon name="station" size={22} /><span>Station activity<small>Recent messages from the Mac</small></span></span></summary><div className="station-disclosure-content"><p className="station-small">Recent messages reported by the Mac.</p>{events.length ? <ol>{events.slice(0, 50).map(item => <li key={item.id}><div className="station-card-heading"><Badge tone={item.level === 'error' ? 'error' : item.level === 'warning' ? 'warning' : 'neutral'}>{item.level === 'error' ? 'Error' : item.level === 'warning' ? 'Warning' : 'Info'}</Badge><time className="station-small">{timestamp(item.at)}</time></div><p>{item.message}</p></li>)}</ol> : <p>No station activity reported yet.</p>}</div></details>
        </div>
        <p className="station-footer">Status refreshes every five seconds while this page is visible.</p>
      </>}
    </section>
  );
}
