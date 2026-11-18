import { describe, expect, it } from 'vitest';
import { createAuthSession } from './authSession.js';

const key = 'clc-auth-token';

function fixture() {
  const values = new Map([[key, 'original']]);
  const storage = {
    getItem: name => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
    removeItem: name => values.delete(name),
  };
  return { storage, session: createAuthSession(storage) };
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
    ['expiry', ({ session, storage }) => { storage.removeItem(key); session.forget(); }, null],
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
