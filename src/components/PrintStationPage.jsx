import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { getPrintStationStatus, sendPrintStationCommand, configurePrintStationDiscord, testPrintStationDiscord, findPrintStationCommand } from '../lib/api';
import './PrintStationPage.css';

const COMMAND_NAMES = {
  pause: 'Pause station', unpause: 'Unpause station', resume: 'Resume reloaded batch',
  configure_discord: 'Save Discord settings', test_discord: 'Send Discord test',
  check_update: 'Check for updates', update: 'Update companion', rollback: 'Roll back companion',
};
const isDiscordCommand = type => ['configure_discord', 'test_discord'].includes(type);
const JOB_STATES = {
  active: 'Preparing on the Mac',
  claimed: 'Preparing on the Mac', submitting: 'Submitting to Epson',
  submitted: 'Printing', awaiting_refeed: 'Waiting for flip and reload',
  uncertain: 'Needs review at the Mac', completed: 'Spooler completed',
  queued: 'Waiting for the Mac', failed: 'Failed', canceled: 'Canceled',
};
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
  const packet = activeJob?.packet;
  const packetName = packet?.label ? `Packet ${packet.packetIndex} of ${packet.packetCount}` : 'Legacy double-faced PDF';
  const sheetWord = packet?.sheetCount === 1 ? 'sheet' : 'sheets';
  const canResume = canControl && !station.paused && activeJob?.state === 'awaiting_refeed'
    && !!activeJob.artifactId && packet?.artifactId === activeJob.artifactId;
  const matchingResume = activeJob?.id === resumeJobId && activeJob?.artifactId === resumeArtifactId;
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
    if (type === 'check_update' && !canCheckUpdate) return;
    if (['update', 'rollback'].includes(type) && !canUpdate) return;
    submit({ idempotencyKey: requestId(), type, ...extra });
  }

  return (
    <main className="station-page">
      <nav className="station-nav" aria-label="Print station navigation"><a href="#">← Compare</a><a href="#library">Deck library</a><a href="#guide">Guide</a></nav>
      <header className="station-header">
        <div><p className="station-eyebrow">Household printing</p><h1>Print Station</h1><p>Your Mac, Epson printer and the next batch of cards.</p></div>
        <button className="btn btn-secondary" type="button" onClick={() => refreshRef.current()}>Refresh status</button>
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

        {activeJob?.state === 'awaiting_refeed' && <section className="station-card station-refeed" aria-label="Paper reload required">
          <h2>{packet ? `Flip and reload ${packet.sheetCount} ${sheetWord}` : 'Paper reload is waiting'}</h2>
          <h3>{activeJob.deckName || 'Card batch'}{packet ? ` · ${packetName}` : ''}</h3>
          <p className="station-batch-id">Batch {activeJob.id}</p>
          {packet ? <>
            {packet.label ? <p className="station-batch-id"><strong>Match the printed margin label: {packet.label}</strong></p>
              : <p>This older PDF has no saved packet label. Match all {packet.sheetCount} {sheetWord} against this batch’s downloaded double-faced PDF before continuing.</p>}
            <p>Set aside the other completed output and remove unused blank paper from the rear feeder. Reload only {packet.sheetCount === 1 ? 'this matching sheet' : `these ${packet.sheetCount} matching sheets`}, following {station.testPrintingEnabled && !station.duplexVerified ? 'the flip direction and page order you are testing' : 'your verified flip direction and page order'}. This packet contains {packet.cardCount} {packet.cardCount === 1 ? 'card' : 'cards'}.</p>
            <p>After its back pass finishes, return blank paper to the rear feeder for the next front pass.</p>
            <p>The print queue is held while this back pass waits. Confirm below only after the matching paper is loaded.</p>
            <button className="btn btn-primary" type="button" disabled={!canResume} onClick={() => { setResumeJobId(activeJob.id); setResumeArtifactId(activeJob.artifactId); setPaperReloaded(false); }}>Confirm this paper is reloaded</button>
          </> : <p>The waiting sheet details could not be verified. Refresh status before reloading or resuming.</p>}
          {!fresh && <p>Status is stale. Wait for a successful refresh before handling this packet.</p>}
          {station.paused && <p>Unpause the station before confirming this reloaded packet.</p>}
          {resumeJobId && <section className="station-refeed" aria-label="Confirm reloaded batch"><h3>Confirm the paper at the printer</h3><p className="station-batch-id">Batch {resumeJobId}<br />Back pass: {resumeArtifactId}</p>{matchingResume && packet && <p><strong>{packetName} · {packet.sheetCount} {sheetWord}</strong>{packet.label && <><br />{packet.label}</>}</p>}{!matchingResume && <p>This is no longer the waiting pass. Check the current batch before resuming.</p>}<label><input type="checkbox" checked={paperReloaded && matchingResume} onChange={event => setPaperReloaded(event.target.checked)} disabled={!canResume || !matchingResume} /><span>I matched this packet to the completed output, then flipped and reloaded only its {packet?.sheetCount === 1 ? 'sheet' : 'sheets'} into the rear feeder using {station.testPrintingEnabled && !station.duplexVerified ? 'the direction and page order I am testing' : 'the verified direction and page order'}.</span></label><div className="station-actions"><button className="btn btn-primary" type="button" disabled={!canResume || !matchingResume || !paperReloaded} onClick={() => command('resume', { jobId: resumeJobId, artifactId: resumeArtifactId, paperReloaded: true })}>Confirm and print this packet’s backs</button><button className="btn btn-secondary" type="button" onClick={() => { setResumeJobId(null); setResumeArtifactId(null); setPaperReloaded(false); }}>Cancel</button></div></section>}
        </section>}

        <section className="station-card station-overview" aria-label="Station connection">
          <div className="station-card-heading"><div><h2>{station?.stationId || 'Household Mac'}</h2><p className="station-small">Last seen: {timestamp(station?.lastSeenAt)}</p></div><Badge tone={online ? 'good' : fresh ? 'warning' : 'neutral'}>{connectionLabel}</Badge></div>
          {!loading && !station?.lastSeenAt && fresh && <p>The Mac has not checked in yet. Start the configured companion on the Mac to connect it.</p>}
          {!fresh && data && <p className="station-small">Showing the last received details. Connection and controls will return after a successful refresh.</p>}
          {fresh && !station.online && station.lastSeenAt && <p>The Mac is not checking in. It may be asleep, disconnected, or the companion may be stopped.</p>}
          <dl className="station-facts"><div><dt>Printer queue</dt><dd>{station?.queue || 'Not reported'}</dd></div><div><dt>Companion version</dt><dd>{station?.version || 'Not reported'}</dd></div><div><dt>Station work</dt><dd>{!online ? 'Unknown' : station.paused ? 'Paused' : 'Enabled'}</dd></div></dl>
          <div className="station-actions"><button className="btn btn-primary" type="button" disabled={!canControl || updateBusy} onClick={() => command(station?.paused ? 'unpause' : 'pause')}>{busy ? 'Sending request…' : station?.paused ? 'Unpause station' : 'Pause station'}</button><p className="station-small">Pausing stops new station work. Pages already sent to Epson keep printing.</p></div>
          {commandWaiting && <p className="station-small" role="status">A request is waiting for the Mac. Controls return when it is applied, rejected or expires.</p>}
        </section>

        <div className="station-grid">
          <section className="station-card" aria-label="Current print batch">
            <div className="station-card-heading"><h2>Current batch</h2>{activeJob && <Badge tone={activeJob.state === 'uncertain' ? 'warning' : 'neutral'}>{JOB_STATES[activeJob.state] || activeJob.state}</Badge>}</div>
            {activeJob ? <><h3>{activeJob.deckName || 'Card batch'}</h3><p className="station-batch-id">Batch {activeJob.id}</p>
              {packet && <><p><strong>{packetName}</strong> · {packet.sheetCount} {sheetWord} · {packet.cardCount} cards</p>{packet.label && <p className="station-batch-id">Margin label: {packet.label}</p>}</>}
              {packet && activeJob.phase === 'fronts' && <p>This is a front pass. Load blank paper in the rear feeder and keep completed sheets separate.</p>}
              {activeJob.state === 'awaiting_refeed' && <p>Use the paper reload instructions above. The remaining queue waits for this exact back pass.</p>}
              {activeJob.state === 'uncertain' && <p className="station-message station-message--warning">Check this batch against Epson’s queue at the Mac. Reconcile the existing submission before sending any more pages.</p>}
              <p className="station-small">Spooler completion does not confirm color, sheet alignment or cutting readiness.</p>
            </> : <p>{fresh ? 'No active batch reported by the Mac.' : 'Refresh status to confirm the current batch.'}</p>}
          </section>

          <section className="station-card" aria-label="Printer health and recipe">
            <div className="station-card-heading"><h2>Printer and recipe</h2><Badge tone={fresh && station?.health?.ok === true ? 'good' : fresh && station?.health?.ok === false ? 'warning' : 'neutral'}>{!fresh ? 'Unknown' : station?.health?.ok === true ? 'Ready' : station?.health?.ok === false ? 'Needs attention' : 'Not reported'}</Badge></div>
            <p>{station?.health?.message || 'Printer health has not been reported.'}</p>
            <ul className="station-proofs"><ProofFlag verified={station?.recipeVerified === true}>Color and front layout</ProofFlag><ProofFlag verified={station?.duplexVerified === true}>Manual double-faced layout</ProofFlag></ul>
            {online && station?.duplexVerified === false && <p className="station-message station-message--warning">{station.testPrintingEnabled ? 'Use a small double-faced test batch to verify the manual flip direction, page order and alignment. Test printing still stops for your explicit paper reload confirmation.' : 'Verify the manual flip direction, page order and alignment on the Mac before sending a batch with double-faced cards. A mixed batch can otherwise stop after its ordinary fronts.'}</p>}
            <p className="station-small">Proofs are recorded on the Mac after physical testing. They cannot be changed here.</p>
            {station?.recipeFingerprint && <details><summary>Recipe fingerprint</summary><p className="station-fingerprint">{station.recipeFingerprint}</p></details>}
          </section>
        </div>

        <section className="station-card station-discord" aria-label="Discord notifications">
          <div className="station-card-heading"><div><h2>Discord flip alerts</h2><p className="station-small">Get a ping with the deck, exact packet and printed sheet that needs flipping.</p></div><Badge tone={online && discord?.configured && !discordPending ? 'good' : 'neutral'}>{discordPending ? 'Waiting for the Mac' : !fresh ? 'Status unavailable' : discord?.supported ? discord.configured ? online ? 'Connected' : 'Last reported connected' : 'Not connected' : 'Companion update required'}</Badge></div>
          <p>Discord alerts appear when a double-faced front pass finishes. You still flip and reload only that packet, then confirm in CLC before its backs print.</p>
          {discord?.configured && <p className="station-small">{discord.managed ? 'Settings are managed here.' : 'The Mac is using its local Discord configuration.'} {discord.userId ? `Mentioning Discord user ${discord.userId}.` : 'Messages do not ping a specific user.'}{!online && ' This is the last reported configuration; the Mac is not currently confirmed online.'}</p>}
          {discord?.lastTest && <p className={`station-message${discord.lastTest.status === 'confirmed' ? '' : ' station-message--warning'}`} role="status">{discord.lastTest.status === 'confirmed' ? 'Discord confirmed the test message.' : 'The test was not confirmed. Check Discord before requesting another test; it will not retry automatically.'} <span className="station-small">{timestamp(discord.lastTest.at)}</span></p>}
          {!discord?.supported && <p className="station-small">Install a companion version that supports managed Discord settings, then refresh this page.</p>}
          {data?.permissions.canUpdate ? <>
            {(editingDiscord || !discord?.configured) && !pendingRequest && <form className="station-discord-form" onSubmit={event => { event.preventDefault(); saveDiscord(true); }}>
              <label className="station-discord-field">Discord webhook URL<input type="password" value={webhookUrl} onChange={event => setWebhookUrl(event.target.value)} autoComplete="off" spellCheck={false} placeholder="https://discord.com/api/webhooks/…" maxLength={340} required disabled={!canManageDiscord} /></label>
              <label className="station-discord-field">Discord user ID <span className="station-small">Optional: the one person to ping</span><input type="text" inputMode="numeric" value={discordUserId} onChange={event => setDiscordUserId(event.target.value)} autoComplete="off" pattern="[1-9][0-9]{0,19}" maxLength={20} placeholder="Numeric user ID" disabled={!canManageDiscord} /></label>
              <div className="station-actions"><button className="btn btn-primary" type="submit" disabled={!canManageDiscord || !webhookUrl.trim()}>{discord?.configured ? 'Save Discord connection' : 'Connect Discord'}</button>{editingDiscord && <button className="btn btn-secondary" type="button" onClick={() => { setEditingDiscord(false); setWebhookUrl(''); }}>Cancel</button>}</div>
              <p className="station-small">The webhook is a secret. It is sent to your Mac through CLC and is never shown again here. Saving does not send a message.</p>
            </form>}
            <div className="station-actions">{discord?.configured && !editingDiscord && <button className="btn btn-secondary" type="button" disabled={!canManageDiscord} onClick={() => { setDiscordUserId(discord.userId || ''); setWebhookUrl(''); setEditingDiscord(true); }}>Change connection</button>}<button className="btn btn-secondary" type="button" disabled={!canManageDiscord || !discord?.configured || !discord?.revision} onClick={() => submitDiscord({ idempotencyKey: requestId(), type: 'test_discord', revision: discord.revision })}>Send test message</button><button className="btn btn-secondary" type="button" disabled={!canManageDiscord || !discord?.configured} onClick={() => saveDiscord(false)}>Disconnect Discord</button></div>
          </> : <p className="station-small">An administrator can connect Discord, send a test, or disconnect this household station.</p>}
          <details><summary>Where to get the webhook and user ID</summary><p className="station-small">In your Discord server’s settings, open Integrations → Webhooks, create a webhook for the channel, and copy its URL. To ping yourself, enable Developer Mode in Discord’s Advanced settings, then copy your user ID. Leave the ID empty for a channel message without a personal ping.</p></details>
        </section>

        <section className="station-card" aria-label="Companion updates">
          <div className="station-card-heading"><div><h2>Companion updates</h2><p className="station-small">Updates install on the Mac when it has no active batch.</p></div><Badge tone={update?.status === 'failed' ? 'warning' : 'neutral'}>{UPDATE_STATES[update?.status] || 'Not reported'}</Badge></div>
          <dl className="station-facts"><div><dt>Current version</dt><dd>{currentVersion || 'Not reported'}</dd></div><div><dt>Available version</dt><dd>{nextVersion || 'Not reported'}</dd></div><div><dt>Rollback version</dt><dd>{update?.previousVersion || 'None reported'}</dd></div></dl>
          {update?.error && <p className="station-message station-message--error">{update.error}</p>}
          {update?.supported === false && <p>Managed updates are not available for this station. Its installation must support updates before these controls can be used.</p>}
          {!update && <p>The Mac has not reported managed update support.</p>}
          {data?.permissions.canUpdate ? <><div className="station-actions"><button className="btn btn-secondary" type="button" disabled={!canCheckUpdate} onClick={() => command('check_update')}>Check for updates</button><button className="btn btn-primary" type="button" disabled={!canUpdate || !nextVersion || nextVersion === currentVersion} onClick={() => command('update', { targetVersion: nextVersion })}>{nextVersion && nextVersion !== currentVersion ? `Install ${nextVersion}` : 'Install update'}</button><button className="btn btn-secondary" type="button" disabled={!canUpdate || !update?.previousVersion || update.previousVersion === currentVersion} onClick={() => command('rollback', { targetVersion: update.previousVersion })}>{update?.previousVersion ? `Roll back to ${update.previousVersion}` : 'Roll back'}</button></div>{activeJob && <p className="station-small">Finish or reconcile the current batch before updating the companion.</p>}</> : <p className="station-small">Only an administrator can check for, install, or roll back companion updates.</p>}
        </section>

        <div className="station-grid station-history">
          <section className="station-card" aria-label="Recent requests"><h2>Recent requests</h2><p className="station-small">A pending request has not yet been confirmed by the Mac.</p>{commands.length ? <ol>{commands.slice(0, 20).map(item => <li key={item.id}><div className="station-card-heading"><strong>{COMMAND_NAMES[item.type] || item.type}</strong><Badge tone={item.status === 'applied' ? 'good' : ['rejected', 'expired'].includes(item.status) ? 'warning' : 'neutral'}>{COMMAND_STATES[item.status] || item.status}</Badge></div><time className="station-small">{timestamp(item.createdAt)}</time>{item.targetVersion && <p className="station-small">Version {item.targetVersion}</p>}{item.jobId && <p className="station-batch-id">Batch {item.jobId}</p>}{item.artifactId && <p className="station-small">Back pass: {item.artifactId}</p>}{item.message && <p>{item.message}</p>}{item.acknowledgedAt && <p className="station-small">Acknowledged {timestamp(item.acknowledgedAt)}</p>}</li>)}</ol> : <p>No station requests yet.</p>}</section>
          <section className="station-card" aria-label="Station activity"><h2>Station activity</h2><p className="station-small">Recent messages reported by the Mac.</p>{events.length ? <ol>{events.slice(0, 50).map(item => <li key={item.id}><div className="station-card-heading"><Badge tone={item.level === 'error' ? 'error' : item.level === 'warning' ? 'warning' : 'neutral'}>{item.level === 'error' ? 'Error' : item.level === 'warning' ? 'Warning' : 'Info'}</Badge><time className="station-small">{timestamp(item.at)}</time></div><p>{item.message}</p></li>)}</ol> : <p>No station activity reported yet.</p>}</section>
        </div>
        <p className="station-footer">Status refreshes every five seconds while this page is visible.</p>
      </>}
    </main>
  );
}
