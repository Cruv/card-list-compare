import { useState } from 'react';
import { resetPassword } from '../lib/api';
import { toast } from './Toast';
import './UserSettings.css';

export default function ResetPassword({ token, onComplete }) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }

    setSubmitting(true);
    try {
      await resetPassword(token, newPassword);
      setDone(true);
      toast.success('Password reset successfully! You can now log in.');
      // Clean the URL
      window.history.replaceState(null, '', window.location.pathname);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="user-settings" style={{ margin: '24px auto' }}>
      <div className="user-settings-header">
        <h2>Set New Password</h2>
      </div>

      {done ? (
        <section className="user-settings-section">
          <p style={{ fontSize: '13px', color: 'var(--text-primary)', margin: '0 0 12px' }}>
            Your password has been reset. You can now log in with your new password.
          </p>
          <button className="btn btn-primary btn-sm" onClick={onComplete} type="button">
            Go to Login
          </button>
        </section>
      ) : (
        <section className="user-settings-section">
          <form className="user-settings-form" onSubmit={handleSubmit}>
            <label htmlFor="reset-new-pw">New Password</label>
            <input
              id="reset-new-pw"
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              disabled={submitting}
              autoComplete="new-password"
              minLength={8}
              autoFocus
              required
            />
            <label htmlFor="reset-confirm-pw">Confirm New Password</label>
            <input
              id="reset-confirm-pw"
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              disabled={submitting}
              autoComplete="new-password"
              minLength={8}
              required
            />
            <button className="btn btn-primary btn-sm" type="submit" disabled={submitting}>
              {submitting ? '...' : 'Reset Password'}
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
