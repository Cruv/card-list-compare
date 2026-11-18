import { describe, expect, it } from 'vitest';
import { createAuthSession, getBrowserAuthToken, installBrowserAuthSession } from './authSession.js';

const key = 'clc-auth-token';

function fixture() {
  const values = new Map([[key, 'original']]);
  const storage = {
    getItem: name => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
    removeItem: name => values.delete(name),
  };
  const session = createAuthSession(storage);
  session.activate(session.observe(), 1);
  return { storage, session };
}

describe('password change session rotation', () => {
  it('rotates the current session and retires the credential that started it', () => {
    const { session, storage } = fixture();
    const started = session.current();
    expect(session.rotate(started, 'rotated')).toBe(true);
    expect(session.current()?.token).toBe('rotated');
    expect(session.isCurrent(started)).toBe(false);
    expect(storage.getItem(key)).toBe('rotated');
  });

  it.each([
    ['account switch', ({ session }) => { session.signOut(); session.signIn('other-account'); }, 'other-account'],
    ['logout', ({ session }) => session.signOut(), null],
    ['same-token re-login', ({ session }) => { session.signOut(); session.signIn('original'); }, 'original'],
    ['rotation by another request', ({ session }) => session.rotate(session.current(), 'newer-response'), 'newer-response'],
    ['another tab', ({ storage }) => storage.setItem(key, 'other-tab'), 'other-tab'],
    ['expiry', ({ session, storage }) => { storage.removeItem(key); session.observe(); }, null],
  ])('ignores a delayed rotation after %s', async (_, change, expected) => {
    const state = fixture();
    const started = state.session.current();
    const receipt = Promise.withResolvers();
    const apply = receipt.promise.then(token => state.session.rotate(started, token));
    change(state);
    receipt.resolve('late-response');
    expect(await apply).toBe(false);
    expect(state.storage.getItem(key)).toBe(expected);
  });
});

describe('session replacement in another tab', () => {
  it('uses only the committed, verified bearer, even before the storage event is handled', () => {
    const { storage, session } = fixture();
    const uninstall = installBrowserAuthSession(session);
    try {
      expect(getBrowserAuthToken()).toBe('original');
      storage.setItem(key, 'new-account');
      expect(getBrowserAuthToken()).toBeNull();
      expect(() => getBrowserAuthToken(true)).toThrow('Your sign-in changed');
      const pending = session.observe();
      expect(getBrowserAuthToken()).toBeNull();
      session.activate(pending, 2);
      expect(session.current(1)).toBeNull();
      expect(session.current(2)?.token).toBe('new-account');
      expect(getBrowserAuthToken()).toBe('new-account');
    } finally { uninstall(); }
  });

  it('rejects validation that finished after another replacement or logout', () => {
    const { storage, session } = fixture();
    storage.setItem(key, 'older-pending');
    const older = session.observe();
    storage.setItem(key, 'newer-pending');
    const newer = session.observe();
    session.activate(older, 1);
    expect(session.current()).toBeNull();
    session.activate(newer, 2);
    session.activate(older, 1);
    expect(session.current()?.token).toBe('newer-pending');
    storage.removeItem(key);
    expect(session.observe()).toBeNull();
    session.activate(newer, 2);
    expect(session.current()).toBeNull();
  });
});
