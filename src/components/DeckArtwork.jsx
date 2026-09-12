import { useState } from 'react';
import Icon from './Icon';

/** The name is already present beside the cover, so decorative art has empty alt. */
export default function DeckArtwork({ imageUri, className = '' }) {
  const [failedUri, setFailedUri] = useState(null);
  return <div className={`deck-artwork ${className}`} aria-hidden="true">
    {imageUri && failedUri !== imageUri
      ? <img src={imageUri} alt="" loading="lazy" onError={() => setFailedUri(imageUri)} />
      : <div className="deck-artwork-placeholder"><Icon name="library" size={40} /></div>}
  </div>;
}
