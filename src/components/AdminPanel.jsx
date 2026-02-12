import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from './ConfirmModal';
import { toast } from './Toast';
import {
  getAdminStats,
  getAdminUsers,
  adminResetPassword,
  adminDeleteUser,
  adminToggleAdmin,
  getAdminSettings,
  updateAdminSetting,
  getAdminShares,
  adminDeleteShare,
} from '../lib/api';
import './AdminPanel.css';

export default function AdminPanel({ onClose }) {
  const { user } = useAuth();
  const [confirm, ConfirmDialog] = useConfirm();
  const [activeTab, setActiveTab] = useState('stats');

  return (
    <div className="admin-panel">
      {ConfirmDialog}
      <div className="admin-panel-header">
        <h2>Admin Panel</h2>
        <button className="btn btn-secondary btn-sm" onClick={onClose} type="button">Close</button>
      </div>

      <div className="admin-panel-tabs">
        {['stats', 'users', 'settings', 'shares'].map(tab => (
          <button
            key={tab}
            className={`admin-panel-tab${activeTab === tab ? ' admin-panel-tab--active' : ''}`}
            onClick={() => setActiveTab(tab)}
            type="button"
          >
            {tab === 'stats' ? 'Stats' : tab === 'users' ? 'Users' : tab === 'settings' ? 'Settings' : 'Shares'}
          </button>
        ))}
      </div>

      <div className="admin-panel-section">
        {activeTab === 'stats' && <StatsTab />}
        {activeTab === 'users' && <UsersTab currentUserId={user?.id} confirm={confirm} />}
        {activeTab === 'settings' && <SettingsTab />}
        {activeTab === 'shares' && <SharesTab confirm={confirm} />}
      </div>
    </div>
  );
}

// --- Stats Tab ---

function StatsTab() {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    getAdminStats().then(setStats).catch(() => toast.error('Failed to load stats'));
  }, []);

  if (!stats) return <p className="admin-empty">Loading...</p>;

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <div className="admin-stats-grid">
      <div className="admin-stat-card">
        <div className="admin-stat-value">{stats.totalUsers}</div>
        <div className="admin-stat-label">Users</div>
      </div>
      <div className="admin-stat-card">
        <div className="admin-stat-value">{stats.totalTrackedDecks}</div>
        <div className="admin-stat-label">Tracked Decks</div>
      </div>
      <div className="admin-stat-card">
        <div className="admin-stat-value">{stats.totalSnapshots}</div>
        <div className="admin-stat-label">Snapshots</div>
      </div>
      <div className="admin-stat-card">
        <div className="admin-stat-value">{stats.totalSharedComparisons}</div>
        <div className="admin-stat-label">Shared Links</div>
      </div>
      <div className="admin-stat-card">
        <div className="admin-stat-value">{formatBytes(stats.dbSizeBytes)}</div>
        <div className="admin-stat-label">Database Size</div>
      </div>
    </div>
  );
}

// --- Users Tab ---

function UsersTab({ currentUserId, confirm }) {
  const [users, setUsers] = useState([]);
  const [resetId, setResetId] = useState(null);
  const [resetPw, setResetPw] = useState('');

  const refresh = useCallback(() => {
    getAdminUsers().then(d => setUsers(d.users)).catch(() => toast.error('Failed to load users'));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleResetPassword(userId) {
    if (!resetPw || resetPw.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    try {
      await adminResetPassword(userId, resetPw);
      toast.success('Password reset successfully');
      setResetId(null);
      setResetPw('');
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleDeleteUser(userId, username) {
    const confirmed = await confirm({
      title: `Delete user "${username}"?`,
      message: 'This will permanently delete their account and all tracked decks, snapshots, and data.',
      confirmLabel: 'Delete User',
      danger: true,
      typeToConfirm: username,
    });
    if (!confirmed) return;
    try {
      await adminDeleteUser(userId);
      toast.success(`User "${username}" deleted`);
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleToggleAdmin(userId, username, isCurrentlyAdmin) {
    const action = isCurrentlyAdmin ? 'Remove admin from' : 'Make admin';
    const confirmed = await confirm({
      title: `${action} "${username}"?`,
      message: isCurrentlyAdmin
        ? 'They will lose admin privileges.'
        : 'They will be able to manage users, settings, and shared comparisons.',
      confirmLabel: action,
      danger: isCurrentlyAdmin,
    });
    if (!confirmed) return;
    try {
      await adminToggleAdmin(userId);
      toast.success(`${username} is ${isCurrentlyAdmin ? 'no longer' : 'now'} an admin`);
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  }

  function formatDate(iso) {
    if (!iso) return '...';
    return new Date(iso + 'Z').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  return (
    <ul className="admin-users-list">
      {users.map(u => (
        <li key={u.id} className="admin-user-row">
          <div className="admin-user-info">
            <div>
              <span className="admin-user-name">{u.username}</span>
              {!!u.is_admin && <span className="admin-user-badge">Admin</span>}
            </div>
            <div className="admin-user-meta">
              {u.email || 'No email'} &middot; {u.tracked_deck_count} decks &middot; {u.snapshot_count} snapshots &middot; Joined {formatDate(u.created_at)}
            </div>
            {resetId === u.id && (
              <div className="admin-user-reset-form">
                <input
                  type="password"
                  placeholder="New password (8+ chars)"
                  value={resetPw}
                  onChange={e => setResetPw(e.target.value)}
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleResetPassword(u.id);
                    if (e.key === 'Escape') { setResetId(null); setResetPw(''); }
                  }}
                />
                <button className="btn btn-primary btn-sm" type="button" onClick={() => handleResetPassword(u.id)}>Set</button>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => { setResetId(null); setResetPw(''); }}>Cancel</button>
              </div>
            )}
          </div>
          {u.id !== currentUserId && (
            <div className="admin-user-actions">
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => { setResetId(u.id); setResetPw(''); }}>
                Reset PW
              </button>
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => handleToggleAdmin(u.id, u.username, !!u.is_admin)}>
                {u.is_admin ? 'Demote' : 'Promote'}
              </button>
              <button className="btn btn-secondary btn-sm btn-danger" type="button" onClick={() => handleDeleteUser(u.id, u.username)}>
                Delete
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// --- Settings Tab ---

function SettingsTab() {
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    getAdminSettings().then(d => setSettings(d.settings)).catch(() => toast.error('Failed to load settings'));
  }, []);

  async function handleToggleRegistration() {
    const current = settings?.registration_enabled;
    const newVal = current === 'true' ? 'false' : 'true';
    try {
      await updateAdminSetting('registration_enabled', newVal);
      setSettings(prev => ({ ...prev, registration_enabled: newVal }));
      toast.success(`Registration ${newVal === 'true' ? 'enabled' : 'disabled'}`);
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (!settings) return <p className="admin-empty">Loading...</p>;

  return (
    <div>
      <div className="admin-setting-row">
        <div>
          <div className="admin-setting-label">Allow Registration</div>
          <div className="admin-setting-desc">
            {settings.registration_enabled === 'true'
              ? 'New users can create accounts freely.'
              : 'Registration is disabled. Only admins can create accounts.'}
          </div>
        </div>
        <label className="admin-toggle">
          <input
            type="checkbox"
            checked={settings.registration_enabled === 'true'}
            onChange={handleToggleRegistration}
          />
          <span className="admin-toggle-slider" />
        </label>
      </div>
    </div>
  );
}

// --- Shares Tab ---

function SharesTab({ confirm }) {
  const [shares, setShares] = useState([]);

  const refresh = useCallback(() => {
    getAdminShares().then(d => setShares(d.shares)).catch(() => toast.error('Failed to load shares'));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleDelete(id) {
    const confirmed = await confirm({
      title: 'Delete shared comparison?',
      message: 'This will permanently remove the shared link. Anyone with the link will see an error.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await adminDeleteShare(id);
      toast.success('Shared comparison deleted');
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  }

  function formatDate(iso) {
    if (!iso) return '...';
    return new Date(iso + 'Z').toLocaleString();
  }

  function formatSize(before, after) {
    const total = (before || 0) + (after || 0);
    if (total < 1024) return `${total} chars`;
    return `${(total / 1024).toFixed(1)}K chars`;
  }

  if (shares.length === 0) return <p className="admin-empty">No shared comparisons.</p>;

  return (
    <ul className="admin-shares-list">
      {shares.map(s => (
        <li key={s.id} className="admin-share-item">
          <div className="admin-share-info">
            <div className="admin-share-title">{s.title || s.id}</div>
            <div className="admin-share-meta">
              {formatDate(s.created_at)} &middot; {formatSize(s.before_length, s.after_length)}
            </div>
          </div>
          <button className="btn btn-secondary btn-sm btn-danger" type="button" onClick={() => handleDelete(s.id)}>
            Delete
          </button>
        </li>
      ))}
    </ul>
  );
}
