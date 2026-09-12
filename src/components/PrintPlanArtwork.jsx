import { useState } from 'react';

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
    <figcaption title={face.name || undefined}>{face.face === 'back' ? 'Back' : 'Front'}</figcaption>
  </figure>;
}

export default function PrintPlanArtwork({ plan, onRemove, excludedCards = [], disabled = false, visibleIndexes, ownershipRows, onPickArt, onResetArt, printingOverrides = [] }) {
  const rows = Array.isArray(plan.resolvedCards) && plan.resolvedCards.length === plan.cards.length
    ? plan.resolvedCards : plan.cards.map(card => ({ ...card, isDFC: null, errors: ['Review the print list again to resolve its artwork.'], faces: [] }));
  return <section className="print-review" aria-label="Artwork and double-sided print review">
    <ul className="print-review-cards">{(visibleIndexes ?? rows.map((_, index) => index)).map(index => {
      const card = rows[index], ownership = ownershipRows?.[index]?.ownership;
      const excluded = card.baseQuantity > 0 && excludedCards.includes(card.selectionKey);
      const overridden = printingOverrides.some(item => item.selectionKey === card.selectionKey);
      return <li className={`print-review-card${excluded ? ' print-review-card--removed' : ''}`} key={`${index}:${card.selectionKey || card.displayName}`}>
        <div className="print-review-faces">{(card.faces || []).map(face => <ArtworkFace key={`${face.face}:${face.identifier || face.status}`} cardName={card.displayName} face={face} />)}</div>
        <div className="print-review-identity"><h4>{card.displayName}</h4>
          <p className="print-panel-meta">{card.setCode ? `${card.setCode.toUpperCase()} ${card.collectorNumber || ''}` : 'Printing unresolved'} · {(card.artSource || plan.artSource) === 'saved-mpc' ? 'Saved MPC art' : 'Scryfall art'}{overridden ? ' · Custom selection' : ''}</p>
          <div className="print-card-badges"><span className={`print-panel-status${card.isDFC ? ' print-review-dfc' : ''}`}>{card.isDFC === true ? 'Double-sided' : card.isDFC === false ? 'Single-sided' : 'Faces unresolved'}</span><span className="print-panel-status">{!ownership ? 'Ownership unknown' : !ownership.hasOriginal ? 'Not owned' : ownership.incomingOnly ? 'Incoming original' : 'Owned original'}</span></div>
          {card.additionalQuantity > 0 && <p className="print-panel-meta">{card.additionalQuantity} extra {card.additionalQuantity === 1 ? 'copy' : 'copies'} · edit in Add extra cards</p>}
          {!!card.errors?.length && <p className="print-panel-error" role="alert">{card.errors.join('\n')}</p>}
        </div>
        <div className="print-review-row-actions"><strong className="print-copy-count">{card.quantity}×</strong>
          {onPickArt && <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || excluded} onClick={() => onPickArt(card)} aria-label={`Pick art for ${card.displayName}`}>Pick art</button>}
          {onResetArt && overridden && <button type="button" className="print-text-button" disabled={disabled} onClick={() => onResetArt(card)} aria-label={`Use original art for ${card.displayName}`}>Use original art</button>}
          {onRemove && card.selectionKey && card.baseQuantity > 0 && <button type="button" className="print-text-button" disabled={disabled || excluded} onClick={() => onRemove(card)} aria-label={`Remove ${card.baseQuantity} suggested ${card.baseQuantity === 1 ? 'copy' : 'copies'} of ${card.displayName}`}>{excluded ? 'Removed' : 'Remove'}</button>}
        </div>
      </li>;
    })}</ul>
  </section>;
}
