// Vite replaces both markers with the exact files and revision of this build.
const CACHE_NAME = 'clc-shell-__CLC_CACHE_VERSION__';
const STATE_CACHE = 'clc-worker-state';
const STATE_KEY = '/__clc_active_build__';
const SHELL_ASSETS = /* __CLC_PRECACHE_MANIFEST__ */ [];
const shellPaths = new Set(SHELL_ASSETS.map(asset => asset.url));
const isShellCache = name => name === 'clc-v1' || name.startsWith('clc-shell-');

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const alreadyCached = (await caches.keys()).includes(CACHE_NAME);
    const cache = await caches.open(CACHE_NAME);
    // Integrity keeps a deployment changing mid-install from mixing its HTML
    // with another build's chunks. A failed install leaves the old worker active.
    try {
      await cache.addAll(SHELL_ASSETS.map(asset => new Request(asset.url, {
        cache: 'reload', integrity: asset.integrity,
      })));
    } catch (error) {
      // addAll is atomic. A failed reinstall must preserve the existing complete
      // build, which may still serve an open tab or be the rollback target.
      if (!alreadyCached) await caches.delete(CACHE_NAME);
      throw error;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = (await caches.keys()).filter(isShellCache);
    const stateCache = await caches.open(STATE_CACHE);
    const saved = await stateCache.match(STATE_KEY);
    const parsed = saved ? await saved.json().catch(() => ({})) : null;
    const state = parsed && typeof parsed === 'object' ? parsed : {};
    // Keep one prior build for lazy chunks requested by an already-open tab.
    // Creation order cannot identify it after a rollback such as A → B → A.
    const previousActive = state.active === CACHE_NAME ? state.previous : state.active;
    const previous = keys.includes(previousActive) && previousActive !== CACHE_NAME
      ? previousActive
      : keys.includes('clc-v1') ? 'clc-v1' : null;
    await stateCache.put(STATE_KEY, new Response(JSON.stringify({ active: CACHE_NAME, previous }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    await Promise.all(keys.filter(key => key !== CACHE_NAME && key !== previous)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function cachedAsset(path) {
  const current = await caches.open(CACHE_NAME);
  const cached = await current.match(path);
  if (cached) return cached;
  for (const key of (await caches.keys()).filter(name => name !== CACHE_NAME && isShellCache(name))) {
    const previous = await caches.open(key);
    const match = await previous.match(path);
    if (match) return match;
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin
    || url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      return cache.match('/index.html');
    }));
    return;
  }

  // Only build-declared files are precached. Previously cached hashed chunks
  // may be read during an upgrade; arbitrary URLs and token queries never enter
  // storage, and network responses never replace a build's matching HTML.
  if (!url.search && (shellPaths.has(url.pathname) || url.pathname.startsWith('/assets/'))) {
    event.respondWith(cachedAsset(url.pathname).then(cached => cached || fetch(request)));
  }
});
