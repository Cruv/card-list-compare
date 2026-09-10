import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { getPrintStationStatus, sendPrintStationCommand } from '../lib/api';
import './PrintStationPage.css';

const COMMAND_NAMES = {
  pause: 'Pause station', unpause: 'Unpause station', resume: 'Resume reloaded batch',
  check_update: 'Check for updates', update: 'Update companion', rollback: 'Roll back companion',
};
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
  const canResume = canControl && !station.paused && activeJob?.state === 'awaiting_refeed' && !!activeJob.artifactId;
  const matchingResume = activeJob?.id === resumeJobId && activeJob?.artifactId === resumeArtifactId;
  const update = station?.update;
  const updateBusy = ['checking', 'updating', 'rollback'].includes(update?.status);
  const canCheckUpdate = canControl && data?.permissions.canUpdate && update?.supported && !updateBusy;
  const canUpdate = canCheckUpdate && !activeJob;
  const nextVersion = update?.availableVersion;
  const currentVersion = update?.currentVersion || station?.version;
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
        {pendingRequest && !busy && <section className="station-message station-message--warning" aria-label="Request recovery"><strong>Checking the result of {COMMAND_NAMES[pendingRequest.type]?.toLowerCase()}.</strong><p>If the request is missing from recent activity, retry this same request. It keeps its original ID to prevent a duplicate action.</p><button className="btn btn-secondary" type="button" disabled={!online || !data?.permissions.canControl} onClick={() => submit(pendingRequest)}>Retry same request</button></section>}

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
              {activeJob.state === 'awaiting_refeed' && <><p>The front pass is finished. Match these sheets to this batch, flip them using your verified loading direction, and reload them into the rear feeder.</p>{activeJob.artifactId && <p className="station-small">Back pass: {activeJob.artifactId}</p>}<button className="btn btn-primary" type="button" disabled={!canResume} onClick={() => { setResumeJobId(activeJob.id); setResumeArtifactId(activeJob.artifactId); setPaperReloaded(false); }}>Resume after flip and reload</button>{station.paused && <p className="station-small">Unpause the station before resuming this batch.</p>}</>}
              {activeJob.state === 'uncertain' && <p className="station-message station-message--warning">Check this batch against Epson’s queue at the Mac. Reconcile the existing submission before sending any more pages.</p>}
              <p className="station-small">Spooler completion does not confirm color, sheet alignment or cutting readiness.</p>
            </> : <p>{fresh ? 'No active batch reported by the Mac.' : 'Refresh status to confirm the current batch.'}</p>}
            {resumeJobId && <section className="station-refeed" aria-label="Confirm reloaded batch"><h3>Confirm the sheets at the printer</h3><p className="station-batch-id">Batch {resumeJobId}<br />Back pass: {resumeArtifactId}</p>{!matchingResume && <p>This is no longer the waiting pass. Check the current batch before resuming.</p>}<label><input type="checkbox" checked={paperReloaded && matchingResume} onChange={event => setPaperReloaded(event.target.checked)} disabled={!canResume || !matchingResume} /><span>I have physically flipped and reloaded the sheets for this exact batch and back pass into the rear feeder.</span></label><div className="station-actions"><button className="btn btn-primary" type="button" disabled={!canResume || !matchingResume || !paperReloaded} onClick={() => command('resume', { jobId: resumeJobId, artifactId: resumeArtifactId, paperReloaded: true })}>Confirm and print backs</button><button className="btn btn-secondary" type="button" onClick={() => { setResumeJobId(null); setResumeArtifactId(null); setPaperReloaded(false); }}>Cancel</button></div></section>}
          </section>

          <section className="station-card" aria-label="Printer health and recipe">
            <div className="station-card-heading"><h2>Printer and recipe</h2><Badge tone={fresh && station?.health?.ok === true ? 'good' : fresh && station?.health?.ok === false ? 'warning' : 'neutral'}>{!fresh ? 'Unknown' : station?.health?.ok === true ? 'Ready' : station?.health?.ok === false ? 'Needs attention' : 'Not reported'}</Badge></div>
            <p>{station?.health?.message || 'Printer health has not been reported.'}</p>
            <ul className="station-proofs"><ProofFlag verified={station?.recipeVerified === true}>Color and front layout</ProofFlag><ProofFlag verified={station?.duplexVerified === true}>Manual double-faced layout</ProofFlag></ul>
            <p className="station-small">Proofs are recorded on the Mac after physical testing. They cannot be changed here.</p>
            {station?.recipeFingerprint && <details><summary>Recipe fingerprint</summary><p className="station-fingerprint">{station.recipeFingerprint}</p></details>}
          </section>
        </div>

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
