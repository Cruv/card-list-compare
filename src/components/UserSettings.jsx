import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from './ConfirmModal';
import { toast } from './Toast';
import { getMe, changePassword, updateEmail, deleteAccount } from '../lib/api';
import './UserSettings.css';

export default function UserSettings({ onClose }) {
  const { user, logoutUser } = useAuth();
  const [confirm, ConfirmDialog] = useConfirm();

  // Account info
  const [email, setEmail] = useState('');
  const [createdAt, setCreatedAt] = useState('');
  const [emailSaving, setEmailSaving] = useState(false);

  // Change password
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);

  // Delete account
  const [deleteUsername, setDeleteUsername] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    getMe().then(data => {
      setEmail(data.user.email || '');
      setCreatedAt(data.user.createdAt || '');
    }).catch(() => {});
  }, []);

  async function handleEmailSave(e) {
    e.preventDefault();
    setEmailSaving(true);
    try {
      const data = await updateEmail(email.trim() || null);
      setEmail(data.user.email || '');
      toast.success(email.trim() ? 'Email updated' : 'Email removed');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setEmailSaving(false);
    }
  }

  async function handlePasswordChange(e) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error('New passwords do not match');
      return;
    }
    setPasswordSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      toast.success('Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setPasswordSaving(false);
    }
  }

  async function handleDeleteAccount(e) {
    e.preventDefault();
    const confirmed = await confirm({
      title: 'Delete your account?',
      message: 'This will permanently delete your account and all tracked decks, snapshots, and data. This cannot be undone.',
      confirmLabel: 'Delete Account',
      danger: true,
    });
    if (!confirmed) return;

    setDeleting(true);
    try {
      await deleteAccount(deleteUsername);
      toast.success('Account deleted');
      logoutUser();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
    }
  }

  const formattedDate = createdAt
    ? new Date(createdAt + 'Z').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : '...';

  return (
    <div className="user-settings">
      {ConfirmDialog}
      <div className="user-settings-header">
        <h2>Account Settings</h2>
        <button className="btn btn-secondary btn-sm" onClick={onClose} type="button">Close</button>
      </div>

      {/* Account Info */}
      <section className="user-settings-section">
        <h3>Account Info</h3>
        <div className="user-settings-field">
          <label>Username</label>
          <span className="user-settings-value">{user?.username}</span>
        </div>
        <div className="user-settings-field">
          <label>Member since</label>
          <span className="user-settings-value">{formattedDate}</span>
        </div>
        <form className="user-settings-form" onSubmit={handleEmailSave}>
          <label htmlFor="settings-email">Email <span className="user-settings-optional">(optional — needed for password reset)</span></label>
          <div className="user-settings-input-row">
            <input
              id="settings-email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              disabled={emailSaving}
              autoComplete="email"
            />
            <button className="btn btn-primary btn-sm" type="submit" disabled={emailSaving}>
              {emailSaving ? '...' : 'Save'}
            </button>
          </div>
        </form>
      </section>

      {/* Change Password */}
      <section className="user-settings-section">
        <h3>Change Password</h3>
        <form className="user-settings-form" onSubmit={handlePasswordChange}>
          <label htmlFor="settings-current-pw">Current Password</label>
          <input
            id="settings-current-pw"
            type="password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            disabled={passwordSaving}
            autoComplete="current-password"
            required
          />
          <label htmlFor="settings-new-pw">New Password</label>
          <input
            id="settings-new-pw"
            type="password"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            disabled={passwordSaving}
            autoComplete="new-password"
            minLength={8}
            required
          />
          <label htmlFor="settings-confirm-pw">Confirm New Password</label>
          <input
            id="settings-confirm-pw"
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            disabled={passwordSaving}
            autoComplete="new-password"
            minLength={8}
            required
          />
          <button className="btn btn-primary btn-sm" type="submit" disabled={passwordSaving}>
            {passwordSaving ? '...' : 'Change Password'}
          </button>
        </form>
      </section>

      {/* Danger Zone */}
      <section className="user-settings-section user-settings-danger">
        <h3>Danger Zone</h3>
        <p>Permanently delete your account and all associated data. This action cannot be undone.</p>
        <form className="user-settings-form" onSubmit={handleDeleteAccount}>
          <label htmlFor="settings-delete-confirm">Type your username to confirm</label>
          <div className="user-settings-input-row">
            <input
              id="settings-delete-confirm"
              type="text"
              placeholder={user?.username}
              value={deleteUsername}
              onChange={e => setDeleteUsername(e.target.value)}
              disabled={deleting}
              autoComplete="off"
            />
            <button
              className="btn btn-sm btn-danger"
              type="submit"
              disabled={deleting || deleteUsername.toLowerCase() !== (user?.username || '').toLowerCase()}
            >
              {deleting ? '...' : 'Delete Account'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
