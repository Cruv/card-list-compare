import { useState, useEffect } from 'react';
import { forgotPassword, getEmailConfigured } from '../lib/api';
import { toast } from './Toast';
import './UserSettings.css';

export default function ForgotPassword({ onClose }) {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [emailConfigured, setEmailConfigured] = useState(null);

  useEffect(() => {
    getEmailConfigured()
      .then(data => setEmailConfigured(data.configured))
      .catch(() => setEmailConfigured(false));
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email.trim()) return;

    setSubmitting(true);
    try {
      await forgotPassword(email.trim());
      setSent(true);
      toast.success('If an account with that email exists, a reset link has been sent.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="user-settings">
      <div className="user-settings-header">
        <h2>Reset Password</h2>
        <button className="btn btn-secondary btn-sm" onClick={onClose} type="button">Close</button>
      </div>

      {emailConfigured === false && (
        <section className="user-settings-section">
          <p style={{ color: 'var(--accent-red)', fontSize: '13px', margin: 0 }}>
            Email is not configured on this server. Contact your admin to reset your password.
          </p>
        </section>
      )}

      {emailConfigured !== false && !sent && (
        <section className="user-settings-section">
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '0 0 12px' }}>
            Enter the email address associated with your account and we&apos;ll send you a link to reset your password.
          </p>
          <form className="user-settings-form" onSubmit={handleSubmit}>
            <label htmlFor="forgot-email">Email</label>
            <div className="user-settings-input-row">
              <input
                id="forgot-email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                disabled={submitting}
                autoFocus
                required
              />
              <button className="btn btn-primary btn-sm" type="submit" disabled={submitting || !email.trim()}>
                {submitting ? '...' : 'Send Reset Link'}
              </button>
            </div>
          </form>
        </section>
      )}

      {sent && (
        <section className="user-settings-section">
          <p style={{ fontSize: '13px', color: 'var(--text-primary)', margin: 0 }}>
            If an account with that email exists, a reset link has been sent. Check your inbox (and spam folder).
          </p>
        </section>
      )}
    </div>
  );
}
