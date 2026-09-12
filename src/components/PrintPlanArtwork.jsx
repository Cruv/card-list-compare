import { useState } from 'react';
import { printReviewSummary } from '../lib/printReview';

function ArtworkFace({ cardName, face }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const url = face.thumbnailUrl && `${face.thumbnailUrl}${attempt ? `${face.thumbnailUrl.includes('?') ? '&' : '?'}clc_preview_retry=${attempt}` : ''}`;
  return <figure className="print-review-face">
    {face.status === 'ready' && url && !failed
      ? <a href={face.thumbnailUrl} target="_blank" rel="noreferrer" aria-label={`Enlarge ${cardName} ${face.face} artwork`}>
        <img key={url} src={url} loading="lazy" alt={`${cardName}: selected ${face.face} artwork`} onError={() => setFailed(true)} />
      </a>
      : <div className="print-review-image-missing"><p>{face.error || (failed ? 'Thumbnail could not load.' : `No ${face.face} artwork is available.`)}</p>
        {failed && <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>Retry thumbnail</button>}
      </div>}
    <figcaption><strong>{face.face === 'back' ? 'Back' : 'Front'}</strong>{face.name && <span>{face.name}</span>}<span>{face.source === 'saved-mpc' ? 'Saved MPC artwork' : 'Scryfall artwork'}{face.sourceName ? ` · ${face.sourceName}` : ''}</span></figcaption>
  </figure>;
}

export default function PrintPlanArtwork({ plan, onRemove, excludedCards = [], disabled = false, visibleIndexes, ownershipRows }) {
  const summary = printReviewSummary(plan);
  const rows = Array.isArray(plan.resolvedCards) && plan.resolvedCards.length === plan.cards.length
    ? plan.resolvedCards : plan.cards.map(card => ({ ...card, isDFC: null, errors: ['Review the print list again to resolve its artwork.'], faces: [] }));
  return <section className="print-review" aria-label="Artwork and double-sided print review">
    {summary ? <>
      <dl className="print-review-counts">
        <div><dt>Single-sided copies</dt><dd>{summary.ordinary}</dd></div>
        <div><dt>Double-sided copies</dt><dd>{summary.doubleFaced}</dd></div>
        <div><dt>Ordinary sheets</dt><dd>{summary.ordinarySheets}</dd></div>
        <div><dt>Double-sided packets</dt><dd>{summary.packets}</dd></div>
      </dl>
      <p>{summary.sheets} physical {summary.sheets === 1 ? 'sheet' : 'sheets'} · {summary.pages} printed {summary.pages === 1 ? 'page' : 'pages'}. Up to 7 cards per sheet.</p>
      {summary.doubleFaced > 0 && <p>Double-sided cards use {summary.packets} separate {summary.packets === 1 ? 'packet' : 'packets'}, one sheet each. Each packet prints its fronts, waits for you to match, flip and reload that sheet, then prints its backs. Unused slots stay empty.</p>}
    </> : <p role="status">Sheet and packet counts are not confirmed until every card’s faces are resolved.</p>}
    <p className="print-panel-meta">These thumbnails show the selected artwork before PDF generation. Open a face to enlarge it. The PDF applies the household crop and page layout; inspect it before printing.</p>
    <ul className="print-review-cards">{(visibleIndexes ?? rows.map((_, index) => index)).map(index => { const card = rows[index], ownership = ownershipRows?.[index]?.ownership; return <li className="print-review-card" key={`${index}:${card.scryfallId || card.displayName}`}>
      <div className="print-panel-heading"><h4>{card.quantity}× {card.displayName}</h4><span className={`print-panel-status${card.isDFC ? ' print-review-dfc' : ''}`}>{card.isDFC === true ? 'Double-sided' : card.isDFC === false ? 'Single-sided' : 'Faces unresolved'}</span></div>
      <p className="print-panel-meta">{card.setCode ? `${card.setCode.toUpperCase()} ${card.collectorNumber || ''}` : 'Printing unresolved'} · {plan.artSource === 'saved-mpc' ? 'Saved MPC artwork' : 'Scryfall printing'}</p>
      {ownershipRows && <p className="print-panel-meta">{!ownership ? 'Ownership unknown' : !ownership.hasOriginal ? 'No original owned' : ownership.incomingOnly ? 'Original incoming' : 'Original owned'}</p>}
      {card.additionalQuantity > 0 && <p className="print-panel-meta">{card.additionalQuantity} {card.additionalQuantity === 1 ? 'copy added' : 'copies added'} in Extra cards. Edit those lines to change them.</p>}
      {onRemove && card.selectionKey && card.baseQuantity > 0 && <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || excludedCards.includes(card.selectionKey)} onClick={() => onRemove(card)}>{excludedCards.includes(card.selectionKey) ? 'Removed · review to apply' : `Remove ${card.baseQuantity} suggested ${card.baseQuantity === 1 ? 'copy' : 'copies'}`}</button>}
      {!!card.errors?.length && <p className="print-panel-error" role="alert">{card.errors.join('\n')}</p>}
      <div className="print-review-faces">{(card.faces || []).map(face => <ArtworkFace key={`${face.face}:${face.identifier || face.status}`} cardName={card.displayName} face={face} />)}</div>
    </li>; })}</ul>
  </section>;
}
