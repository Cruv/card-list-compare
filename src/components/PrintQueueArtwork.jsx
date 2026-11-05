import { useEffect, useState } from 'react';
import { getPrintQueueArtwork } from '../lib/api';

function ArtworkFace({ itemId, cardName, face, artwork }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let objectUrl;
    const controller = new AbortController();
    getPrintQueueArtwork(itemId, face, controller.signal)
      .then(blob => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(err => { if (active && err.name !== 'AbortError') setError(err.message); });
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [itemId, face, artwork.sha256, attempt]);

  return <figure>
    {url ? <img src={url} alt={`${cardName} printed ${face} artwork`} /> : <p>{error || `Loading ${face} artwork…`}</p>}
    {error && <button className="btn btn-secondary btn-sm" type="button" onClick={() => { setError('');setAttempt(value => value + 1); }}>Retry artwork</button>}
    <figcaption>{face === 'front' ? 'Front' : 'Back'} · {artwork.source === 'saved-mpc' || artwork.source === 'mpc' ? 'MPC artwork' : artwork.source === 'scryfall' ? 'Scryfall artwork' : 'Saved artwork'}</figcaption>
  </figure>;
}

export default function PrintQueueArtwork({ item }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="mana-sync-artwork" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>Artwork saved from this print batch</summary>
    <p>The actual front{item.artwork.back ? ' and back' : ''} artwork stays attached to the proxies you confirm.</p>
    {expanded && <div className="mana-sync-artwork-faces">{['front', 'back'].filter(face => item.artwork[face]).map(face =>
      <ArtworkFace key={`${face}:${item.artwork[face].sha256}`} itemId={item.id} cardName={item.card.name} face={face} artwork={item.artwork[face]} />
    )}</div>}
  </details>;
}
