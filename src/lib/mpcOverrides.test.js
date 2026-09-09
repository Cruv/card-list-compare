import { describe, expect, it, vi } from 'vitest';
import { createMpcOverrideSync, collectPrintArtwork } from './mpcOverrides.js';

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

describe('MPC art override synchronization', () => {
  it('loads all server choices, including DFC backs, without writing on a fresh device', async () => {
    const saveRemote = vi.fn();
    const sync = createMpcOverrideSync({
      loadRemote: async () => ({ overrides: [...serverArt] }),
      saveRemote,
    });
    expect(await sync.load(new Map())).toEqual(serverArt);
    expect(saveRemote).not.toHaveBeenCalled();
  });

  it('uses the server as source of truth instead of an older local cache', async () => {
    const sync = createMpcOverrideSync({
      loadRemote: async () => ({ overrides: [...serverArt] }),
      saveRemote: vi.fn(),
    });
    expect(await sync.load(localArt)).toEqual(serverArt);
  });

  it('migrates existing local choices when the server has never been configured', async () => {
    const saveRemote = vi.fn();
    const sync = createMpcOverrideSync({ loadRemote: async () => ({ overrides: [], configured: false }), saveRemote });
    expect(await sync.load(localArt)).toEqual(localArt);
    expect(saveRemote).toHaveBeenCalledExactlyOnceWith([...localArt]);
  });

  it('does not remigrate another device\'s stale choices after Reset Art', async () => {
    const saveRemote = vi.fn();
    const sync = createMpcOverrideSync({
      loadRemote: async () => ({ overrides: [], configured: true }),
      saveRemote,
    });
    expect(await sync.load(localArt)).toEqual(new Map());
    expect(saveRemote).not.toHaveBeenCalled();
  });

  it('retains local migration support for servers without a configured flag', async () => {
    const saveRemote = vi.fn();
    const sync = createMpcOverrideSync({ loadRemote: async () => ({ overrides: [] }), saveRemote });
    expect(await sync.load(localArt)).toEqual(localArt);
    expect(saveRemote).toHaveBeenCalledExactlyOnceWith([...localArt]);
  });

  it('does not restore old art when Reset Art happens during the initial read', async () => {
    const remoteRead = deferred();
    const saveRemote = vi.fn();
    const sync = createMpcOverrideSync({ loadRemote: () => remoteRead.promise, saveRemote });
    const initialLoad = sync.load(localArt);
    await sync.save(new Map());
    remoteRead.resolve({ overrides: [...serverArt] });
    expect(await initialLoad).toBeNull();
    expect(saveRemote).toHaveBeenCalledExactlyOnceWith([]);
  });

  it('preserves edits made while local choices are migrating to the server', async () => {
    const migration = deferred();
    const saveRemote = vi.fn().mockReturnValueOnce(migration.promise);
    const sync = createMpcOverrideSync({ loadRemote: async () => ({ overrides: [] }), saveRemote });
    const initialLoad = sync.load(localArt);
    await vi.waitFor(() => expect(saveRemote).toHaveBeenCalledOnce());
    const saveReset = sync.save(new Map());
    migration.resolve();
    expect(await initialLoad).toBeNull();
    await saveReset;
    expect(saveRemote.mock.calls).toEqual([[[...localArt]], [[]]]);
  });

  it('serializes replacement writes and still saves later choices after an earlier failure', async () => {
    const firstWrite = deferred();
    const saveRemote = vi.fn().mockReturnValueOnce(firstWrite.promise);
    const sync = createMpcOverrideSync({ loadRemote: vi.fn(), saveRemote });
    const first = sync.save(localArt);
    const second = sync.save(serverArt);
    await vi.waitFor(() => expect(saveRemote).toHaveBeenCalledOnce());
    firstWrite.resolve();
    await Promise.all([first, second]);
    expect(saveRemote.mock.calls).toEqual([[[...localArt]], [[...serverArt]]]);

    saveRemote.mockRejectedValueOnce(new Error('offline'));
    await expect(sync.save(localArt)).rejects.toThrow('offline');
    await expect(sync.save(new Map())).resolves.toBeUndefined();
    expect(saveRemote).toHaveBeenLastCalledWith([]);
  });
});
