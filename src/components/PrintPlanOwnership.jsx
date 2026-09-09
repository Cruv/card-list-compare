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
      .catch(() => { if (active) setError('Exact printing details could not be resolved. Unverified exact ownership remains unknown.'); })
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
      : `snapshot #${plan.target.id} print list`}. Selecting cards to buy leaves your print quantities unchanged.</p>
    {resolving && <p role="status">Resolving exact printings for the reviewed list…</p>}
    {error && <p role="status">{error}</p>}
    {!resolving && resolved?.unresolved.length > 0 && <p role="status">{resolved.unresolved.length} exact {resolved.unresolved.length === 1 ? 'printing could' : 'printings could'} not be resolved. Exact ownership stays unknown. Retry the details after a temporary outage, or check the set and collector numbers if the problem continues.</p>}
    {(error || resolved?.unresolved.length > 0) && <button className="btn btn-secondary btn-sm" type="button" onClick={retry} disabled={resolving}>{resolving ? 'Retrying printing details…' : 'Retry printing details'}</button>}
    <ManaSyncOwnership cards={cards} showConfirmations={false} initiallyOpen />
  </section>;
}
