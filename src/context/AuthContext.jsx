import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getMe } from '../lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('clc-auth-token');
    if (!token) {
      setLoading(false);
      return;
    }

    getMe()
      .then(data => setUser(data.user))
      .catch(() => localStorage.removeItem('clc-auth-token'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handler = () => setUser(null);
    window.addEventListener('auth-expired', handler);
    return () => window.removeEventListener('auth-expired', handler);
  }, []);

  const loginUser = useCallback((token, userData) => {
    localStorage.setItem('clc-auth-token', token);
    setUser(userData);
  }, []);

  const logoutUser = useCallback(() => {
    localStorage.removeItem('clc-auth-token');
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, loginUser, logoutUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
