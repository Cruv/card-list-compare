import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { login, register, getRegistrationStatus } from '../lib/api';
import { toast } from './Toast';
import PasswordRequirements from './PasswordRequirements';
import './AuthBar.css';

export default function AuthBar({ onShowForgotPassword }) {
  const { user, loading, loginUser, logoutUser } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [showForm, setShowForm] = useState(false);
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [registrationMode, setRegistrationMode] = useState('open'); // 'open' | 'invite' | 'closed'

  useEffect(() => {
    getRegistrationStatus()
      .then(data => {
        // Support both new registrationMode and legacy registrationEnabled
        const mode = data.registrationMode || (data.registrationEnabled ? 'open' : 'closed');
        setRegistrationMode(mode);
      })
      .catch(() => {}); // default to open if check fails
  }, []);

  if (loading) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      let data;
      if (isRegister) {
        data = await register(username, password, registrationMode === 'invite' ? inviteCode : undefined);
      } else {
        data = await login(username, password);
      }
      loginUser(data.token, data.user);
      setShowForm(false);
      setUsername('');
      setPassword('');
      setInviteCode('');
      if (isRegister) {
        toast.success('Account created! You\'re now logged in.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const themeToggle = (
    <button
      className="auth-bar-btn auth-bar-theme-toggle"
      onClick={toggleTheme}
      type="button"
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label="Toggle theme"
    >
      {theme === 'dark' ? '\u2600' : '\u263D'}
    </button>
  );

  const guideButton = (
    <button
      className="auth-bar-btn"
      onClick={() => { window.location.hash = '#guide'; }}
      type="button"
      title="How to use this app"
    >
      Guide
    </button>
  );

  if (user) {
    return (
      <div className="auth-bar">
        {themeToggle}
        {guideButton}
        <span className="auth-bar-user">{user.username}</span>
        {user.isAdmin && (
          <button className="auth-bar-btn" onClick={() => { window.location.hash = '#admin'; }} type="button" title="Admin Panel">
            Admin
          </button>
        )}
        <button className="auth-bar-btn" onClick={() => { window.location.hash = '#library'; }} type="button" title="Deck Library">
          Decks
        </button>
        <button className="auth-bar-btn" onClick={() => { window.location.hash = '#settings'; }} type="button" title="Account Settings">
          Settings
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
        {themeToggle}
        {guideButton}
        <button className="auth-bar-btn" onClick={() => setShowForm(true)} type="button">
          Log In
        </button>
      </div>
    );
  }

  return (
    <div className="auth-bar">
      {themeToggle}
      {guideButton}
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
        {isRegister && registrationMode === 'invite' && (
          <input
            type="text"
            placeholder="Invite Code"
            value={inviteCode}
            onChange={e => setInviteCode(e.target.value)}
            disabled={submitting}
            aria-label="Invite Code"
            autoComplete="off"
          />
        )}
        {isRegister && <PasswordRequirements password={password} />}
        <button className="auth-bar-btn auth-bar-btn--primary" type="submit" disabled={submitting}>
          {submitting ? '...' : isRegister ? 'Register' : 'Log In'}
        </button>
        {registrationMode !== 'closed' && (
          <button
            className="auth-bar-btn"
            type="button"
            onClick={() => { setIsRegister(!isRegister); setError(null); setInviteCode(''); }}
          >
            {isRegister ? 'Have an account?' : 'New user?'}
          </button>
        )}
        <button
          className="auth-bar-btn"
          type="button"
          onClick={() => { setShowForm(false); setError(null); setIsRegister(false); setInviteCode(''); }}
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
