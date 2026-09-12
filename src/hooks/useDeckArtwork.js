import { useEffect, useMemo, useState } from 'react';
import { normalizedName } from '../lib/cardIdentity';
import { fetchCardData } from '../lib/scryfall';

export function deckCommanders(deck) {
  try {
    const values = Array.isArray(deck?.commanders) ? deck.commanders : JSON.parse(deck?.commanders || '[]');
    return Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.trim()) : [];
  } catch { return []; }
}

/** Decorative covers use the existing batched, cached metadata lookup. */
export default function useDeckArtwork(decks) {
  const namesKey = JSON.stringify([...new Set(decks.flatMap(deckCommanders))].sort());
  const names = useMemo(() => JSON.parse(namesKey), [namesKey]);
  const [art, setArt] = useState(new Map());
  useEffect(() => {
    let active = true;
    if (names.length) {
      fetchCardData(names).then(result => { if (active) setArt(result); }).catch(() => {});
    }
    return () => { active = false; };
  }, [names]);
  return name => {
    const card = art.get(normalizedName(name || ''));
    return card?.artCropUri || card?.imageUri || null;
  };
}
