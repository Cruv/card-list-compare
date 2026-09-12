import { useState } from 'react';
import ConfirmModal from './ConfirmModal';

const PACKET_STATES = {
  pending: 'Saved for later', requested: 'Waiting for the printer', awaiting_refeed: 'Ready to reload',
  submitting: 'Submitting backs', submitted: 'Backs in Epson queue',
  completed: 'Backs printed', canceled: 'Backs canceled', uncertain: 'Needs review at the Mac',
};

export default function DeferredPrintBacks({ jobs, fresh, canPrepare, unavailableReason, busy, onAction }) {
  const [cancelJob, setCancelJob] = useState(null);
  return <section className="station-card station-deferred" aria-labelledby="deferred-backs-title">
    <h2 id="deferred-backs-title">Backs for later{jobs.length ? ` (${jobs.length})` : ''}</h2>
    <p>New jobs on companion 2.55.0 or newer print fronts on blank paper without waiting for a flip. Keep each labeled double-sided sheet; choose its backs here whenever you are ready, even on another day.</p>
    <p className="station-small">Choose a packet first. Wait until Printer says it is ready to reload before touching the feeder. Other front jobs may still be printing.</p>
    {jobs.length > 0 && unavailableReason && <p className="station-small" role="status">{unavailableReason}</p>}
    {!jobs.length && <p className="station-small">No saved backs are waiting.</p>}
    <ol className="station-deferred-jobs">{jobs.map(job => <li key={job.id}>
      <div className="station-card-heading"><div><h3>{job.deckName || 'Card batch'}</h3>{job.requesterName && <p className="station-small">Requested by {job.requesterName}</p>}</div>
        {job.canCancelBacks && <button type="button" className="btn btn-secondary btn-sm" disabled={!fresh || busy || !!job.cancelRequested} onClick={() => setCancelJob(job)}>Cancel remaining backs</button>}</div>
      <p className="station-batch-id">Batch {job.id}</p>
      {job.cancelRequested && <p role="status">Cancellation requested. Waiting for the Mac to stop any submitted pages; follow its paper-clearance instructions.</p>}
      {job.backRequest && <p className="station-message" role="status">Backs requested for {job.packets.find(packet => packet.artifactId === job.backRequest.artifactId)?.label || job.backRequest.artifactId}. Keep blank paper loaded until this packet is ready to reload.</p>}
      <ul className="station-deferred-packets">{job.packets.map(packet => <li key={packet.artifactId}>
        <div><strong>{packet.label || `Packet ${packet.packetIndex} of ${packet.packetCount}`}</strong>
          <p className="station-small">{packet.sheetCount} {packet.sheetCount === 1 ? 'sheet' : 'sheets'} · {packet.cardCount} {packet.cardCount === 1 ? 'card' : 'cards'} · {PACKET_STATES[packet.state] || packet.state}</p>
          {packet.frontCompletedAt && <p className="station-small">Fronts printed {new Date(packet.frontCompletedAt.endsWith('Z') ? packet.frontCompletedAt : `${packet.frontCompletedAt.replace(' ', 'T')}Z`).toLocaleString()}</p>}
          {!packet.label && <p className="station-small">Older PDF: match the complete packet against its downloaded PDF before reloading.</p>}
        </div>
        {packet.state === 'pending' && <button type="button" className="btn btn-primary btn-sm" disabled={!fresh || !canPrepare || busy || !job.canPrepareBacks || !!job.backRequest || !!job.cancelRequested} onClick={() => onAction('prepare_backs', job, packet)}>Prepare this packet’s backs</button>}
      </li>)}</ul>
    </li>)}</ol>
    {cancelJob && <ConfirmModal title="Cancel remaining backs?" message={`${cancelJob.deckName || 'Card batch'} · batch ${cancelJob.id}. Cancel every unfinished back pass for this job. Fronts and completed backs stay recorded. This does not undo paper already printed. Any active back pass must stop and have its paper cleared before other jobs continue.`} confirmLabel="Cancel remaining backs" cancelLabel="Keep backs" danger onCancel={() => setCancelJob(null)} onConfirm={() => { const selected = cancelJob; setCancelJob(null); onAction('cancel_backs', selected); }} />}
  </section>;
}
