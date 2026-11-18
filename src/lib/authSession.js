const TOKEN_KEY = 'clc-auth-token';

export function createAuthSession(storage) {
  const initialToken = storage.getItem(TOKEN_KEY);
  let active = initialToken ? { token: initialToken } : null;

  function isCurrent(session) {
    return !!session && session === active && storage.getItem(TOKEN_KEY) === session.token;
  }

  function signIn(token) {
    storage.setItem(TOKEN_KEY, token);
    active = { token };
  }

  return {
    current: () => isCurrent(active) ? active : null,
    isCurrent,
    signIn,
    signOut() {
      storage.removeItem(TOKEN_KEY);
      active = null;
    },
    forget() { active = null; },
    rotate(session, token) {
      if (!isCurrent(session)) return false;
      if (typeof token !== 'string' || !token) throw new Error('The password response did not include a new session. Sign in again if needed.');
      signIn(token);
      return true;
    },
  };
}
