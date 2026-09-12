import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { login, register, getRegistrationStatus } from '../lib/api';
import { toast } from './Toast';
import PasswordRequirements from './PasswordRequirements';
import { useModalLayer } from '../lib/useModalLayer';
import Icon from './Icon';
import './AuthBar.css';

function AuthDialog({ children, onClose, title }) {
  const ref = useRef(null);
  useModalLayer(onClose, { containerRef: ref });
  return <div className="auth-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}><section className="auth-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="auth-title" tabIndex={-1}><div className="auth-modal-heading"><span className="auth-emblem"><Icon name="cards" size={28} /></span><button className="shell-icon-button" onClick={onClose} aria-label="Close sign in"><Icon name="close" /></button></div><h2 id="auth-title">{title}</h2><p>Keep your decks, artwork and print batches together.</p>{children}</section></div>;
}

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

  const closeForm = () => { setShowForm(false); setError(null); setIsRegister(false); setInviteCode(''); setPassword(''); };
  return <div className="auth-bar">
    <button className="auth-bar-btn auth-bar-theme-toggle" onClick={toggleTheme} type="button" title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-label="Toggle theme"><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} /></button>
    {user ? <><a className="auth-account" href="#settings" title="Account settings"><span className="auth-avatar">{user.username?.slice(0, 1).toUpperCase()}</span><span className="auth-bar-user">{user.username}</span></a><button className="auth-bar-btn auth-logout" onClick={logoutUser} type="button" aria-label="Log Out" title="Log Out"><Icon name="logout" size={18} /></button></> : <button className="auth-bar-btn auth-bar-btn--primary" onClick={event => { event.currentTarget.focus(); setShowForm(true); }} type="button">Log In</button>}
    {showForm && !user && <AuthDialog onClose={closeForm} title={isRegister ? 'Make room for your decks.' : 'Welcome back.'}>
      <form className="auth-bar-form" onSubmit={handleSubmit} aria-label="Authentication">
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={e => setUsername(e.target.value)}
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
          {submitting ? 'Signing in…' : isRegister ? 'Create account' : 'Log In'}
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
          onClick={closeForm}
        >
          Cancel
        </button>
        {!isRegister && (
          <button
            className="auth-bar-link"
            type="button"
            onClick={() => { closeForm(); onShowForgotPassword?.(); }}
          >
            Forgot password?
          </button>
        )}
      </form>
      {error && <div className="auth-bar-error" role="alert">{error}</div>}
    </AuthDialog>}
  </div>;
}
