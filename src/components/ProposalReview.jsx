import { useState, useEffect, useRef } from 'react';
import { createOperationId } from '../lib/operationId';
import { useAuth } from '../context/AuthContext';
import {
  proposalReviewKey, mergeProposalDraft, proposalBasis, proposalBasisStale,
  readProposalDraft, saveProposalDraft, readPendingProposalReviews, savePendingProposalReview,
  settlePendingProposalReview, isDefiniteProposalRejection, proposalReviewRequest,
  readRecoveredProposalTexts,
  proposalReplacementError,
} from '../lib/proposalReview';
import './ProposalReview.css';

const reviewable = proposal => ['pending_review', 'needs_rebase'].includes(proposal?.status);

export default function ProposalReview({ deckId, onChanged }) {
  const { user } = useAuth();
  if (!user) return null;
  return <ScopedProposalReview key={`${user.id}:${deckId}`} userId={user.id} deckId={deckId} onChanged={onChanged} />;
}

function ScopedProposalReview({ userId, deckId, onChanged }) {
  const [proposals, setProposals] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [storageSafe, setStorageSafe] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingReviews, setPendingReviews] = useState([]);
  const [recoveredTexts, setRecoveredTexts] = useState([]);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const loadVersion = useRef(0);
  const draftsRef = useRef({});
  const reloadRef = useRef(() => {});
  const storageKey = proposalReviewKey(userId, deckId);

  function replaceDraft(proposalId, draft) {
    draftsRef.current = { ...draftsRef.current, [proposalId]: draft };
    setDrafts(draftsRef.current);
  }

  useEffect(() => {
    mounted.current = true;
    let canceled = false;
    const active = () => mounted.current && !canceled;
    async function load() {
      if (busyRef.current) return;
      const version = ++loadVersion.current;
      try {
        try {
          setPendingReviews(readPendingProposalReviews(localStorage, storageKey));
          setRecoveredTexts(readRecoveredProposalTexts(localStorage, storageKey));
        } catch (cause) { setStorageSafe(false); throw cause; }
        setStorageSafe(true);
        const data = await proposalReviewRequest(userId, deckId, undefined, active);
        if (!active() || version !== loadVersion.current || busyRef.current) return;
        if (!Array.isArray(data.proposals)) throw new Error('The server returned incomplete proposal status.');
        setProposals(data.proposals);
        const next = { ...draftsRef.current };
        let changedBasis = false;
        for (const proposal of data.proposals) {
          const draft = next[proposal.proposalId];
          if (!draft) continue;
          if (proposalBasisStale(draft.basis, proposal)) changedBasis = true;
          next[proposal.proposalId] = mergeProposalDraft(draft, proposal);
        }
        draftsRef.current = next;
        setDrafts(next);
        if (changedBasis) setReviewed(false);
        setError('');
      } catch (cause) { if (active() && version === loadVersion.current) setError(cause.message); }
      finally { if (active() && version === loadVersion.current) setLoading(false); }
    }
    reloadRef.current = load;
    const onFocus = () => { if (!document.hidden) void load(); };
    const onStorage = event => { if (event.key === null || event.key.startsWith(storageKey)) void load(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('storage', onStorage);
    const timer = setInterval(onFocus, 30000);
    void load();
    return () => {
      canceled = true;
      mounted.current = false;
      loadVersion.current += 1;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('storage', onStorage);
      reloadRef.current = () => {};
    };
  }, [userId, deckId, storageKey]);

  function open(proposal) {
    if (busyRef.current) return;
    setReviewed(false);
    setNotice('');
    try {
      const pending = readPendingProposalReviews(localStorage, storageKey);
      setPendingReviews(pending);
      const saved = draftsRef.current[proposal.proposalId] || readProposalDraft(localStorage, storageKey, proposal.proposalId);
      let draft = mergeProposalDraft(saved, proposal);
      const original = pending.find(item => item.proposalId === proposal.proposalId && item.body.action === 'revise');
      // Restore text saved by the older single-request UI before its receipt settles.
      if (!saved && original) {
        draft = saveProposalDraft(localStorage, storageKey, { ...draft, replacement: original.body.reviewedText, dirty: true,
          basis: { ...draft.basis, proposalRevision: original.body.expectedProposalRevision,
            currentLatestSnapshotId: original.body.expectedLatestSnapshotId, currentLatestTextHash: original.body.expectedLatestTextHash } });
      }
      replaceDraft(proposal.proposalId, draft);
      setSelectedId(proposal.proposalId);
      setStorageSafe(true);
      setError('');
    } catch (cause) { setStorageSafe(false); setError(cause.message); }
  }

  function editDraft(patch) {
    if (!selectedId || busyRef.current || pendingReviews.length || !storageSafe) return;
    const draft = draftsRef.current[selectedId];
    if (!draft) return;
    const next = { ...draft, ...patch, dirty: true, unsaved: true };
    replaceDraft(selectedId, next);
    setReviewed(false);
    setNotice('');
    try {
      replaceDraft(selectedId, saveProposalDraft(localStorage, storageKey, next));
      setError('');
    } catch (cause) { setError(`${cause.message} Your text remains in this editor.`); }
  }

  const selected = proposals.find(item => item.proposalId === selectedId);
  const draft = selectedId ? drafts[selectedId] : null;
  const stale = proposalBasisStale(draft?.basis, selected);
  const blocked = busy || !storageSafe || pendingReviews.length > 0;
  const replacementError = draft ? proposalReplacementError(draft.replacement) : null;

  async function decide(action, savedOperation) {
    if (busyRef.current || !storageSafe) return;
    if (!savedOperation && (!selected || !draft || !reviewable(selected) || !reviewed || stale || draft.unsaved || pendingReviews.length)) return;
    if (!savedOperation && action === 'revise' && !draft.replacement.trim()) return;
    if (!savedOperation && action === 'revise' && replacementError) { setError(replacementError); return; }
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    loadVersion.current += 1;
    const active = () => mounted.current;
    let operation = savedOperation;
    let recorded = false;
    try {
      if (!operation) {
        // Recheck the draft revision even before a cross-tab storage event arrives.
        replaceDraft(selectedId, saveProposalDraft(localStorage, storageKey, draft));
        operation = { proposalId: selectedId, body: {
          operationId: createOperationId(), expectedProposalRevision: draft.basis.proposalRevision,
          expectedLatestSnapshotId: draft.basis.currentLatestSnapshotId,
          expectedLatestTextHash: draft.basis.currentLatestTextHash, action,
          ...(action === 'revise' ? { reviewedText: draft.replacement } : {}),
        } };
      }
      savePendingProposalReview(localStorage, storageKey, operation);
      recorded = true;
      setPendingReviews(readPendingProposalReviews(localStorage, storageKey));
      const receipt = await proposalReviewRequest(userId, deckId, operation, active, () =>
        readPendingProposalReviews(localStorage, storageKey).some(item => JSON.stringify(item) === JSON.stringify(operation)));
      settlePendingProposalReview(localStorage, storageKey, operation);
      if (!active()) return;
      setPendingReviews(readPendingProposalReviews(localStorage, storageKey));
      setRecoveredTexts(readRecoveredProposalTexts(localStorage, storageKey));
      setProposals(old => [receipt, ...old.filter(item => item.proposalId !== receipt.proposalId)]);
      setReviewed(false);
      setNotice('Decision confirmed. The paper version remains unchanged.');
      try { await onChanged?.(); }
      catch (cause) { if (active()) setError(`Your decision was saved. Refresh the deck to see it: ${cause.message}`); }
    } catch (cause) {
      if (recorded && isDefiniteProposalRejection(cause)) {
        try { settlePendingProposalReview(localStorage, storageKey, operation); }
        catch { /* Keep the request if its text or receipt cannot be saved. */ }
      }
      if (active()) {
        try {
          setPendingReviews(readPendingProposalReviews(localStorage, storageKey));
          setRecoveredTexts(readRecoveredProposalTexts(localStorage, storageKey));
        } catch { setStorageSafe(false); }
        setReviewed(false);
        setError(`${cause.message}${isDefiniteProposalRejection(cause) ? ' Your draft is preserved. Refresh and review the latest versions before deciding again.' : recorded ? ' Retry the saved decision to confirm its result.' : ''}`);
      }
    } finally {
      busyRef.current = false;
      if (active()) setBusy(false);
    }
  }

  const pending = proposals.filter(reviewable);
  return <details className="proposal-review">
    <summary>ManaSync proposals {pending.length > 0 ? `(${pending.length} awaiting review)` : ''}</summary>
    <p>Review changes against the saved basis and current digital deck. Accepted or revised decisions create a digital snapshot; update the paper marker separately after changing your physical deck.</p>
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setLoading(true); void reloadRef.current(); }} disabled={busy}>Refresh proposals</button>
    {loading && <p role="status">Loading proposals…</p>}
    {error && <p role="alert" className="proposal-review-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {pendingReviews.length > 0 && <section className="proposal-review-recovery" aria-label="Unconfirmed proposal decisions">
      <p>A saved decision is awaiting confirmation. Recover each original request before making another decision. You can still view other proposals.</p>
      {pendingReviews.map(operation => <div key={operation.body.operationId}>
        <p>Proposal {operation.proposalId} · {operation.body.action}</p>
        {operation.body.action === 'revise' && <details><summary>Saved replacement text</summary><textarea readOnly value={operation.body.reviewedText} aria-label={`Saved replacement for ${operation.proposalId}`} /></details>}
        <button type="button" className="btn btn-primary btn-sm" onClick={() => decide(undefined, operation)} disabled={busy || !storageSafe}>Retry saved decision</button>
      </div>)}
    </section>}
    {!loading && !proposals.length && <p>No deck proposals received.</p>}
    <ul>{proposals.map(item => <li key={item.proposalId}>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => open(item)} disabled={busy}>Review {new Date(item.createdAt).toLocaleString()}</button>
      <span>{item.status.replaceAll('_', ' ')}</span>
    </li>)}</ul>
    {selected && draft && <div className="proposal-review-detail">
      <h3>Proposal review</h3>
      <p>Status: {selected.status.replaceAll('_', ' ')} · Revision {selected.proposalRevision}</p>
      {selected.status === 'needs_rebase' && <p role="status">The original basis changed or was pruned. Review all three texts and explicitly revise the proposal to keep the changes you want.</p>}
      <div className="proposal-review-texts">
        <label>Saved base · snapshot {selected.baseSnapshotId}<textarea readOnly value={selected.baseText} /></label>
        <label>Proposed deck<textarea readOnly value={selected.proposedText} /></label>
        <label>Current digital latest · snapshot {selected.currentLatestSnapshotId || 'none'}<textarea readOnly value={selected.currentLatestText ?? ''} /></label>
      </div>
      {(reviewable(selected) || draft.dirty) && <>
        <label>Reviewed replacement text<textarea className="proposal-review-replacement" value={draft.replacement} aria-invalid={!!replacementError} aria-describedby={replacementError ? `proposal-text-limit-${selected.proposalId}` : undefined} readOnly={blocked || !reviewable(selected)} onChange={event => editDraft({ replacement: event.target.value })} /></label>
        {replacementError && <p id={`proposal-text-limit-${selected.proposalId}`} role="alert" className="proposal-review-error">{replacementError}</p>}
        <p className="proposal-review-draft-status">{draft.unsaved ? 'This draft could not be saved. Keep this editor open and copy your text before leaving.' : draft.dirty ? 'Draft saved in this browser. Refreshing or viewing another proposal keeps your text.' : 'Edit this text to prepare a reviewed revision.'}</p>
      </>}
      {reviewable(selected) && <>
        {stale && <div className="proposal-review-recovery"><p>The proposal or current digital deck changed. Your draft has been preserved. Review the versions above before confirming again.</p><button type="button" className="btn btn-secondary btn-sm" disabled={blocked} onClick={() => editDraft({ basis: proposalBasis(selected) })}>Review latest versions with my edits</button></div>}
        <label className="proposal-review-check"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} disabled={blocked || stale || draft.unsaved} /> I reviewed the saved base, proposal, and current digital latest.</label>
        <div className="proposal-review-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => decide('accept')} disabled={blocked || stale || draft.unsaved || !reviewed || selected.status !== 'pending_review'}>Accept proposed text</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => decide('revise')} disabled={blocked || stale || draft.unsaved || !reviewed || !draft.replacement.trim() || !!replacementError}>Commit reviewed revision</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => decide('reject')} disabled={blocked || stale || draft.unsaved || !reviewed}>Reject</button>
        </div>
      </>}
      {recoveredTexts.filter(item => item.proposalId === selectedId).map(item => <details key={item.body.operationId} className="proposal-review-recovery"><summary>Recovered text from an earlier review decision</summary><textarea readOnly value={item.body.reviewedText} aria-label="Recovered reviewed text" /></details>)}
      {selected.resultSnapshotId && <p>Created digital snapshot {selected.resultSnapshotId}. The paper version remains separately acknowledged.</p>}
    </div>}
  </details>;
}
