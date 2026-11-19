import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../context/AuthContext';
import { createAlternatePrintLayout, previewAlternatePrintLayout } from '../lib/api';
import { DAHLE_A4_PRESET, PRINT_PAPER, printPaperChoice, printPaperRequest, validDahleAlignmentMarks } from '../lib/printPaper';
import { printCreationRequestKey, rejectedPrintCreation } from '../lib/printReview';
import { useModalLayer } from '../lib/useModalLayer';
import './ConfirmModal.css';

function loadRequest(key) {
  try {
    const request = JSON.parse(localStorage.getItem(key));
    if (!request || !/^[a-f0-9]{48}$/.test(request.idempotencyKey) || !/^[a-f0-9]{64}$/.test(request.expectedPlanHash)
      || typeof request.registrationMarks !== 'boolean' || !validDahleAlignmentMarks(request)) return null;
    const paper = printPaperRequest(printPaperChoice(request), request.dahleAlignmentMarks);
    if (request.paperSize !== paper.paperSize || request.printPreset !== paper.printPreset) return null;
    return { ...paper, registrationMarks: request.registrationMarks, expectedPlanHash: request.expectedPlanHash, idempotencyKey: request.idempotencyKey };
  } catch { return null; }
}

function printIdentity(card) {
  return card.setCode && card.collectorNumber ? `${card.setCode.toUpperCase()} ${card.collectorNumber}` : card.scryfallId;
}

const faceLabel = face => face === 'back' ? 'Back' : face === 'front' ? 'Front' : 'Card';

export default function PrintRegenerationDialog({ job, deckId, availablePaper, onClose, onCreated }) {
  const { user, getSession, isCurrentSession } = useAuth();
  const userId = user.id;
  const storageKey = `clc-print-layout-request:${userId}:${deckId ?? 'adhoc'}:${job.id}`;
  const [pending, setPending] = useState(() => loadRequest(storageKey));
  const sourcePaper = printPaperChoice(job);
  const [choice, setChoice] = useState(() => pending ? printPaperChoice(pending) : availablePaper.find(paper => paper !== sourcePaper) ?? availablePaper[0]);
  const [marks, setMarks] = useState(pending?.registrationMarks ?? (job.registrationMarks !== false));
  const [dahleMarks, setDahleMarks] = useState(pending?.dahleAlignmentMarks === true);
  const [attempt, setAttempt] = useState(0);
  const [review, setReview] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const controllerRef = useRef(null);
  const dialogRef = useRef(null);
  const paperRef = useRef(null);
  const heading = useId();
  const paper = pending ? printPaperChoice(pending) : choice;
  const dahle = paper === DAHLE_A4_PRESET;
  const registrationMarks = !dahle && marks;
  const selectedDahleMarks = dahle && (pending ? pending.dahleAlignmentMarks === true : dahleMarks);
  const options = useMemo(() => ({ ...printPaperRequest(paper, selectedDahleMarks), registrationMarks }), [paper, selectedDahleMarks, registrationMarks]);
  const preview = review?.options === options && review.attempt === attempt ? review : null;
  const data = preview?.data;
  const failures = data?.artworkFailures ?? [];
  const canCreate = pending || (data?.plan?.readyToGenerate && !failures.length && data.generator?.available);

  function dismiss() { if (!controllerRef.current) onClose(); }
  useModalLayer(dismiss, { containerRef: dialogRef, initialFocusRef: pending ? undefined : paperRef });

  useEffect(() => {
    if (pending) return;
    const session = getSession(userId);
    if (!session) return;
    const controller = new AbortController();
    const { signal } = controller;
    previewAlternatePrintLayout(deckId, job.id, options, signal, session.token).then(data => {
      if ((data.plan.dahleAlignmentMarks === true) !== selectedDahleMarks) throw new Error('The artwork review did not match this layout. Check the saved batch again.');
      if (!signal.aborted && isCurrentSession(session)) setReview({ options, attempt, data });
    }).catch(error => {
      if (!signal.aborted && isCurrentSession(session)) setReview({ options, attempt, error: error.message });
    });
    return () => controller.abort();
  }, [deckId, job.id, options, attempt, pending, userId, getSession, isCurrentSession, selectedDahleMarks]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  function clearRequest(request) {
    try {
      if (loadRequest(storageKey)?.idempotencyKey === request.idempotencyKey) localStorage.removeItem(storageKey);
    } catch { /* A retained key safely retrieves the same receipt. */ }
    setPending(null);
  }

  async function create(event) {
    event.preventDefault();
    if (controllerRef.current || !canCreate) return;
    const session = getSession(userId);
    if (!session) {
      setError('Your sign-in changed. Wait for your account to finish loading, then reopen this batch.');
      return;
    }
    setError('');
    const saved = loadRequest(storageKey);
    if (saved && saved.idempotencyKey !== pending?.idempotencyKey) {
      setPending(saved);
      setError('A saved layout request for this batch is waiting. Review its layout and retry the same request.');
      return;
    }
    let request = pending;
    if (!request) {
      request = { ...options, expectedPlanHash: data.plan.planHash, idempotencyKey: printCreationRequestKey() };
      try { localStorage.setItem(storageKey, JSON.stringify(request)); }
      catch {
        setError('The browser could not save this batch request. Free browser storage and try again.');
        return;
      }
    }
    setPending(request);
    const controller = new AbortController();
    const { signal } = controller;
    controllerRef.current = controller;
    setSubmitting(true);
    try {
      const result = await createAlternatePrintLayout(deckId, job.id, request, signal, session.token);
      if (signal.aborted || !isCurrentSession(session)) return;
      if (result.job?.alternateLayoutOf?.id !== job.id) throw new Error('The server did not return the saved alternate batch. Retry this request to retrieve it.');
      clearRequest(request);
      onCreated(result.job, result.isExisting);
    } catch (failure) {
      if (signal.aborted || !isCurrentSession(session)) return;
      if (rejectedPrintCreation(failure)) {
        clearRequest(request);
        setAttempt(value => value + 1);
      }
      setError(failure.message);
    } finally {
      controllerRef.current = null;
      if (!signal.aborted && isCurrentSession(session)) setSubmitting(false);
    }
  }

  return createPortal(<div className="confirm-modal-overlay" onClick={event => { if (event.target === event.currentTarget) dismiss(); }}>
    <section className="confirm-modal print-regeneration-dialog" role="dialog" aria-modal="true" aria-labelledby={heading} tabIndex={-1} ref={dialogRef}>
      <h2 id={heading} className="confirm-modal-title">Regenerate with another layout</h2>
      <p>{job.deckName || 'Print batch'} · Original batch {job.id.slice(0, 8)}</p>
      <p>Create a PDF-only batch using the original card quantities, printings and artwork. Send to Mac is a separate action for compatible layouts.</p>
      <form onSubmit={create}>
        <label className="print-list-name">Paper and layout
          <select ref={paperRef} value={paper} disabled={!!pending} onChange={event => { setChoice(event.target.value); setError(''); }}>
            {(availablePaper.includes(paper) ? availablePaper : [...availablePaper, paper]).map(value =>
              <option key={value} value={value}>{PRINT_PAPER[value].optionLabel || PRINT_PAPER[value].label}{value === sourcePaper ? ' (original)' : ''}</option>)}
          </select>
        </label>
        {dahle
          ? <>
            <label className="print-panel-check"><input type="checkbox" checked={selectedDahleMarks} disabled={!!pending} onChange={event => { setDahleMarks(event.target.checked); setError(''); }} />Include die-cutter alignment marks</label>
            <p>Dahle uses row ticks and is printed from the downloaded PDF at Actual Size (100%).</p>
          </>
          : <label className="print-panel-check"><input type="checkbox" checked={pending?.registrationMarks ?? marks} disabled={!!pending} onChange={event => { setMarks(event.target.checked); setError(''); }} />Include Cameo registration marks</label>}
        {error && <p className="print-panel-error" role="alert">{error}</p>}
        {pending && !submitting && <p role="status">Retry the saved request to retrieve or finish the same batch.</p>}
        {!pending && !preview && <p role="status">Checking the original artwork and layout…</p>}
        {!pending && preview?.error && <div className="print-panel-error" role="alert">
          <p>{preview.error}</p>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => setAttempt(value => value + 1)}>Check saved batch again</button>
        </div>}
        {!pending && data && <>
          <dl className="print-regeneration-counts" aria-label="New layout counts">
            <div><dt>Cards</dt><dd>{data.plan.totalCopies}</dd></div>
            <div><dt>Front sheets</dt><dd>{data.layout.frontSheets}</dd></div>
            <div><dt>Back sheets</dt><dd>{data.layout.backSheets}</dd></div>
          </dl>
          {failures.length > 0 && <section className="print-panel-error" role="alert">
            <strong>The saved artwork could not be recovered for these faces.</strong>
            <ul>{failures.map(({ displayName, face, reason, setCode, collectorNumber }, index) => <li key={index}>
              <strong>{displayName}{setCode && collectorNumber ? ` (${setCode.toUpperCase()} ${collectorNumber})` : ''} · {faceLabel(face)}.</strong> {reason}
            </li>)}</ul>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => setAttempt(value => value + 1)}>Check saved artwork again</button>
          </section>}
          {data.plan.readyToGenerate && !data.generator?.available && <div role="status">
            <p>The PDF generator is unavailable.</p>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => setAttempt(value => value + 1)}>Check PDF generator again</button>
          </div>}
          {data.plan.resolvedCards?.length > 0 && <details>
            <summary>Original printings and paired faces</summary>
            <ul className="print-regeneration-cards">{data.plan.resolvedCards.map(card => {
              const printing = printIdentity(card);
              return <li key={card.selectionKey}>
                <strong>{card.quantity}× {card.displayName}</strong>{printing && ` · ${printing}`}
                <ul>{card.faces?.map(face => <li key={face.face}>{faceLabel(face.face)}{face.name && ` · ${face.name}`}{data.plan.readyToGenerate && face.status === 'ready' && ' · Verified'}</li>)}</ul>
              </li>;
            })}</ul>
          </details>}
        </>}
        <div className="confirm-modal-actions">
          <button type="button" className="btn btn-secondary" disabled={submitting} onClick={dismiss}>Close</button>
          <button type="submit" className="btn btn-primary" disabled={submitting || !canCreate}>
            {submitting ? 'Saving batch…' : pending ? 'Retry same layout request' : 'Generate PDFs'}
          </button>
        </div>
      </form>
    </section>
  </div>, document.body);
}
