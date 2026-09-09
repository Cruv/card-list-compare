import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { createOperationId } from '../lib/operationId';
import { newSourceWork, mergeSourceWork, readSourceWork, saveSourceWork, settleSourceWork,
  sourceReviewKey, sourceReviewStale, sourceStatusLabel, sourceSyncRequest, sourceTextDiff } from '../lib/sourceSync';
import SectionChangelog from './SectionChangelog';
import './SourceSyncReview.css';

function CardDiff({ title, before, after }) {
  const diff = useMemo(() => sourceTextDiff(before, after), [before, after]);
  return <details className="source-sync-diff" open>
    <summary>{title}</summary>
    {!diff ? <p>The previous source text is unavailable. Compare the current and incoming lists below.</p> : <>
      {diff.exactRows !== null ? <>
        {diff.exactRows.length ? <ul className="source-sync-exact-changes">{diff.exactRows.map(row => <li key={row.key}>
          <strong>{row.name}</strong>
          <span>{row.section === 'mainboard' ? 'Main deck' : row.section === 'commander' ? 'Commander' : row.section === 'sideboard' ? 'Sideboard' : row.section} · {row.setCode ? row.setCode.toUpperCase() : 'Set unspecified'}{row.collectorNumber ? ` #${row.collectorNumber}` : ''} · {row.finish === 'foil' ? 'Foil' : 'Nonfoil'}</span>
          <span>Quantity: {row.beforeQuantity} → {row.afterQuantity}</span>
        </li>)}</ul> : <p>{diff.textChanged ? 'Card details match; the original deck text differs.' : 'No card, printing, finish, or section changes.'}</p>}
      </> : <>
      <p>Card totals are shown below. For CSV text, also review the original rows for exact printing and finish details.</p>
      {JSON.stringify(diff.beforeCommanders) !== JSON.stringify(diff.afterCommanders) && <p>
        Commander: {diff.beforeCommanders.join(' / ') || 'none'} → {diff.afterCommanders.join(' / ') || 'none'}
      </p>}
      <SectionChangelog sectionName="Main deck" changes={diff.mainboard} />
      {diff.hasSideboard && <SectionChangelog sectionName="Sideboard" changes={diff.sideboard} />}
      </>}
    </>}
  </details>;
}

export default function SourceSyncReview({ deckId, manual = false, refreshKey, onChanged }) {
  const { user } = useAuth();
  if (manual || !user) return null;
  return <ScopedSourceSyncReview key={`${user.id}:${deckId}`} userId={user.id} deckId={deckId} refreshKey={refreshKey} onChanged={onChanged} />;
}

function ScopedSourceSyncReview({ userId, deckId, refreshKey, onChanged }) {
  const mounted = useRef(false);
  const workRef = useRef(null);
  const busyRef = useRef(false);
  const loadVersion = useRef(0);
  const [state, setState] = useState(null);
  const [work, setWork] = useState(null);
  const [ready, setReady] = useState(false);
  const [storageSafe, setStorageSafe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const storageKey = sourceReviewKey(userId, deckId);
  function replace(value) { workRef.current = value; setWork(value); }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const active = () => mounted.current && !cancelled;
    async function load() {
      if (busyRef.current) return;
      const requestId = ++loadVersion.current;
      try {
        // Read recovery state before fetching or enabling a new decision.
        let saved;
        try { saved = readSourceWork(localStorage, storageKey); }
        catch (cause) { setStorageSafe(false); throw cause; }
        setStorageSafe(true);
        const data = await sourceSyncRequest(userId, deckId, undefined, active);
        if (!active() || requestId !== loadVersion.current || busyRef.current) return;
        const incoming = data.state ?? data;
        const local = workRef.current ?? saved;
        const merged = mergeSourceWork(saved?.operation ? saved : local, incoming);
        if (!local || sourceReviewStale(local.basis, incoming) || saved?.operation) setReviewed(false);
        setState(incoming); replace(merged); setReady(true);
        setError('');
      } catch (cause) { if (active() && requestId === loadVersion.current) setError(cause.message); }
      finally { if (active() && requestId === loadVersion.current) setLoading(false); }
    }
    void load();
    const interval = setInterval(() => void load(), 30000);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; clearInterval(interval); window.removeEventListener('focus', onFocus); };
  }, [userId, deckId, storageKey, refreshKey, reload]);

  function update(patch) {
    if (!ready || !workRef.current || busyRef.current || workRef.current.operation) return;
    const value = { ...workRef.current, ...patch, dirty: true };
    replace(value); setReviewed(false); setError(''); setNotice('');
    try { saveSourceWork(localStorage, storageKey, value); }
    catch (cause) { setStorageSafe(false); setError(`${cause.message} Your merged text remains open here.`); }
  }

  async function decide() {
    const value = workRef.current;
    if (!ready || !storageSafe || !value || busyRef.current || !state) return;
    if (!value.operation && (!reviewed || !state.pending || sourceReviewStale(value.basis, state))) return;
    if (value.action === 'merge' && !value.mergedText.trim()) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    // An older status fetch must not replace the outcome of this decision.
    loadVersion.current++;
    const active = () => mounted.current;
    const body = value.operation ?? {
      operationId: createOperationId(), expectedRevision: value.basis.revision,
      expectedCurrentSnapshotId: value.basis.currentSnapshotId,
      expectedCurrentTextHash: value.basis.currentTextHash, action: value.action,
      ...(value.action === 'merge' ? { reviewedText: value.mergedText } : {}),
    };
    const pending = { ...value, operation: body };
    try {
      saveSourceWork(localStorage, storageKey, pending);
      replace(pending);
      const result = await sourceSyncRequest(userId, deckId, body, active);
      const confirmed = result.state ?? result;
      const cleared = newSourceWork(confirmed);
      const settled = settleSourceWork(localStorage, storageKey, body.operationId, cleared);
      if (!active()) return;
      if (!settled) {
        replace(readSourceWork(localStorage, storageKey));
        setReviewed(false);
        setNotice('Another window changed this review. Reloading its saved decision.');
        return;
      }
      setState(confirmed); replace(cleared); setReviewed(false);
      setNotice(body.action === 'keep' ? 'Current CLC deck kept. This Archidekt version is acknowledged.' : 'Reviewed digital deck saved. The paper snapshot remains unchanged.');
      try { await onChanged?.(); }
      catch (cause) { if (active()) setError(`Your decision was saved. Reload to refresh the deck: ${cause.message}`); }
    } catch (cause) {
      const rejected = cause.status >= 400 && cause.status < 500 && cause.status !== 408 && cause.status !== 429;
      if (rejected) {
        const preserved = { ...pending, operation: null, dirty: true };
        let settled = false;
        try { settled = settleSourceWork(localStorage, storageKey, body.operationId, preserved); }
        catch { /* Keep the original immutable request if device storage is unavailable. */ }
        if (active() && settled) { replace(preserved); setReviewed(false); }
      }
      if (active()) setError(`${cause.message}${rejected ? ' Your review text is preserved; review the latest versions before deciding again.' : ' Retry the saved source review to confirm its result.'}`);
    } finally {
      busyRef.current = false;
      if (active()) { setBusy(false); setReload(value => value + 1); }
    }
  }

  function rebase() {
    if (!state || !work || busyRef.current || work.operation) return;
    update({ basis: state });
    setNotice('Your merged text is preserved. Review it against the latest versions before confirming.');
  }
  const basis = work?.basis;
  const stale = ready && sourceReviewStale(basis, state);
  const locked = busy || !!work?.operation;
  const resultText = work?.action === 'source' ? basis?.sourceText : work?.action === 'merge' ? work.mergedText : basis?.currentText;

  return <section className={`source-sync-review source-sync-review--${state?.status || 'unknown'}`} aria-label="Archidekt source review">
    <div className="source-sync-heading">
      <div><span className="source-sync-eyebrow">Source status</span><h2>{sourceStatusLabel(ready ? state?.status : 'unknown')}</h2></div>
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setLoading(true); setReload(value => value + 1); }}>Reload source status</button>
    </div>
    <p>{state?.status === 'pending_review' ? 'Archidekt has a different list waiting for review. Your current CLC deck, including accepted ManaSync edits, is preserved.' : state?.status === 'local_changes' ? 'Your current digital deck includes local changes. Refresh checks Archidekt while keeping these edits protected.' : state?.status === 'synced' ? 'The current digital deck matches the last checked Archidekt list.' : 'Use Refresh above to check the Archidekt source. Your saved digital deck stays available.'} Decisions here never change the deck on Archidekt.</p>
    {state?.checkedAt && <p className="source-sync-checked">Last source check: {new Date(state.checkedAt).toLocaleString()}</p>}
    {loading && <p role="status">Loading source status…</p>}
    {error && <p role="alert" className="source-sync-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {ready && work && (state?.pending || work.dirty || work.operation) && <div className="source-sync-work">
      {stale && !work.operation && <div className="source-sync-warning"><p>The saved deck or Archidekt candidate changed during this review. Your merged text is preserved.</p><button type="button" className="btn btn-secondary btn-sm" onClick={rebase} disabled={busy}>Review latest versions with my edits</button></div>}
      <div className="source-sync-comparisons">
        <CardDiff title="Local changes since saved source" before={basis.baseText} after={basis.currentText} />
        <CardDiff title="Archidekt changes since saved source" before={basis.baseText} after={basis.sourceText} />
        <CardDiff title="Changes if you use Archidekt" before={basis.currentText} after={basis.sourceText} />
      </div>
      <details className="source-sync-raw"><summary>Original deck text for all three versions</summary>
        <label>Saved source basis<textarea readOnly value={basis.baseText ?? ''} /></label>
        <label>Current CLC digital deck<textarea readOnly value={basis.currentText ?? ''} /></label>
        <label>Last observed Archidekt deck<textarea readOnly value={basis.sourceText ?? ''} /></label>
      </details>
      <fieldset disabled={locked}><legend>Choose the reviewed result</legend>
        {[['keep', 'Keep current CLC deck'], ['source', 'Use Archidekt version'], ['merge', 'Edit a merged list']].map(([action, label]) => <label key={action}><input type="radio" name={`source-decision-${deckId}`} value={action} checked={work.action === action} onChange={() => update({ action })} />{label}</label>)}
      </fieldset>
      {work.action === 'merge' && <label className="source-sync-merge">Reviewed merged deck list<textarea value={work.mergedText} maxLength={500000} readOnly={locked} onChange={event => update({ mergedText: event.target.value })} /></label>}
      {work.action === 'merge' && <CardDiff title="Changes in your reviewed merged deck" before={basis.currentText} after={resultText} />}
      <p>{work.action === 'keep' ? 'Keep the current CLC digital deck and acknowledge this source check.' : 'Save the selected result as the CLC digital deck. Your paper snapshot stays separate.'}</p>
      {work.operation ? <div className="source-sync-warning"><p>A source review response is unconfirmed. Recover this exact decision before making another.</p><button type="button" className="btn btn-primary btn-sm" disabled={busy || !storageSafe} onClick={decide}>Retry saved source review</button></div> : <>
        <label className="source-sync-confirm"><input type="checkbox" checked={reviewed} disabled={busy || !storageSafe || stale || !state.pending} onChange={event => setReviewed(event.target.checked)} />I reviewed the changes and the resulting digital deck.</label>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !storageSafe || stale || !state.pending || !reviewed || (work.action === 'merge' && !work.mergedText.trim())} onClick={decide}>{work.action === 'keep' ? 'Confirm keep current deck' : work.action === 'source' ? 'Confirm Archidekt version' : 'Save reviewed merged deck'}</button>
      </>}
    </div>}
  </section>;
}
