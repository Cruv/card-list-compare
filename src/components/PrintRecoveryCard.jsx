import { useState } from 'react';

export default function PrintRecoveryCard({ job, canControl, canRecoverBatch, paused, onRecover }) {
  const [firstSheet, setFirstSheet] = useState('');
  const [paperReady, setPaperReady] = useState(false);
  const [paperReloaded, setPaperReloaded] = useState(false);
  const recovery = job.recovery;
  const reprint = recovery.mode === 'reprint_remaining';
  const backs = recovery.phase === 'backs';
  const first = Number(firstSheet);
  const validSheet = Number.isInteger(first) && first >= 1 && first <= recovery.totalSheets;
  const enabled = canControl && !paused && !job.cancelRequested;
  const ready = enabled && paperReady && (!reprint || validSheet) && (!backs || paperReloaded);

  function recover() {
    if (!ready) return;
    onRecover({ jobId: job.id, recoveryId: recovery.recoveryId, artifactId: recovery.artifactId,
      phase: recovery.phase, spoolerId: recovery.spoolerId, paperReady: true,
      ...(reprint ? { firstUnprintedSheet: first } : {}), ...(backs ? { paperReloaded: true } : {}) });
  }

  return <section className="station-card station-refeed station-recovery" aria-label="Recover interrupted print">
    <h2>{reprint ? 'Print the remaining sheets' : 'Continue the existing printer job'}</h2>
    <h3>{job.deckName || 'Card batch'}</h3>
    <p className="station-batch-id">Batch {job.id}</p>
    {job.packet?.label && <p><strong>Margin label: {job.packet.label}</strong></p>}
    <p>{reprint
      ? 'The Mac spooler stopped or canceled this pass. Its saved PDF is available. Count the complete sheets from this interrupted attempt, discard any incomplete sheet, then select the first sheet still needed.'
      : 'This pass is still in the Mac spooler. After you fix the printer problem, CLC checks that exact job and continues it without creating a second copy.'}</p>
    {reprint && <>
      <label className="station-recovery-sheet"><span>First sheet still needed, in print order</span>
        <select value={firstSheet} disabled={!enabled} onChange={event => { setFirstSheet(event.target.value); setPaperReady(false); setPaperReloaded(false); }}>
          <option value="">Choose after checking your output</option>
          {recovery.physicalPages.map((page, index) => <option key={page} value={index + 1}>Sheet {index + 1} of {recovery.totalSheets} · PDF page {page}</option>)}
        </select>
      </label>
      <p className="station-small">Sheet numbers follow this attempt’s actual printer order, which may be reversed from the PDF. If one complete sheet printed during this attempt, choose sheet 2.</p>
      {validSheet && <p role="status">Keep the first {first - 1} complete {first === 2 ? 'sheet' : 'sheets'}. Print {recovery.totalSheets - first + 1} remaining {first === recovery.totalSheets ? 'sheet' : 'sheets'}, starting with PDF page {recovery.physicalPages[first - 1]}.</p>}
    </>}
    <label className="station-paper-check"><input type="checkbox" checked={paperReady} disabled={!enabled} onChange={event => setPaperReady(event.target.checked)} /><span>{backs
      ? 'I fixed the printer problem and checked the paper at the printer.'
      : reprint ? 'I fixed the printer problem, removed incomplete output, and loaded only blank paper in the rear feeder.'
        : 'I fixed the printer problem and loaded the paper needed to continue this job.'}</span></label>
    {backs && <label className="station-paper-check"><input type="checkbox" checked={paperReloaded} disabled={!enabled} onChange={event => setPaperReloaded(event.target.checked)} /><span>I matched this batch and packet label and reloaded only the corresponding front sheets for these remaining backs, in the verified direction and order.</span></label>}
    <button className="btn btn-primary" type="button" disabled={!ready} onClick={recover}>{reprint ? 'Print remaining sheets' : 'Continue printer job'}</button>
    {!canRecoverBatch && <p className="station-small">Only this batch’s owner or a CLC administrator can request recovery.</p>}
    {paused && <p className="station-small">Unpause the station before requesting recovery.</p>}
    {job.cancelRequested && <p className="station-small">This batch has a cancellation request. Wait for its paper-clearance instructions.</p>}
    <p className="station-small">The Mac checks the printer again before proceeding. If the device or Mac print queue still reports a fault, clear it there first. A remaining-sheet attempt keeps the original PDF and submission history. If status is uncertain, printing stays blocked for review.</p>
  </section>;
}
