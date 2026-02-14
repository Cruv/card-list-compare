import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from './ConfirmModal';
import { toast } from './Toast';
import {
  getMe, changePassword, updateEmail, deleteAccount, resendVerification,
  createInviteCode, getMyInvites, deleteInviteCode,
} from '../lib/api';
import PasswordRequirements from './PasswordRequirements';
import './UserSettings.css';

export default function UserSettings() {
  const { user, logoutUser, loginUser } = useAuth();
  const [confirm, ConfirmDialog] = useConfirm();
  const [activeTab, setActiveTab] = useState('account');

  // User capabilities
  const [canInvite, setCanInvite] = useState(false);

  // Account info
  const [email, setEmail] = useState('');
  const [createdAt, setCreatedAt] = useState('');
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailVerified, setEmailVerified] = useState(false);
  const [resending, setResending] = useState(false);

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
      setEmailVerified(!!data.user.emailVerified);
      setCanInvite(!!data.user.canInvite);
    }).catch(() => {});
  }, []);

  async function handleEmailSave(e) {
    e.preventDefault();
    setEmailSaving(true);
    try {
      const data = await updateEmail(email.trim() || null);
      setEmail(data.user.email || '');
      setEmailVerified(!!data.user.emailVerified);
      if (email.trim()) {
        toast.success('Email updated — check your inbox for a verification link');
      } else {
        toast.success('Email removed');
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setEmailSaving(false);
    }
  }

  async function handleResendVerification() {
    setResending(true);
    try {
      await resendVerification();
      toast.success('Verification email sent — check your inbox');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setResending(false);
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
      const data = await changePassword(currentPassword, newPassword);
      // Update token so current session stays valid after password_changed_at is set
      if (data.token) {
        localStorage.setItem('clc-auth-token', data.token);
      }
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
    <div className="settings-page">
      <button className="settings-back-link" onClick={() => { window.location.hash = ''; }} type="button">
        &larr; Back to Compare
      </button>
      <div className="user-settings">
        {ConfirmDialog}
        <div className="user-settings-header">
          <h2>Account Settings</h2>
        </div>

        <nav className="user-settings-tabs">
          <button
            className={`user-settings-tab${activeTab === 'account' ? ' user-settings-tab--active' : ''}`}
            onClick={() => setActiveTab('account')}
            type="button"
          >
            Account
          </button>
          {(canInvite || user?.isAdmin) && (
            <button
              className={`user-settings-tab${activeTab === 'invites' ? ' user-settings-tab--active' : ''}`}
              onClick={() => setActiveTab('invites')}
              type="button"
            >
              Invites
            </button>
          )}
        </nav>

      {activeTab === 'account' && (
        <div className="user-settings-panel">

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
          {email && (
            <div className="user-settings-email-status">
              {emailVerified ? (
                <span className="email-verified">{'\u2713'} Verified</span>
              ) : (
                <span className="email-unverified">
                  Not verified
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={handleResendVerification}
                    disabled={resending}
                  >
                    {resending ? '...' : 'Resend'}
                  </button>
                </span>
              )}
            </div>
          )}
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
          <PasswordRequirements password={newPassword} />
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
      )}

      {activeTab === 'invites' && (canInvite || user?.isAdmin) && (
        <div className="user-settings-panel">
          <InviteManagement />
        </div>
      )}

      </div>
    </div>
  );
}

// --- Invite Code Management ---

function InviteManagement() {
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [maxUses, setMaxUses] = useState(1);
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getMyInvites();
      setInvites(data.invites);
    } catch {
      toast.error('Failed to load invite codes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleCreate(e) {
    e.preventDefault();
    setCreating(true);
    try {
      await createInviteCode(maxUses);
      toast.success('Invite code created');
      await refresh();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id) {
    try {
      await deleteInviteCode(id);
      toast.success('Invite code deleted');
      await refresh();
    } catch (err) {
      toast.error(err.message);
    }
  }

  function handleCopy(code, id) {
    navigator.clipboard.writeText(code).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso + 'Z').toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  }

  return (
    <div className="settings-invites">
      <section className="user-settings-section" style={{ borderTop: 'none' }}>
        <h3>Invite Codes</h3>
        <p className="user-settings-desc">
          Create invite codes to share with others. Each code can be used a limited number of times.
        </p>

        <form className="settings-invite-create" onSubmit={handleCreate}>
          <label htmlFor="invite-max-uses">Max uses:</label>
          <select
            id="invite-max-uses"
            value={maxUses}
            onChange={e => setMaxUses(parseInt(e.target.value, 10))}
            disabled={creating}
          >
            <option value={1}>1</option>
            <option value={3}>3</option>
            <option value={5}>5</option>
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
          </select>
          <button className="btn btn-primary btn-sm" type="submit" disabled={creating}>
            {creating ? '...' : 'Create Code'}
          </button>
        </form>

        {loading ? (
          <p className="settings-tracker-empty">Loading...</p>
        ) : invites.length === 0 ? (
          <p className="settings-tracker-empty">No invite codes yet. Create one above.</p>
        ) : (
          <ul className="settings-invite-list">
            {invites.map(inv => (
              <li key={inv.id} className="settings-invite-item">
                <div className="settings-invite-info">
                  <code className="settings-invite-code">{inv.code}</code>
                  <button
                    className="settings-invite-copy"
                    onClick={() => handleCopy(inv.code, inv.id)}
                    type="button"
                    title="Copy code"
                  >
                    {copiedId === inv.id ? '\u2713' : 'Copy'}
                  </button>
                  <span className="settings-invite-usage">
                    {inv.use_count}/{inv.max_uses > 0 ? inv.max_uses : '\u221E'} used
                  </span>
                  <span className="settings-invite-date">{formatDate(inv.created_at)}</span>
                </div>
                <button
                  className="btn btn-secondary btn-sm btn-danger"
                  onClick={() => handleDelete(inv.id)}
                  type="button"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
