import { useCallback, useMemo, useState } from 'react';
import PrintPlanArtwork from './PrintPlanArtwork';
import PrintPlanOwnership from './PrintPlanOwnership';
import { printReviewIndexes } from '../lib/printReview';

export default function PrintListReview({ plan, onRemove, excludedCards, disabled, shoppingDisabled = false, onPickArt, onResetArt, printingOverrides }) {
  const [filters, setFilters] = useState({ query: '', sides: 'all', ownership: 'all', sort: 'original' });
  const [ownershipRows, setOwnershipRows] = useState([]);
  const receiveOwnership = useCallback(rows => setOwnershipRows(rows), []);
  const indexes = useMemo(() => printReviewIndexes(plan, filters, ownershipRows), [plan, filters, ownershipRows]);
  const visibleKeys = indexes.map(index => ownershipRows[index]?.key).filter(Boolean);
  const visibleCopies = indexes.reduce((total, index) => total + plan.cards[index].quantity, 0);
  const change = (name, value) => setFilters(previous => ({ ...previous, [name]: value }));
  return <div>
    <div className="print-review-filters" aria-label="Print review filters">
      <label>Find cards<input type="search" value={filters.query} onChange={event => change('query', event.target.value)} placeholder="Card name, set or collector number" /></label>
      <details className="print-filter-options"><summary>Filters & sort{[filters.sides !== 'all', filters.ownership !== 'all', filters.sort !== 'original'].filter(Boolean).length ? ' · active' : ''}</summary><div>
      <label>Printed sides<select value={filters.sides} onChange={event => change('sides', event.target.value)}><option value="all">All sides</option><option value="single">Single-sided</option><option value="double">Double-sided</option><option value="unresolved">Unresolved faces</option></select></label>
      <label>Ownership<select value={filters.ownership} onChange={event => change('ownership', event.target.value)}><option value="all">All ownership</option><option value="owned">Owned original</option><option value="incoming">Incoming original</option><option value="missing">Not owned</option><option value="unknown">Unknown</option></select></label>
      <label>Sort cards<select value={filters.sort} onChange={event => change('sort', event.target.value)}><option value="original">List order</option><option value="name">Name A–Z</option><option value="name-desc">Name Z–A</option><option value="quantity-desc">Most copies first</option><option value="quantity-asc">Fewest copies first</option><option value="double-first">Double-sided first</option></select></label>
      </div></details>
    </div>
    <p className="print-panel-meta" role="status">Showing {indexes.length} of {plan.cards.length} card entries · {visibleCopies} of {plan.totalCopies} copies. Filters change the view, not the print batch.</p>
    {!indexes.length && <p>No cards match these filters.</p>}
    <PrintPlanArtwork plan={plan} onRemove={onRemove} excludedCards={excludedCards} disabled={disabled} visibleIndexes={indexes} ownershipRows={ownershipRows} onPickArt={onPickArt} onResetArt={onResetArt} printingOverrides={printingOverrides} />
    <PrintPlanOwnership plan={plan} onRowsChange={receiveOwnership} visibleKeys={visibleKeys} shoppingDisabled={shoppingDisabled} compact />
  </div>;
}
