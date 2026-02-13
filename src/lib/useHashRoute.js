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

  if (hash === '#admin' || hash.startsWith('#admin/')) {
    return { route: 'admin' };
  }
  if (hash === '#settings') {
    return { route: 'settings' };
  }
  if (hash.startsWith('#share/')) {
    const shareId = hash.slice(7);
    return { route: 'share', shareId };
  }
  return { route: 'main' };
}
