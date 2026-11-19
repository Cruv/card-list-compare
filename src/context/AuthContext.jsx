import { createContext, useContext, useState, useEffect, useLayoutEffect, useCallback } from 'react';
import { changePassword, getMe } from '../lib/api';
import { AUTH_TOKEN_KEY, createAuthSession, getStoredAuthToken, installBrowserAuthSession } from '../lib/authSession';
import { toast } from '../components/Toast';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [identity, setIdentity] = useState(null);
  const [session] = useState(() => createAuthSession(localStorage));
  const [loading, setLoading] = useState(() => !!getStoredAuthToken());
  const [noteDraft, setNoteDraft] = useState(null);

  useLayoutEffect(() => installBrowserAuthSession(session), [session]);

  // Accept the bearer when the view commits its verified account identity.
  useLayoutEffect(() => {
    if (identity?.candidate) session.activate(identity.candidate, identity.user.id);
  }, [identity, session]);

  useEffect(() => {
    const listeners = new AbortController();
    let validation;
    let lastCandidate;

    function reconcile() {
      if (listeners.signal.aborted) return;
      const candidate = session.observe();
      if (candidate && candidate === lastCandidate) return;
      lastCandidate = candidate;
      validation?.abort();
      if (session.current()) return;
      setIdentity(null);
      setLoading(!!candidate);
      if (!candidate) {
        setNoteDraft(null);
        return;
      }

      validation = new AbortController();
      const { signal } = validation;
      const current = () => !signal.aborted && session.matches(candidate);
      getMe(candidate.token, signal)
        .then(data => {
          if (!current()) return;
          const verifiedUser = data.user;
          setNoteDraft(previous => previous?.userId === verifiedUser?.id ? previous : null);
          if (verifiedUser?.id != null) setIdentity({ user: verifiedUser, candidate });
        })
        .catch(error => {
          if (!current()) return;
          setNoteDraft(null);
          if (error.message?.toLowerCase().includes('suspended')) {
            toast.error('Your account has been suspended. Please contact an admin.');
          }
        })
        .finally(() => { if (current()) setLoading(false); });
    }

    const onStorage = event => {
      if (event.storageArea !== localStorage || (event.key !== AUTH_TOKEN_KEY && event.key !== null)) return;
      // Read the event as well as storage. Another tab can sign back in before
      // this tab processes the earlier sign-out notification.
      if (event.newValue === null) setNoteDraft(null);
      reconcile();
    };
    const onExpired = () => { setNoteDraft(null); reconcile(); };
    window.addEventListener('storage', onStorage, { signal: listeners.signal });
    window.addEventListener('auth-expired', onExpired, { signal: listeners.signal });
    queueMicrotask(reconcile);
    return () => { listeners.abort(); validation?.abort(); };
  }, [session]);

  const loginUser = useCallback((token, userData) => {
    session.signIn(token, userData.id);
    setNoteDraft(null);
    setIdentity({ user: userData });
    setLoading(false);
  }, [session]);

  const user = identity?.user ?? null;
  const logoutUser = useCallback((started = session.current(user?.id)) => {
    if (!session.isCurrent(started)) return false;
    session.signOut();
    setNoteDraft(null);
    setIdentity(null);
    setLoading(false);
    return true;
  }, [session, user?.id]);

  const editDeckNotesDraft = useCallback((userId, deckId, text, expected) => {
    if (!session.current(userId)) return;
    setNoteDraft(previous => {
      if (text !== null) return { userId, deckId, text };
      const sameDeck = previous?.userId === userId && previous.deckId === deckId;
      return sameDeck && (!expected || previous === expected) ? null : previous;
    });
  }, [session]);

  const discardNotesOutsideDeck = useCallback(deckId => {
    setNoteDraft(previous => previous?.deckId === deckId ? previous : null);
  }, []);

  const changeUserPassword = useCallback(async (currentPassword, newPassword) => {
    const started = session.current(user?.id);
    if (!started) throw new Error('Your sign-in changed. Sign in again to change your password.');
    const result = await changePassword(currentPassword, newPassword, started.token).catch(error => {
      if (session.isCurrent(started)) throw error;
      return null;
    });
    return result ? session.rotate(started, result.token) : false;
  }, [session, user?.id]);

  return (
    <AuthContext.Provider value={{ user, loading, loginUser, logoutUser, changeUserPassword,
      getSession: session.current, isCurrentSession: session.isCurrent,
      noteDraft: user && noteDraft?.userId === user.id ? noteDraft : null, editDeckNotesDraft, discardNotesOutsideDeck }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
