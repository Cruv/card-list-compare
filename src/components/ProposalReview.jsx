import { useState, useEffect, useCallback } from 'react';
import { integrationApi } from '../lib/integrationApi';
import { createOperationId } from '../lib/operationId';
import { useAuth } from '../context/AuthContext';
import './ProposalReview.css';

export default function ProposalReview({ deckId, onChanged }) {
  const { user } = useAuth();
  const [proposals, setProposals] = useState([]);
  const [selected, setSelected] = useState(null);
  const [replacement, setReplacement] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pendingReview, setPendingReview] = useState(null);
  const storageKey = `clc-proposal-review:${user?.id}:${deckId}`;
  const refresh = useCallback(async () => {
    const data = await integrationApi(`/decks/${deckId}/proposals`);
    setProposals(data.proposals);
    return data.proposals;
  }, [deckId]);
  useEffect(() => {
    let active = true;
    refresh().catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [refresh]);

  function open(proposal) {
    setSelected(proposal); setReplacement(proposal.proposedText); setReviewed(false); setError('');
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      setPendingReview(saved?.proposalId === proposal.proposalId ? saved : null);
    } catch { setPendingReview(null); }
  }

  async function reload() {
    setBusy(true); setError('');
    try {
      const rows = await refresh();
      if (selected) open(rows.find(row => row.proposalId === selected.proposalId) || selected);
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }

  async function decide(action) {
    setBusy(true); setError('');
    const operation = pendingReview || { proposalId: selected.proposalId, body: {
      operationId: createOperationId(), expectedProposalRevision: selected.proposalRevision,
      expectedLatestSnapshotId: selected.currentLatestSnapshotId,
      expectedLatestTextHash: selected.currentLatestTextHash, action,
      ...(action === 'revise' ? { reviewedText: replacement } : {}),
    } };
    try {
      // Save before sending so a timeout or reload replays this exact decision.
      localStorage.setItem(storageKey, JSON.stringify(operation));
      setPendingReview(operation);
      const receipt = await integrationApi(`/decks/${deckId}/proposals/${operation.proposalId}/review`, {
        method: 'POST', body: JSON.stringify(operation.body),
      });
      localStorage.removeItem(storageKey); setPendingReview(null); setSelected(receipt);
      await refresh();
      await onChanged?.();
    } catch (error) {
      // A definite 4xx response did not commit this decision. A transport/server
      // error remains pending until replay resolves the receipt.
      if (error.status >= 400 && error.status < 500) {
        localStorage.removeItem(storageKey); setPendingReview(null);
      }
      setError(error.status === 409 ? `${error.message}. Refresh the review before deciding again.` : error.message);
    } finally { setBusy(false); }
  }

  const pending = proposals.filter(item => ['pending_review','needs_rebase'].includes(item.status));
  return <details className="proposal-review">
    <summary>ManaSync proposals {pending.length > 0 ? `(${pending.length} awaiting review)` : ''}</summary>
    <p>Review changes against the saved basis and current digital deck. A decision creates a digital snapshot; update the paper marker separately after changing your physical deck.</p>
    <button type="button" className="btn btn-secondary btn-sm" onClick={reload} disabled={busy}>Refresh proposals</button>
    {error && <p role="alert" className="proposal-review-error">{error}</p>}
    {!proposals.length && <p>No deck proposals received.</p>}
    <ul>{proposals.map(item => <li key={item.proposalId}>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => open(item)} disabled={busy}>Review {new Date(item.createdAt).toLocaleString()}</button>
      <span>{item.status.replaceAll('_', ' ')}</span>
    </li>)}</ul>
    {selected && <div className="proposal-review-detail">
      <h3>Proposal review</h3>
      <p>Status: {selected.status.replaceAll('_', ' ')} · Revision {selected.proposalRevision}</p>
      {selected.status === 'needs_rebase' && <p role="status">The original basis changed or was pruned. Review all three texts and explicitly revise the proposal to keep the changes you want.</p>}
      <div className="proposal-review-texts">
        <label>Saved base · snapshot {selected.baseSnapshotId}<textarea readOnly value={selected.baseText} /></label>
        <label>Proposed deck<textarea readOnly value={selected.proposedText} /></label>
        <label>Current digital latest · snapshot {selected.currentLatestSnapshotId || 'none'}<textarea readOnly value={selected.currentLatestText ?? ''} /></label>
      </div>
      {['pending_review','needs_rebase'].includes(selected.status) && <>
        <label>Reviewed replacement text<textarea className="proposal-review-replacement" value={replacement} disabled={busy || !!pendingReview} onChange={event => { setReplacement(event.target.value); setReviewed(false); }} /></label>
        <label className="proposal-review-check"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} disabled={busy || !!pendingReview} /> I reviewed the saved base, proposal, and current digital latest.</label>
        {pendingReview ? <>
          <p>A review response is pending. Retry the saved decision to recover its receipt.</p>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => decide(pendingReview.body.action)} disabled={busy}>Retry saved review</button>
        </> : <div className="proposal-review-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => decide('accept')} disabled={busy || !reviewed || selected.status !== 'pending_review'}>Accept proposed text</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => decide('revise')} disabled={busy || !reviewed || !replacement.trim()}>Commit reviewed revision</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => decide('reject')} disabled={busy || !reviewed}>Reject</button>
        </div>}
      </>}
      {selected.resultSnapshotId && <p>Created digital snapshot {selected.resultSnapshotId}. The paper version remains separately acknowledged.</p>}
    </div>}
  </details>;
}
