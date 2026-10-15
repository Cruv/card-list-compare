import { describe, expect, it, vi } from 'vitest';
import { createMpcOverrideSync, collectPrintArtwork, readMpcOverrideCache, getMpcArtworkDifferences, createMpcOverrideCache } from './mpcOverrides.js';

describe('saving artwork for home PDFs', () => {
  it('freezes defaults and both faces while retaining custom and historical selections', () => {
    const previous = new Map([['sol ring', { identifier: 'chosen-ring' }], ['old card', { identifier: 'historical' }]]);
    const saved = collectPrintArtwork(previous, [
      { name: 'Sol Ring', identifier: 'search-ring' },
      { name: 'Fable of the Mirror-Breaker', identifier: 'fable-front', hasMatch: true },
    ], [{ name: 'Reflection of Kiki-Jiki', identifier: 'fable-back' }]);
    expect([...saved].map(([name, art]) => [name, art.identifier])).toEqual([
      ['sol ring', 'chosen-ring'], ['old card', 'historical'],
      ['fable of the mirror-breaker', 'fable-front'], ['reflection of kiki-jiki', 'fable-back'],
    ]);
    expect(previous.size).toBe(2);
  });
  it('does not invent selections for unmatched cards', () => {
    expect(collectPrintArtwork(new Map(), [{ name: 'Missing', hasMatch: false }, { name: 'Stale', identifier: 'stale', hasMatch: false }]).size).toBe(0);
  });
  it('rejects oversized saves without discarding older artwork', () => {
    const previous = new Map(Array.from({ length: 612 }, (_, index) => [`card ${index}`, { identifier: 'art' }]));
    expect(() => collectPrintArtwork(previous, [{ name: 'Extra', identifier: 'extra' }])).toThrow('612');
    expect(previous.size).toBe(612);
  });
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

const localArt = new Map([['sol ring', { identifier: 'local-art' }]]);
const serverArt = new Map([
  ['sol ring', { identifier: 'server-art' }],
  ['the true scriptures', { identifier: 'back-art' }],
]);

function remoteSnapshot(overrides = serverArt, revision = 3, configured = true) {
  return { overrides: [...overrides], revision, configured };
}

function conflict(overrides = serverArt, revision = 4) {
  const error = new Error('Artwork changed in another tab or device');
  error.status = 409;
  error.data = { ...remoteSnapshot(overrides, revision), code: 'ARTWORK_CONFLICT' };
  return error;
}

function store(initial = remoteSnapshot()) {
  let current = initial;
  const saveRemote = vi.fn(async (overrides, baseRevision) => {
    if (baseRevision !== current.revision) throw conflict(new Map(current.overrides), current.revision);
    current = { overrides, configured: true, revision: current.revision + 1 };
    return { saved: true, count: overrides.length, revision: current.revision };
  });
  return { loadRemote: async () => current, saveRemote, get current() { return current; } };
}

async function readySync(options = {}) {
  const source = store();
  const sync = createMpcOverrideSync({ loadRemote: source.loadRemote, saveRemote: source.saveRemote, ...options });
  await sync.load();
  return { sync, source };
}

describe('MPC art override synchronization', () => {
  it('loads every server choice, including DFC backs, without writing on a fresh device', async () => {
    const { sync, source } = await readySync();
    expect(sync.getState().overrides).toEqual(serverArt);
    expect(sync.getState().revision).toBe(3);
    expect(source.saveRemote).not.toHaveBeenCalled();
  });

  it('uses saved artwork over an older acknowledged device cache', async () => {
    const { sync } = await readySync({ initialCache: { overrides: localArt, baseline: localArt, baseRevision: 2 } });
    expect(sync.getState().overrides).toEqual(serverArt);
  });

  it('migrates legacy local choices only into a known never-configured revision', async () => {
    const source = store(remoteSnapshot(new Map(), 0, false));
    const sync = createMpcOverrideSync({ ...source, initialCache: readMpcOverrideCache(JSON.stringify([...localArt])) });
    await sync.load();
    expect(sync.getState().overrides).toEqual(localArt);
    expect(source.saveRemote).toHaveBeenCalledExactlyOnceWith([...localArt], 0);
    expect(sync.getState().revision).toBe(1);
  });

  it('never remigrates stale local artwork after a deliberate reset', async () => {
    const source = store(remoteSnapshot(new Map(), 8, true));
    const sync = createMpcOverrideSync({ ...source, initialCache: { legacy: localArt } });
    await sync.load();
    expect(sync.getState().overrides.size).toBe(0);
    expect(source.saveRemote).not.toHaveBeenCalled();
  });

  it.each([
    { overrides: [], configured: false },
    { overrides: [], revision: 0 },
    { overrides: [], configured: false, revision: -1 },
    { overrides: [], configured: false, revision: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects an unversioned or invalid server snapshot without an unsafe fallback: %j', async data => {
    const saveRemote = vi.fn();
    const sync = createMpcOverrideSync({ loadRemote: async () => data, saveRemote, initialCache: { legacy: localArt } });
    await expect(sync.load()).rejects.toThrow('updated server');
    await expect(sync.save(localArt)).rejects.toThrow('updated server');
    expect(sync.getState().phase).toBe('unavailable');
    expect(saveRemote).not.toHaveBeenCalled();
  });

  it('keeps an edit made during the initial read and asks for review instead of replaying it', async () => {
    const read = deferred();
    const saveRemote = vi.fn();
    const sync = createMpcOverrideSync({ loadRemote: () => read.promise, saveRemote });
    const loading = sync.load();
    await expect(sync.save(new Map())).rejects.toThrow('Load saved artwork');
    read.resolve(remoteSnapshot());
    await loading;
    expect(sync.getState()).toMatchObject({ phase: 'conflict', pending: true, restored: true });
    expect(sync.getState().overrides.size).toBe(0);
    expect(saveRemote).not.toHaveBeenCalled();
  });

  it('serializes quick edits against each successfully acknowledged revision', async () => {
    const first = deferred();
    const saveRemote = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ revision: 5 });
    const { sync } = await readySync({ saveRemote });
    const savedFirst = sync.save(localArt);
    const savedReset = sync.save(new Map());
    await vi.waitFor(() => expect(saveRemote).toHaveBeenCalledOnce());
    expect(sync.getState().overrides.size).toBe(0);
    first.resolve({ revision: 4 });
    await Promise.all([savedFirst, savedReset]);
    expect(saveRemote.mock.calls).toEqual([[[...localArt], 3], [[], 4]]);
    expect(sync.getState()).toMatchObject({ phase: 'ready', pending: false, revision: 5 });
  });

  it('retains the newest local draft and stops queued writes after a conflict', async () => {
    const first = deferred();
    const saveRemote = vi.fn().mockReturnValueOnce(first.promise);
    const { sync } = await readySync({ saveRemote });
    const firstResult = sync.save(localArt).catch(e => e);
    const newest = new Map([['new card', { identifier: 'newest' }]]);
    const secondResult = sync.save(newest).catch(e => e);
    await vi.waitFor(() => expect(saveRemote).toHaveBeenCalledOnce());
    first.resolve(Promise.reject(conflict()));
    expect((await firstResult).status).toBe(409);
    expect((await secondResult).status).toBe(409);
    expect(saveRemote).toHaveBeenCalledOnce();
    expect(sync.getState().overrides).toEqual(newest);
    expect(sync.getState().savedOverrides).toEqual(serverArt);
    await expect(sync.save(localArt)).rejects.toThrow('Artwork changed');
    expect(saveRemote).toHaveBeenCalledOnce();
  });

  it('protects independent changes from two devices until an explicit whole-record replacement', async () => {
    const source = store();
    const first = createMpcOverrideSync(source);
    const second = createMpcOverrideSync(source);
    await Promise.all([first.load(), second.load()]);
    const firstDraft = new Map(serverArt).set('first device card', { identifier: 'first' });
    const secondDraft = new Map(serverArt).set('second device card', { identifier: 'second' });
    await first.save(firstDraft);
    await expect(second.save(secondDraft)).rejects.toMatchObject({ status: 409 });
    expect(new Map(source.current.overrides)).toEqual(firstDraft);
    await second.replaceSavedChoices();
    expect(new Map(source.current.overrides)).toEqual(secondDraft);
    expect(source.saveRemote).toHaveBeenLastCalledWith([...secondDraft], 4);
  });

  it('can adopt saved artwork without writing or discarding historical and back-face entries', async () => {
    const source = store();
    const sync = createMpcOverrideSync(source);
    await sync.load();
    await source.saveRemote([...serverArt], 3);
    await expect(sync.save(localArt)).rejects.toMatchObject({ status: 409 });
    source.saveRemote.mockClear();
    expect(sync.useSavedChoices()).toEqual(serverArt);
    expect(sync.getState()).toMatchObject({ phase: 'ready', pending: false, revision: 4 });
    expect(source.saveRemote).not.toHaveBeenCalled();
  });

  it('still conflicts when another client changes choices after the recovery snapshot', async () => {
    const source = store();
    const sync = createMpcOverrideSync(source);
    await sync.load();
    await source.saveRemote([...serverArt], 3);
    await expect(sync.save(localArt)).rejects.toMatchObject({ status: 409 });
    const newest = new Map([['card', { identifier: 'latest device' }]]);
    await source.saveRemote([...newest], 4);
    await expect(sync.replaceSavedChoices()).rejects.toMatchObject({ status: 409 });
    expect(sync.getState().savedOverrides).toEqual(newest);
    expect(new Map(source.current.overrides)).toEqual(newest);
  });

  it('holds queued edits on network failure and retries with the same baseline', async () => {
    const first = deferred();
    const saveRemote = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ revision: 4 });
    const { sync } = await readySync({ saveRemote });
    const one = sync.save(localArt).catch(e => e);
    const two = sync.save(new Map()).catch(e => e);
    await vi.waitFor(() => expect(saveRemote).toHaveBeenCalledOnce());
    first.resolve(Promise.reject(new Error('offline')));
    await Promise.all([one, two]);
    expect(saveRemote).toHaveBeenCalledOnce();
    expect(sync.getState()).toMatchObject({ phase: 'error', pending: true, revision: 3 });
    await sync.retry();
    expect(saveRemote).toHaveBeenLastCalledWith([], 3);
    expect(sync.getState().phase).toBe('ready');
  });

  it('does not overwrite another device after a committed save loses its response', async () => {
    const source = store();
    const saveRemote = vi.fn(async (...args) => {
      await source.saveRemote(...args);
      throw new Error('response lost');
    });
    const sync = createMpcOverrideSync({ ...source, saveRemote });
    await sync.load();
    await expect(sync.save(localArt)).rejects.toThrow('response lost');
    const anotherDevice = new Map([['other card', { identifier: 'other' }]]);
    await source.saveRemote([...anotherDevice], 4);
    await expect(sync.retry()).rejects.toMatchObject({ status: 409 });
    expect(saveRemote).toHaveBeenLastCalledWith([...localArt], 3);
    expect(new Map(source.current.overrides)).toEqual(anotherDevice);
  });

  it('can verify a lost response by reading the exact saved draft without a replay', async () => {
    const source = store();
    const sync = createMpcOverrideSync({ ...source, saveRemote: async (...args) => {
      await source.saveRemote(...args);
      throw new Error('response lost');
    } });
    await sync.load();
    await expect(sync.save(localArt)).rejects.toThrow('response lost');
    await sync.load();
    expect(source.saveRemote).toHaveBeenCalledOnce();
    expect(sync.getState()).toMatchObject({ phase: 'ready', pending: false, revision: 4 });
  });

  it('requires a successful initial read even when a cached revision is available', async () => {
    const saveRemote = vi.fn();
    const loadRemote = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(remoteSnapshot());
    const sync = createMpcOverrideSync({ loadRemote, saveRemote, initialCache: { overrides: localArt, baseRevision: 2 } });
    await expect(sync.load()).rejects.toThrow('offline');
    await expect(sync.save(localArt)).rejects.toThrow('offline');
    expect(saveRemote).not.toHaveBeenCalled();
    await sync.load();
    expect(sync.getState()).toMatchObject({ phase: 'conflict', pending: true });
    expect(saveRemote).not.toHaveBeenCalled();
  });

  it('persists a pending reset separately from its acknowledged baseline, then restores for review', async () => {
    let cached;
    const source = store();
    const sync = createMpcOverrideSync({ ...source, persist: value => { cached = value; }, saveRemote: async () => { throw new Error('offline'); } });
    await sync.load();
    await expect(sync.save(new Map())).rejects.toThrow('offline');
    const parsed = readMpcOverrideCache(cached);
    expect(parsed.overrides.size).toBe(0);
    expect(parsed.pending).toBe(true);
    expect(parsed.baseline).toEqual(serverArt);
    expect(parsed.baseRevision).toBe(3);
    const restored = createMpcOverrideSync({ ...source, initialCache: parsed });
    await restored.load();
    expect(restored.getState()).toMatchObject({ phase: 'conflict', restored: true, pending: true });
    expect(restored.getState().overrides.size).toBe(0);
    expect(source.saveRemote).not.toHaveBeenCalled();
  });

  it('persists a local draft even when the initial server read never succeeded', async () => {
    let cached;
    const sync = createMpcOverrideSync({ loadRemote: async () => { throw new Error('offline'); }, saveRemote: vi.fn(), persist: value => { cached = value; } });
    await expect(sync.load()).rejects.toThrow('offline');
    await expect(sync.save(localArt)).rejects.toThrow('offline');
    const parsed = readMpcOverrideCache(cached);
    expect(parsed.overrides).toEqual(localArt);
    expect(parsed.baseRevision).toBeNull();
    expect(parsed.pending).toBe(true);
  });

  it('does not discard a conflicted legacy migration when reopened', async () => {
    let cached;
    const source = store(remoteSnapshot(new Map(), 0, false));
    const sync = createMpcOverrideSync({ initialCache: { legacy: localArt }, persist: value => { cached = value; },
      loadRemote: source.loadRemote, saveRemote: async () => { throw conflict(serverArt, 1); } });
    await expect(sync.load()).rejects.toMatchObject({ status: 409 });
    const reopened = createMpcOverrideSync({ ...source, initialCache: readMpcOverrideCache(cached) });
    await reopened.load();
    expect(reopened.getState().overrides).toEqual(localArt);
    expect(reopened.getState().phase).toBe('conflict');
    expect(source.saveRemote).not.toHaveBeenCalled();
  });

  it('does not trust an unversioned success or allow queued writes after it', async () => {
    const saveRemote = vi.fn().mockResolvedValue({ saved: true });
    const { sync } = await readySync({ saveRemote });
    const one = sync.save(localArt).catch(e => e);
    const two = sync.save(new Map()).catch(e => e);
    expect((await one).message).toContain('did not confirm');
    expect((await two).message).toContain('did not confirm');
    expect(saveRemote).toHaveBeenCalledOnce();
  });

  it('unsubscribes UI listeners while retaining acknowledgement and durable cache updates', async () => {
    const write = deferred();
    const listener = vi.fn();
    const persist = vi.fn();
    const { sync } = await readySync({ saveRemote: () => write.promise, persist });
    const unsubscribe = sync.subscribe(listener);
    const saving = sync.save(localArt);
    unsubscribe();
    listener.mockClear();
    write.resolve({ revision: 4 });
    await saving;
    expect(listener).not.toHaveBeenCalled();
    expect(readMpcOverrideCache(persist.mock.lastCall[0])).toMatchObject({ pending: false, baseRevision: 4 });
  });
});

describe('artwork cache and differences', () => {
  it.each([null, 'broken', '{}', '{"version":1,"baseRevision":-1}'])('ignores invalid cache data: %s', raw => {
    expect(readMpcOverrideCache(raw)).toEqual({});
  });
  it('includes removals, new entries and changed art while leaving matching historical entries alone', () => {
    const saved = new Map(serverArt).set('removed', { identifier: 'removed' });
    const draft = new Map(serverArt).set('sol ring', { identifier: 'new ring' }).set('added', { identifier: 'new' });
    expect(getMpcArtworkDifferences(saved, draft).map(d => d.name)).toEqual(['sol ring', 'removed', 'added']);
  });
});

function memoryStorage(initial = []) {
  const records = new Map(initial);
  return {
    get length() { return records.size; },
    key: index => [...records.keys()][index],
    getItem: key => records.get(key) || null,
    setItem: (key, value) => records.set(key, value),
    removeItem: key => records.delete(key),
    records,
  };
}

function cacheRecord(overrides, pending = false) {
  return JSON.stringify({ version: 1, overrides: [...overrides], baseline: [...serverArt], baseRevision: 3, configured: true, pending });
}

describe('per-editor artwork cache durability', () => {
  it('keeps one durable draft identity when an overlay is closed and reopened in the same window', () => {
    const storage = memoryStorage();
    const session = memoryStorage();
    const first = createMpcOverrideCache({ storage, session, key: 'same-window-deck', legacyKey: 'legacy' });
    first.write(cacheRecord(localArt, true));
    const reopened = createMpcOverrideCache({ storage, session, key: 'same-window-deck', legacyKey: 'legacy' });
    expect(reopened.read().overrides).toEqual(localArt);
    reopened.write(cacheRecord(new Map(), true));
    expect([...storage.records.keys()].filter(key => key.includes(':draft:'))).toHaveLength(1);
    reopened.write(cacheRecord(serverArt));
    expect([...storage.records.keys()].filter(key => key.includes(':draft:'))).toHaveLength(0);
  });

  it("does not let an acknowledged save erase another tab's pending draft", () => {
    const storage = memoryStorage();
    const sessionA = memoryStorage();
    const sessionB = memoryStorage();
    const a = createMpcOverrideCache({ storage, session: sessionA, key: 'deck', legacyKey: 'legacy', createId: () => 'a' });
    const b = createMpcOverrideCache({ storage, session: sessionB, key: 'deck', legacyKey: 'legacy', createId: () => 'b' });
    expect(b.write(cacheRecord(localArt, true))).toBe('device');
    expect(a.write(cacheRecord(serverArt))).toBe('device');
    expect(b.read().overrides).toEqual(localArt);
    expect(readMpcOverrideCache(storage.getItem('deck:draft:b')).pending).toBe(true);
    const reopened = createMpcOverrideCache({ storage, session: sessionB, key: 'deck', legacyKey: 'legacy', createId: () => 'reopened-b' });
    expect(reopened.read().overrides).toEqual(localArt);
  });

  it('separates duplicated tabs even when the browser clones their entire sessionStorage', () => {
    const storage = memoryStorage();
    const originalSession = memoryStorage([['clc-mpc-art-tab', 'copied-old-id']]);
    const original = createMpcOverrideCache({ storage, session: originalSession, key: 'deck', legacyKey: 'legacy', createId: () => 'original' });
    original.write(cacheRecord(localArt, true));
    const clonedSession = memoryStorage([...originalSession.records]);
    const duplicate = createMpcOverrideCache({ storage, session: clonedSession, key: 'deck', legacyKey: 'legacy', createId: () => 'duplicate' });
    expect(duplicate.read().overrides).toEqual(localArt);
    duplicate.write(cacheRecord(new Map(), true));
    original.write(cacheRecord(serverArt));
    expect(duplicate.read().overrides.size).toBe(0);
    expect(readMpcOverrideCache(storage.getItem('deck:draft:duplicate')).pending).toBe(true);
  });

  it("can recover a durable closed-tab draft without deleting the originating editor's copy", () => {
    const storage = memoryStorage();
    const original = createMpcOverrideCache({ storage, session: memoryStorage(), key: 'deck', legacyKey: 'legacy', createId: () => 'original' });
    original.write(cacheRecord(localArt, true));
    const recovered = createMpcOverrideCache({ storage, session: memoryStorage(), key: 'deck', legacyKey: 'legacy', createId: () => 'recovered' });
    expect(recovered.read().overrides).toEqual(localArt);
    recovered.write(cacheRecord(serverArt));
    expect(readMpcOverrideCache(storage.getItem('deck:draft:original')).overrides).toEqual(localArt);
  });

  it('keeps drafts separated by account and deck', () => {
    const storage = memoryStorage();
    const first = createMpcOverrideCache({ storage, session: memoryStorage(), key: 'account1-deck1', legacyKey: 'legacy1', createId: () => 'first' });
    first.write(cacheRecord(localArt, true));
    const other = createMpcOverrideCache({ storage, session: memoryStorage(), key: 'account2-deck1', legacyKey: 'legacy2', createId: () => 'other' });
    expect(other.read()).toEqual({});
  });

  it('reports tab-only durability when local storage is full, and editor-only when both stores fail', async () => {
    const blocked = memoryStorage();
    blocked.setItem = () => { throw new Error('Quota exceeded'); };
    const session = memoryStorage();
    const cache = createMpcOverrideCache({ storage: blocked, session, key: 'deck', legacyKey: 'legacy', createId: () => 'id' });
    expect(cache.write(cacheRecord(localArt, true))).toBe('tab');
    expect(cache.read().overrides).toEqual(localArt);
    session.setItem = blocked.setItem;
    expect(cache.write(cacheRecord(localArt, true))).toBe('window');
    const { sync } = await readySync({ persist: cache.write, saveRemote: async () => { throw new Error('offline'); } });
    await expect(sync.save(localArt)).rejects.toThrow('offline');
    expect(sync.getState()).toMatchObject({ persistence: 'window', pending: true, phase: 'error' });
  });

  it('continues protecting a draft if a custom persistence adapter throws', async () => {
    const { sync } = await readySync({ persist: () => { throw new Error('storage blocked'); }, saveRemote: async () => { throw conflict(); } });
    await expect(sync.save(localArt)).rejects.toMatchObject({ status: 409 });
    expect(sync.getState()).toMatchObject({ persistence: 'window', pending: true, phase: 'conflict' });
    expect(sync.getState().overrides).toEqual(localArt);
  });
});
