import { useEffect, useMemo, useState } from 'react';
import { printPlanBridgeCards } from '../lib/manasync';
import { resolvePrintPlanOwnership } from '../lib/printPlanOwnership';
import ManaSyncOwnership from './ManaSyncOwnership';

export default function PrintPlanOwnership({ plan }) {
  const [resolved, setResolved] = useState(null);
  const [resolving, setResolving] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const cards = useMemo(() => resolved?.cards ?? printPlanBridgeCards(plan, null), [plan, resolved]);

  useEffect(() => {
    let active = true;
    resolvePrintPlanOwnership(plan)
      .then(result => { if (active) setResolved(result); })
      .catch(() => { if (active) setError('Card identities could not be resolved. Unmatched ownership remains unknown.'); })
      .finally(() => { if (active) setResolving(false); });
    return () => { active = false; };
  }, [plan, attempt]);

  function retry() {
    setResolving(true);
    setError('');
    setAttempt(value => value + 1);
  }

  return <section aria-label="Ownership for this print list">
    <p>This checks only the copies in this reviewed {plan.source
      ? `change list from snapshot #${plan.source.id} to #${plan.target.id}`
      : `snapshot #${plan.target.id} print list`}. One original in any printing covers all proxy copies, across every deck. Selecting cards to buy leaves your print quantities unchanged.</p>
    {resolving && <p role="status">Resolving card identities for the reviewed list…</p>}
    {error && <p role="status">{error}</p>}
    {!resolving && resolved?.unresolved.length > 0 && <p role="status">{resolved.unresolved.length} {resolved.unresolved.length === 1 ? 'card identity could' : 'card identities could'} not be resolved. A matching original still counts; unmatched ownership stays unknown. Review the print list again after correcting card details or a temporary outage.</p>}
    {error && <button className="btn btn-secondary btn-sm" type="button" onClick={retry} disabled={resolving}>{resolving ? 'Retrying card identities…' : 'Retry card identities'}</button>}
    <ManaSyncOwnership cards={cards} showConfirmations={false} initiallyOpen />
  </section>;
}
