import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalLayer } from '../lib/useModalLayer';
import { filterPrintArt, loadPrintArtPage, MAX_ART_PAGES } from '../lib/printArtPicker';
import './PrintArtPicker.css';

function Face({ face }) {
  const [failed, setFailed] = useState(false);
  return <figure>{failed ? <div className="print-art-picker-missing">Preview unavailable</div>
    : <img src={face.url} alt={`${face.name}: ${face.face} artwork`} loading="lazy" onError={() => setFailed(true)} />}
    <figcaption>{face.face === 'back' ? 'Back' : 'Front'} · {face.name}</figcaption></figure>;
}

function Picker({ card, currentScryfallId, onChoose, onClose, disabled = false }) {
  const panel = useRef(null), heading = useId();
  useModalLayer(onClose, { containerRef: panel });
  const [page, setPage] = useState(1), [attempt, setAttempt] = useState(0);
  const [choices, setChoices] = useState([]), [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false), [total, setTotal] = useState(null);
  const oracleId = card?.oracleId;
  const visible = useMemo(() => filterPrintArt(choices, query), [choices, query]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    loadPrintArtPage(oracleId, page, { signal: controller.signal })
      .then(data => {
        if (!active) return;
        setChoices(previous => [...new Map([...previous, ...data.choices].map(choice => [choice.id, choice])).values()]);
        setHasMore(data.hasMore); setTotal(data.total);
      })
      .catch(err => { if (active) setError(err.name === 'AbortError' ? 'Loading printings timed out. Try again.' : err.message); })
      .finally(() => { clearTimeout(timer); if (active) setLoading(false); });
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [oracleId, page, attempt]);

  return createPortal(<div className="print-art-picker-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="print-art-picker" ref={panel} role="dialog" aria-modal="true" aria-labelledby={heading} tabIndex={-1}>
      <header><div><h2 id={heading}>Pick art for {card?.displayName || card?.name || 'this card'}</h2><p>Choose one English printing. Double-sided fronts and backs stay together.</p></div>
        <button className="btn btn-secondary btn-sm" type="button" onClick={onClose} aria-label="Close art picker">Close</button></header>
      <label className="print-art-picker-filter">Filter loaded printings<input type="search" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder="Set, collector number or artist" /></label>
      <p className="print-art-picker-status" role="status">{loading ? 'Loading printings…' : `${visible.length} matching of ${choices.length} loaded printings${total == null ? '' : ` · ${total} total`}`}</p>
      {error && <div className="print-art-picker-error" role="alert"><p>{error}</p><button className="btn btn-secondary btn-sm" type="button" onClick={() => { setLoading(true); setError(''); setAttempt(value => value + 1); }}>Retry printings</button></div>}
      <div className="print-art-picker-results">
        {!loading && !error && !visible.length && <p>No usable printings match this view.{hasMore && ' Load more printings below to search further.'}</p>}
        <ul>{visible.map(choice => <li key={choice.id}>
          <div className="print-art-picker-faces">{choice.faces.map(face => <Face key={face.face} face={face} />)}</div>
          <strong>{choice.setName}</strong><p>{choice.setCode.toUpperCase()} · {choice.collectorNumber}</p>
          {choice.artist && <p className="print-art-picker-artist">{choice.artist}</p>}
          <button className={`btn ${choice.id === currentScryfallId ? 'btn-secondary' : 'btn-primary'} btn-sm`} type="button"
            disabled={disabled || choice.id === currentScryfallId} onClick={() => onChoose(choice.id)}
            aria-label={`${choice.id === currentScryfallId ? 'Current art' : 'Choose art'}: ${choice.setName}, ${choice.collectorNumber}`}>
            {choice.id === currentScryfallId ? 'Current art' : 'Use this art'}</button>
        </li>)}</ul>
      </div>
      <footer><p>This changes only this print batch. Review the updated list before generating PDFs.</p>
        {hasMore && page < MAX_ART_PAGES && !error && <button className="btn btn-secondary btn-sm" type="button" disabled={loading} onClick={() => { setLoading(true); setPage(value => value + 1); }}>Load more printings</button>}
        {hasMore && page >= MAX_ART_PAGES && <p>The picker is limited to the first {MAX_ART_PAGES} pages of newest English printings.</p>}
      </footer>
    </section>
  </div>, document.body);
}

export default function PrintArtPicker(props) {
  return <Picker key={props.card?.oracleId || ''} {...props} />;
}
