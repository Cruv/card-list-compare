import { useEffect, useState } from 'react';
import { downloadPrintProof, getPrintProof } from '../lib/api';
import { DAHLE_A4_PRESET, PRINT_PAPER, printMarksLabel } from '../lib/printPaper';

const confirmationKey = (userId, proof) => `clc-paper-proof:${userId}:${proof.key}`;

function savedProofCheck(userId, proof) {
  if (!proof) return null;
  try {
    const checked = localStorage.getItem(confirmationKey(userId, proof));
    return checked && Number.isFinite(Date.parse(checked)) ? checked : null;
  } catch { return null; }
}

export default function PrintPaperProof({ userId, selectedPaper, selectedMarks, selectedDahleCutGuides = false, generator }) {
  const [open, setOpen] = useState(false);
  const [paperOverride, setPaperOverride] = useState(null);
  const [marksOverride, setMarksOverride] = useState(null);
  const [dahleCutGuidesOverride, setDahleCutGuidesOverride] = useState(null);
  const [load, setLoad] = useState(null);
  const [request, setRequest] = useState(0);
  const [download, setDownload] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const paper = paperOverride ?? selectedPaper;
  const dahle = paper === DAHLE_A4_PRESET;
  const marks = !dahle && (marksOverride ?? (paper === selectedPaper ? selectedMarks : true));
  const dahleCutGuides = dahle && (dahleCutGuidesOverride ?? (paper === selectedPaper && selectedDahleCutGuides));
  const runtimeRevision = generator?.revision;
  const adapterHash = generator?.adapterHash;
  const available = Boolean(generator?.available);
  const selection = `${paper}:${marks}:${dahleCutGuides}:${available}:${runtimeRevision}:${adapterHash}:${request}`;
  const current = load?.selection === selection ? load : null;
  const proof = current?.proof;
  const saved = confirmation?.key === proof?.key ? confirmation?.checked : savedProofCheck(userId, proof);
  const downloading = download?.pending === true;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    getPrintProof(paper, { registrationMarks: marks, dahleCutGuides }, controller.signal).then(({ proof }) => {
      if ((proof.dahleCutGuides === true) !== dahleCutGuides || proof.dahleAlignmentMarks === true) throw new Error('The proof recipe did not match this layout. Refresh the recipe.');
      if (!controller.signal.aborted) setLoad({ selection, proof });
    }).catch(error => {
      if (!controller.signal.aborted) setLoad({ selection, error: error.message });
    });
    return () => controller.abort();
  }, [open, paper, marks, dahleCutGuides, selection]);

  async function downloadSheet() {
    setDownload({ key: proof.key, pending: true });
    try {
      await downloadPrintProof(paper, proof, AbortSignal.timeout(120_000));
      setDownload({ key: proof.key, done: true });
    } catch (error) { setDownload({ key: proof.key, error: error.message }); }
  }

  function recordCheck(event) {
    const checked = event.target.checked ? new Date().toISOString() : null;
    try {
      const key = confirmationKey(userId, proof);
      if (checked) localStorage.setItem(key, checked);
      else localStorage.removeItem(key);
      setConfirmation({ key: proof.key, checked });
    } catch { setConfirmation({ key: proof.key, checked: saved, error: 'This browser could not save your proof check.' }); }
  }

  return <details className="print-panel-card print-paper-proof" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>One-sheet paper proof</summary>
    {open && <div className="print-paper-proof-content">
      <div className="print-paper-controls">
        <label className="print-list-name">Proof paper and layout<select value={paper} disabled={downloading} onChange={event => { setPaperOverride(event.target.value); setMarksOverride(null); setDahleCutGuidesOverride(null); }}>
          {Object.entries(PRINT_PAPER).map(([key, option]) => <option key={key} value={key}>{option.optionLabel || option.label}</option>)}
        </select></label>
        {dahle
          ? <label className="print-panel-check"><input type="checkbox" checked={dahleCutGuides} disabled={downloading} onChange={event => setDahleCutGuidesOverride(event.target.checked)} />Include strip cut lines and R3 corner guides on the proof</label>
          : <label className="print-panel-check"><input type="checkbox" checked={marks} disabled={downloading} onChange={event => setMarksOverride(event.target.checked)} />Include Cameo registration marks on the proof</label>}
      </div>
      <ol>
        <li>Load the selected stock and print one sheet at Actual Size (100%). Measure the 50 mm line before cutting.</li>
        <li>{dahle ? `Cut 210 × 90 mm strips on the Dahle using the ${dahleCutGuides ? 'horizontal cyan cut lines' : 'row ticks'}.`
          : marks ? 'Use the matching Cameo cut template and check that all registration marks are readable.'
            : 'Use the cut layout as a guide for manual trimming.'}</li>
        {dahle && <li>Feed each strip into the 63 × 88 mm R3 punch.{dahleCutGuides && ' Center the die opening inside the four lime corner guides and check that the guide ink stays on the scrap.'}</li>}
        <li>Measure a cut card at 63 × 88 mm. Check that its dark frame is complete and that no white slivers show along the cut edges.</li>
      </ol>
      <p className="print-panel-meta"><a href={dahle ? '#guide/dahle-punch' : '#guide/printing'}>{dahle ? 'Dahle cutting guide' : 'Printing and cutting guide'}</a></p>
      {!current && <p role="status">Loading proof recipe…</p>}
      {current?.error && <p className="print-panel-error" role="alert">{current.error} <button className="print-text-button" type="button" onClick={() => setRequest(value => value + 1)}>Retry</button></p>}
      {proof && <>
        <p className="print-panel-meta">{PRINT_PAPER[paper].template} · {proof.recipeId} · {proof.cardsPerSheet} slots · {dahle
          ? `${printMarksLabel(proof)} · ${proof.trim.join(' × ')} mm trim · ${proof.bleed.millimeters} mm bleed per edge`
          : `${marks ? 'Registration marks' : 'No registration marks'} · ${proof.crop.replace('mm', ' mm')} crop per edge · Gutter bleed`}</p>
        <p className="print-panel-meta">Generator {proof.revision.slice(0, 12)} · Adapter {proof.adapterHash.slice(0, 8)}</p>
        <div className="print-panel-actions"><button className="btn btn-secondary" type="button" disabled={downloading} onClick={downloadSheet}>{downloading ? 'Preparing proof…' : 'Download one-sheet proof PDF'}</button></div>
        {download?.key === proof.key && download.error && <p className="print-panel-error" role="alert">{download.error} <button className="print-text-button" type="button" onClick={() => setRequest(value => value + 1)}>Refresh recipe</button></p>}
        <label className="print-panel-check"><input type="checkbox" checked={Boolean(saved)} disabled={!saved && !(download?.key === proof.key && download.done)} onChange={recordCheck} />I printed and checked this exact recipe</label>
        {saved && <p className="print-panel-meta" role="status">Checked in this browser on {new Date(saved).toLocaleString()}. Mac readiness uses the local checks in Printer.</p>}
        {confirmation?.key === proof.key && confirmation.error && <p className="print-panel-error" role="alert">{confirmation.error}</p>}
      </>}
    </div>}
  </details>;
}
