export const AUTH_TOKEN_KEY = 'clc-auth-token';

let browserSession;

export function installBrowserAuthSession(session) {
  browserSession = session;
  return () => { if (browserSession === session) browserSession = undefined; };
}

export function getStoredAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

export function getBrowserAuthToken(waitForAccount = false) {
  if (!browserSession) return getStoredAuthToken();
  const token = browserSession.current()?.token ?? null;
  if (!token && waitForAccount && browserSession.hasCredential()) {
    throw new Error('Your sign-in changed. Wait for the account to finish loading and try again.');
  }
  return token;
}

export function createAuthSession(storage) {
  let candidate = null;
  let active = null;

  function observe() {
    const token = storage.getItem(AUTH_TOKEN_KEY);
    if (token !== (candidate?.token ?? null)) {
      candidate = token ? { token } : null;
      active = null;
    }
    return candidate;
  }

  function matches(observed) {
    return !!observed && observed === candidate && storage.getItem(AUTH_TOKEN_KEY) === observed.token;
  }

  function isCurrent(session) {
    return !!session && session === active && matches(session.candidate);
  }

  function signIn(token, userId) {
    storage.setItem(AUTH_TOKEN_KEY, token);
    candidate = { token };
    active = { token, userId, candidate };
  }

  return {
    observe, matches, isCurrent, signIn,
    hasCredential: () => !!candidate || !!storage.getItem(AUTH_TOKEN_KEY),
    current: userId => isCurrent(active) && (userId === undefined || active.userId === userId) ? active : null,
    activate(observed, userId) {
      if (!matches(observed)) return;
      active = { token: observed.token, userId, candidate: observed };
    },
    signOut() {
      storage.removeItem(AUTH_TOKEN_KEY);
      candidate = null;
      active = null;
    },
    rotate(session, token) {
      if (!isCurrent(session)) return false;
      if (typeof token !== 'string' || !token) throw new Error('The password response did not include a new session. Sign in again if needed.');
      signIn(token, session.userId);
      return true;
    },
  };
}
