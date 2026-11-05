import { useState, useEffect } from 'react';

/**
 * Lightweight hash-based routing hook.
 * Parses window.location.hash into a route object.
 *
 * Returns:
 *   { route: 'admin' }           for #admin
 *   { route: 'share', shareId }  for #share/{id}
 *   { route: 'main' }            for everything else
 */
export function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash);

  useEffect(() => {
    const handler = () => setHash(window.location.hash);
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const [path, query = ''] = hash.split('?');
  const requestedBatch = new URLSearchParams(query).get(path === '#print-list' ? 'batch' : 'printBatch');
  const initialPrintJobId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedBatch || '') ? requestedBatch : null;

  if (hash === '#admin' || hash.startsWith('#admin/')) {
    return { route: 'admin' };
  }
  if (hash === '#connections') {
    return { route: 'connections' };
  }
  if (hash === '#settings') {
    return { route: 'settings' };
  }
  if (hash === '#print-station') {
    return { route: 'printStation' };
  }
  if (path === '#print-list') {
    return { route: 'printList', initialPrintJobId };
  }
  if (hash === '#guide' || hash.startsWith('#guide/')) {
    return { route: 'guide' };
  }
  if (/^#library\/[1-9]\d*$/.test(path)) {
    const deckId = Number(path.slice(9));
    if (Number.isSafeInteger(deckId)) return { route: 'libraryDeck', deckId, initialPrintJobId };
  }
  if (hash === '#library') {
    return { route: 'library' };
  }
  if (hash.startsWith('#share/')) {
    const shareId = hash.slice(7);
    return { route: 'share', shareId };
  }
  if (hash.startsWith('#deck/')) {
    const deckShareId = hash.slice(6);
    return { route: 'deck', deckShareId };
  }
  return { route: 'main' };
}
