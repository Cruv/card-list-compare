import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { changePassword, getMe } from '../lib/api';
import { createAuthSession } from '../lib/authSession';
import { toast } from '../components/Toast';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [session] = useState(() => createAuthSession(localStorage));
  // Only "loading" when there is actually a token to validate — deriving it up
  // front avoids a needless render pass (and a setState inside the effect) for
  // the common signed-out case.
  const [loading, setLoading] = useState(() => !!session.current());

  useEffect(() => {
    const initial = session.current();
    if (!initial) return;
    let canceled = false;

    getMe()
      .then(data => {
        if (!canceled && session.isCurrent(initial)) setUser(data.user);
      })
      .catch((err) => {
        if (!canceled && session.isCurrent(initial) && err.message?.toLowerCase().includes('suspended')) {
          toast.error('Your account has been suspended. Please contact an admin.');
        }
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => { canceled = true; };
  }, [session]);

  useEffect(() => {
    const handler = () => { session.forget(); setUser(null); };
    window.addEventListener('auth-expired', handler);
    return () => window.removeEventListener('auth-expired', handler);
  }, [session]);

  const loginUser = useCallback((token, userData) => {
    session.signIn(token);
    setUser(userData);
  }, [session]);

  const logoutUser = useCallback(() => {
    session.signOut();
    setUser(null);
  }, [session]);

  const changeUserPassword = useCallback(async (currentPassword, newPassword) => {
    const started = session.current();
    if (!started) throw new Error('Your sign-in changed. Sign in again to change your password.');
    const result = await changePassword(currentPassword, newPassword, started.token).catch(error => {
      if (session.isCurrent(started)) throw error;
      return null;
    });
    return result ? session.rotate(started, result.token) : false;
  }, [session]);

  return (
    <AuthContext.Provider value={{ user, loading, loginUser, logoutUser, changeUserPassword,
      getSession: session.current, isCurrentSession: session.isCurrent }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
