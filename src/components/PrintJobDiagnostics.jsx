import { useEffect, useState } from 'react';
import { getPrintJobDiagnostics } from '../lib/api';

const EVENT_LABELS = {
  submitting: 'Submission intent saved', submitted: 'Accepted by Epson queue', completed: 'Spooler marked pass complete',
  uncertain: 'Submission needs review', failed: 'Pass reported failed', reconciled: 'Submission reconciled',
  recovery: 'Remaining sheets authorized', refeed: 'Paper reload confirmed', paper_ready: 'Blank paper confirmed', canceled: 'Cancellation cleared',
};
const COMMAND_LABELS = {
  resume: 'Print reloaded backs', recover_print: 'Continue interrupted print', clear_paper: 'Confirm paper cleared',
  clear_missing_cups: 'Clear canceled batch with missing history',
};

function stamp(value) {
  const utc = typeof value === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z` : value;
  const date = utc ? new Date(utc) : null;
  return !date || Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleString();
}

function JobReceipts({ jobId, showReason }) {
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getPrintJobDiagnostics(jobId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.id !== jobId || !Array.isArray(result.events) || !Array.isArray(result.commands)) throw new Error('The batch diagnostics response was incomplete.');
      setReceipt(result);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message);
    });
    return () => controller.abort();
  }, [jobId, reload]);

  function refresh() {
    setReceipt(null);
    setError('');
    setReload(value => value + 1);
  }

  if (error) return <><p role="alert">{error}</p><button className="btn btn-secondary btn-sm" type="button" onClick={refresh}>Retry receipts</button></>;
  if (!receipt) return <p role="status">Loading this batch’s receipts…</p>;
  return <div className="station-job-receipts">
    {showReason && receipt.diagnosticMessage && <p>{receipt.diagnosticMessage}</p>}
    <p className="station-small">Batch {receipt.id} · Last saved <time dateTime={receipt.updatedAt}>{stamp(receipt.updatedAt)}</time></p>
    {receipt.events.length ? <ol aria-label="Print pass receipts">{receipt.events.map(event => <li key={event.id}>
      <strong>{event.missingCupsHistory ? 'Cancellation cleared after missing CUPS history check' : EVENT_LABELS[event.state]}</strong>
      <p className="station-small">{[event.artifactId, event.phase, event.spoolerId].filter(Boolean).join(' · ')}{event.artifactId ? ' · ' : ''}<time dateTime={event.at}>{stamp(event.at)}</time></p>
    </li>)}</ol> : <p>No print pass receipts have been saved for this batch.</p>}
    {receipt.commands.length > 0 && <ol aria-label="Recovery requests">{receipt.commands.map(command => <li key={command.id}>
      <strong>{COMMAND_LABELS[command.type]} · {command.status}</strong> <time className="station-small" dateTime={command.at}>{stamp(command.at)}</time>
      {command.message && <p>{command.message}</p>}
    </li>)}</ol>}
    <button className="btn btn-secondary btn-sm" type="button" onClick={refresh}>Refresh receipts</button>
  </div>;
}

export default function PrintJobDiagnostics({ jobId, showReason = true }) {
  const [open, setOpen] = useState(false);
  return <details className="station-job-receipt-details" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Batch receipts</summary>
    {open && <JobReceipts key={jobId} jobId={jobId} showReason={showReason} />}
  </details>;
}
