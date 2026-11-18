import { useId, useMemo, useState } from 'react';
import { computeDiff } from '../lib/differ';
import { parse } from '../lib/parser';
import './DeckImportReview.css';

const SECTIONS = { main: 'Mainboard', commander: 'Commander', sideboard: 'Sideboard' };

export default function DeckImportReview({ review, baseline, label, onApply, onCancel, applyLabel = 'Apply import' }) {
  const heading = useId();
  const [showAll, setShowAll] = useState(false);
  const { accepted, skipped, text, replacedText } = review;
  const { commanders, added, removed, quantities, printings } = useMemo(() => {
    const applied = parse(text);
    const diff = computeDiff(parse(baseline), applied);
    const sections = [diff.mainboard, diff.sideboard];
    return {
      commanders: applied.commanders,
      added: sections.reduce((sum, section) => sum + section.cardsIn.length, 0),
      removed: sections.reduce((sum, section) => sum + section.cardsOut.length, 0),
      quantities: sections.reduce((sum, section) => sum + section.quantityChanges.length, 0),
      printings: sections.reduce((sum, section) => sum + section.printingChanges.length, 0),
    };
  }, [baseline, text]);
  const copies = accepted.reduce((sum, row) => sum + row.quantity, 0);
  const visible = showAll ? accepted : accepted.slice(0, 20);

  return <section className="deck-import-review" aria-labelledby={heading}>
    <h3 id={heading} tabIndex={-1}>{label}</h3>
    <p role="status">{accepted.length} accepted {accepted.length === 1 ? 'row' : 'rows'} · {copies} {copies === 1 ? 'copy' : 'copies'} · {skipped.length} skipped</p>
    {accepted.length > 0 && <p>{added || removed || quantities || printings
      ? `${added} added · ${removed} removed · ${quantities} quantity changes · ${printings} printing changes`
      : 'No changes to card counts or printings.'}</p>}
    {!!commanders.length && <p>Commanders · {commanders.join(' · ')}</p>}
    {!!replacedText && <details open>
      <summary>Replaced draft text</summary>
      <pre>{replacedText}</pre>
    </details>}
    {!!visible.length && <details open>
      <summary>Accepted rows</summary>
      <ul>{visible.map(row => <li key={row.line}>
        <strong>{row.quantity}× {row.displayName}</strong>
        <span>{[SECTIONS[row.section], row.setCode?.toUpperCase(), row.collectorNumber && `#${row.collectorNumber}`,
          row.isFoil ? 'Foil' : row.setCode && row.collectorNumber ? 'Nonfoil' : null,
          !row.setCode || !row.collectorNumber ? 'Exact printing unspecified' : null].filter(Boolean).join(' · ')}</span>
      </li>)}</ul>
      {accepted.length > 20 && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowAll(value => !value)}>{showAll ? 'Show fewer rows' : `Show all ${accepted.length} rows`}</button>}
    </details>}
    {!!skipped.length && <details open>
      <summary>Skipped rows</summary>
      <ul>{skipped.map(({ line, raw, reason }, index) => <li key={index}>
        <strong>{line ? `Line ${line} · ` : ''}{reason}</strong><span>{raw}</span>
      </li>)}</ul>
    </details>}
    <div className="deck-import-actions">
      <button type="button" className="btn btn-primary" disabled={!accepted.length} onClick={onApply}>{applyLabel}</button>
      <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
    </div>
  </section>;
}
