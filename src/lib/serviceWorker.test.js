import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { buildServiceWorker, serviceWorkerBuild } from '../../scripts/service-worker-build.js';

const template = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const publicFiles = Object.fromEntries(['favicon.svg', 'manifest.json', 'icon-192.png', 'icon-512.png'].map(name => [name, `fixture ${name}`]));
const bundle = {
  html: { type: 'asset', fileName: 'index.html', source: '<script src="/assets/main-123.js"></script>' },
  main: { type: 'chunk', fileName: 'assets/main-123.js', code: 'import("./guide-456.js")' },
  lazy: { type: 'chunk', fileName: 'assets/guide-456.js', code: 'export default "guide"' },
  css: { type: 'asset', fileName: 'assets/main-123.css', source: 'body {color: black}' },
  unrelated: { type: 'asset', fileName: 'api/private.json', source: 'private' },
};
const source = (revision = '') => buildServiceWorker(bundle, publicFiles, template + revision);

function worker({ existing = [], failInstall = false, stores: existingStores, revision = '' } = {}) {
  const stores = existingStores || new Map(existing.map(name => [name, new Map()]));
  const events = {};
  const addAll = vi.fn(async function (requests) {
    if (failInstall) throw new Error('Integrity mismatch');
    for (const request of requests) this.set(request.url, `cached ${request.url}`);
  });
  const caches = {
    keys: async () => [...stores.keys()],
    delete: vi.fn(async key => stores.delete(key)),
    open: async key => {
      if (!stores.has(key)) stores.set(key, new Map());
      const store = stores.get(key);
      return {
        addAll: requests => addAll.call(store, requests),
        match: async path => { const value = store.get(path); return value instanceof Response ? value.clone() : value; },
        put: async (path, response) => store.set(path, response.clone()),
      };
    },
  };
  const self = { location: { origin: 'https://clc.example' }, skipWaiting: vi.fn(), clients: { claim: vi.fn() }, addEventListener: (name, handler) => { events[name] = handler; } };
  const fetch = vi.fn(async () => 'network response');
  const context = createContext({ self, caches, fetch, URL, Response, Request: class { constructor(url, options) { this.url = url; Object.assign(this, options); } } });
  runInContext(source(revision), context);
  const lifecycle = async name => {
    let pending;
    events[name]({ waitUntil: promise => { pending = promise; } });
    await pending;
  };
  const request = (path, options = {}) => {
    const respondWith = vi.fn();
    events.fetch({ request: { url: new URL(path, self.location.origin).href, method: 'GET', mode: 'cors', ...options }, respondWith });
    return respondWith;
  };
  return { stores, caches, self, fetch, addAll, lifecycle, request, name: source(revision).match(/const CACHE_NAME = '([^']+)'/)[1] };
}

describe('production shell build', () => {
  it('includes entry, lazy chunks, CSS and shell files with exact integrity, excluding arbitrary paths', async () => {
    const w = worker(); await w.lifecycle('install');
    const requests = w.addAll.mock.calls[0][0];
    expect(requests.map(request => request.url)).toEqual(['/', '/assets/guide-456.js', '/assets/main-123.css', '/assets/main-123.js', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/index.html', '/manifest.json']);
    expect(requests.find(request => request.url === '/index.html').integrity).toBe(`sha256-${createHash('sha256').update(bundle.html.source).digest('base64')}`);
    expect(requests.every(request => request.cache === 'reload')).toBe(true);
    expect(w.self.skipWaiting).toHaveBeenCalledOnce();
  });

  it('is deterministic and revisions change with HTML, chunks, public assets or worker behavior', () => {
    const original = source();
    expect(buildServiceWorker(Object.fromEntries(Object.entries(bundle).reverse()), publicFiles, template)).toBe(original);
    const cacheName = text => text.match(/const CACHE_NAME = '([^']+)'/)[1];
    for (const changed of [
      buildServiceWorker({ ...bundle, html: { ...bundle.html, source: 'new HTML' } }, publicFiles, template),
      buildServiceWorker({ ...bundle, lazy: { ...bundle.lazy, code: 'changed lazy chunk' } }, publicFiles, template),
      buildServiceWorker(bundle, { ...publicFiles, 'manifest.json': 'changed manifest' }, template),
      buildServiceWorker(bundle, publicFiles, `${template}\n// changed worker`),
    ]) expect(cacheName(changed)).not.toBe(cacheName(original));
  });

  it('fails the build rather than shipping an incomplete manifest', () => {
    expect(() => buildServiceWorker({}, publicFiles, template)).toThrow('index.html');
    expect(() => buildServiceWorker(bundle, {}, template)).toThrow('favicon.svg');
    expect(() => buildServiceWorker(bundle, publicFiles, '')).toThrow('markers');
  });

  it('hashes final on-disk chunks after Vite rewrites preload imports', () => {
    const directory = mkdtempSync(join(tmpdir(), 'clc-sw-build-test-'));
    try {
      const publicDir = join(directory, 'public');
      const outputDir = join(directory, 'dist');
      mkdirSync(publicDir); mkdirSync(outputDir);
      writeFileSync(join(publicDir, 'sw.js'), template);
      for (const [name, bytes] of Object.entries(publicFiles)) writeFileSync(join(outputDir, name), bytes);
      for (const output of Object.values(bundle)) {
        const path = join(outputDir, output.fileName); mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, output.type === 'chunk' ? output.code : output.source);
      }
      const finalCode = 'const __vite__mapDeps = []; import("./guide-456.js");';
      writeFileSync(join(outputDir, bundle.main.fileName), finalCode);
      const plugin = serviceWorkerBuild();
      plugin.configResolved({ publicDir });
      plugin.writeBundle.handler({ dir: outputDir }, bundle);
      const compiled = readFileSync(join(outputDir, 'sw.js'), 'utf8');
      const manifest = JSON.parse(compiled.match(/const SHELL_ASSETS = (\[.*\]);/)[1]);
      expect(manifest.find(asset => asset.url === '/assets/main-123.js').integrity)
        .toBe(`sha256-${createHash('sha256').update(finalCode).digest('base64')}`);
      expect(compiled).not.toContain('__CLC_');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('service-worker lifecycle and storage boundaries', () => {
  it('does not activate a partial or mixed build when precaching fails', async () => {
    const w = worker({ failInstall: true, existing: ['clc-v1'] });
    await expect(w.lifecycle('install')).rejects.toThrow('Integrity mismatch');
    expect(w.self.skipWaiting).not.toHaveBeenCalled();
    expect([...w.stores.keys()]).toEqual(['clc-v1']);
    expect(w.caches.delete).toHaveBeenCalledWith(expect.stringMatching(/^clc-shell-[a-f0-9]{20}$/));
  });

  it('boots the first offline reload and never writes query-token navigation into cache', async () => {
    const w = worker(); await w.lifecycle('install');
    w.fetch.mockRejectedValue(new Error('Offline'));
    const response = w.request('/?reset=private#guide', { mode: 'navigate' });
    await expect(response.mock.calls[0][0]).resolves.toBe('cached /index.html');
    expect([...w.stores.values()][0].has('/?reset=private#guide')).toBe(false);
    expect(w.addAll).toHaveBeenCalledOnce();
  });

  it.each(['/api/auth/me', '/api', 'https://images.example/card.jpg', '/private.json', '/assets/main-123.js?token=private'])('does not cache or intercept %s', async path => {
    const w = worker(); await w.lifecycle('install');
    expect(w.request(path)).not.toHaveBeenCalled();
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('never handles mutations and does not cache undeclared asset responses', async () => {
    const w = worker(); await w.lifecycle('install');
    expect(w.request('/index.html', { method: 'POST' })).not.toHaveBeenCalled();
    const response = w.request('/assets/unrecognized.js');
    await expect(response.mock.calls[0][0]).resolves.toBe('network response');
    expect([...w.stores.values()].some(store => store.has('/assets/unrecognized.js'))).toBe(false);
  });

  it('retains the recorded active cache for open-tab chunks without touching other apps', async () => {
    const w = worker({ existing: ['other-app-cache', 'clc-v1', 'clc-shell-oldest', 'clc-shell-previous'] });
    w.stores.get('clc-shell-previous').set('/assets/old-lazy.js', 'old lazy chunk');
    const state = await w.caches.open('clc-worker-state');
    await state.put('/__clc_active_build__', new Response(JSON.stringify({ active: 'clc-shell-previous', previous: 'clc-shell-oldest' })));
    await w.lifecycle('install'); await w.lifecycle('activate');
    expect(new Set(w.stores.keys())).toEqual(new Set(['other-app-cache', 'clc-shell-previous', 'clc-worker-state', w.name]));
    const response = w.request('/assets/old-lazy.js');
    await expect(response.mock.calls[0][0]).resolves.toBe('old lazy chunk');
    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.self.clients.claim).toHaveBeenCalledOnce();
  });

  it('preserves the actual active build through A → B → A → C rollback history', async () => {
    const a = worker({ revision: '\n// build A' });
    await a.lifecycle('install'); await a.lifecycle('activate');
    a.stores.get(a.name).set('/assets/only-in-a.js', 'A lazy chunk');
    const b = worker({ stores: a.stores, revision: '\n// build B' });
    await b.lifecycle('install'); await b.lifecycle('activate');
    await a.lifecycle('install'); await a.lifecycle('activate');
    const c = worker({ stores: a.stores, revision: '\n// build C' });
    await c.lifecycle('install'); await c.lifecycle('activate');
    expect(new Set(c.stores.keys())).toEqual(new Set(['clc-worker-state', a.name, c.name]));
    const metadata = await (await c.caches.open('clc-worker-state')).match('/__clc_active_build__');
    expect(await metadata.json()).toEqual({ active: c.name, previous: a.name });
    const response = c.request('/assets/only-in-a.js');
    await expect(response.mock.calls[0][0]).resolves.toBe('A lazy chunk');
    expect(c.fetch).not.toHaveBeenCalled();
  });

  it('keeps a complete retained rollback target when reinstalling it fails', async () => {
    const a = worker({ revision: '\n// build A' });
    await a.lifecycle('install'); await a.lifecycle('activate');
    const b = worker({ stores: a.stores, revision: '\n// build B' });
    await b.lifecycle('install'); await b.lifecycle('activate');
    const entries = new Map(a.stores.get(a.name));
    const failedA = worker({ stores: a.stores, revision: '\n// build A', failInstall: true });
    await expect(failedA.lifecycle('install')).rejects.toThrow('Integrity mismatch');
    expect(failedA.stores.get(a.name)).toEqual(entries);
    expect(failedA.caches.delete).not.toHaveBeenCalled();
    const metadata = await (await b.caches.open('clc-worker-state')).match('/__clc_active_build__');
    expect(await metadata.json()).toEqual({ active: b.name, previous: a.name });
  });

  it('migrates from the legacy worker with no metadata and keeps its cache', async () => {
    const w = worker({ existing: ['clc-v1'] });
    await w.lifecycle('install'); await w.lifecycle('activate');
    const metadata = await (await w.caches.open('clc-worker-state')).match('/__clc_active_build__');
    expect(await metadata.json()).toEqual({ active: w.name, previous: 'clc-v1' });
    expect(w.stores.has('clc-v1')).toBe(true);
  });
});
