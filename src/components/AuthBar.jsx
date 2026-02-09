import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { login, register } from '../lib/api';
import { toast } from './Toast';
import './AuthBar.css';

export default function AuthBar({ onShowSettings, onShowForgotPassword }) {
  const { user, loading, loginUser, logoutUser } = useAuth();
  const [showForm, setShowForm] = useState(false);
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const fn = isRegister ? register : login;
      const data = await fn(username, password);
      loginUser(data.token, data.user);
      setShowForm(false);
      setUsername('');
      setPassword('');
      if (isRegister) {
        toast.success('Account created! You\'re now logged in.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (user) {
    return (
      <div className="auth-bar">
        <span className="auth-bar-user">{user.username}</span>
        <button className="auth-bar-btn" onClick={onShowSettings} type="button" title="Account Settings">
          ⚙ Settings
        </button>
        <button className="auth-bar-btn" onClick={logoutUser} type="button">
          Log Out
        </button>
      </div>
    );
  }

  if (!showForm) {
    return (
      <div className="auth-bar">
        <button className="auth-bar-btn" onClick={() => setShowForm(true)} type="button">
          Log In
        </button>
      </div>
    );
  }

  return (
    <div className="auth-bar">
      <form className="auth-bar-form" onSubmit={handleSubmit} aria-label="Authentication">
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={e => setUsername(e.target.value)}
          autoFocus
          disabled={submitting}
          aria-label="Username"
          autoComplete="username"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          disabled={submitting}
          aria-label="Password"
          autoComplete={isRegister ? 'new-password' : 'current-password'}
        />
        <button className="auth-bar-btn auth-bar-btn--primary" type="submit" disabled={submitting}>
          {submitting ? '...' : isRegister ? 'Register' : 'Log In'}
        </button>
        <button
          className="auth-bar-btn"
          type="button"
          onClick={() => { setIsRegister(!isRegister); setError(null); }}
        >
          {isRegister ? 'Have an account?' : 'New user?'}
        </button>
        <button
          className="auth-bar-btn"
          type="button"
          onClick={() => { setShowForm(false); setError(null); }}
        >
          Cancel
        </button>
        {!isRegister && (
          <button
            className="auth-bar-link"
            type="button"
            onClick={() => { setShowForm(false); onShowForgotPassword?.(); }}
          >
            Forgot password?
          </button>
        )}
      </form>
      {error && <div className="auth-bar-error" role="alert">{error}</div>}
    </div>
  );
}
