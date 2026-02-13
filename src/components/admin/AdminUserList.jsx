import { useState, useEffect, useCallback, useRef } from 'react';
import { useConfirm } from '../ConfirmModal';
import { toast } from '../Toast';
import {
  getAdminUsers,
  adminResetPassword,
  adminDeleteUser,
  adminToggleAdmin,
  adminSuspendUser,
  adminUnsuspendUser,
  adminForceLogout,
} from '../../lib/api';

function timeAgo(iso) {
  if (!iso) return 'Never';
  const date = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDate(iso) {
  if (!iso) return '...';
  return new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

export default function AdminUserList({ currentUserId }) {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(25);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('created_at');
  const [order, setOrder] = useState('desc');
  const [loading, setLoading] = useState(true);
  const [resetId, setResetId] = useState(null);
  const [resetPw, setResetPw] = useState('');
  const [confirm, ConfirmDialog] = useConfirm();
  const searchTimerRef = useRef(null);
  const [searchInput, setSearchInput] = useState('');

  const refresh = useCallback(() => {
    setLoading(true);
    getAdminUsers({ search, sort, order, page, limit })
      .then(d => {
        setUsers(d.users);
        setTotal(d.total);
      })
      .catch(() => toast.error('Failed to load users'))
      .finally(() => setLoading(false));
  }, [search, sort, order, page, limit]);

  useEffect(() => { refresh(); }, [refresh]);

  // Debounced search
  function handleSearchChange(value) {
    setSearchInput(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setSearch(value);
      setPage(1);
    }, 300);
  }

  function handleSort(newSort) {
    if (sort === newSort) {
      setOrder(o => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(newSort);
      setOrder('desc');
    }
    setPage(1);
  }

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

  async function handleSuspend(userId, username) {
    const confirmed = await confirm({
      title: `Suspend "${username}"?`,
      message: 'They will be logged out immediately and unable to log in.',
      confirmLabel: 'Suspend',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await adminSuspendUser(userId);
      toast.success(`${username} suspended`);
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleUnsuspend(userId, username) {
    try {
      await adminUnsuspendUser(userId);
      toast.success(`${username} unsuspended`);
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleForceLogout(userId, username) {
    const confirmed = await confirm({
      title: `Force logout "${username}"?`,
      message: 'All their active sessions will be invalidated. They will need to log in again.',
      confirmLabel: 'Force Logout',
    });
    if (!confirmed) return;
    try {
      await adminForceLogout(userId);
      toast.success(`${username} logged out`);
    } catch (err) {
      toast.error(err.message);
    }
  }

  const totalPages = Math.ceil(total / limit);
  const startItem = (page - 1) * limit + 1;
  const endItem = Math.min(page * limit, total);

  const sortArrow = (key) => {
    if (sort !== key) return '';
    return order === 'asc' ? ' ↑' : ' ↓';
  };

  return (
    <div>
      {ConfirmDialog}
      <h3>Users</h3>

      {/* Toolbar */}
      <div className="admin-users-toolbar">
        <input
          className="admin-search-input"
          type="text"
          placeholder="Search users by name or email..."
          value={searchInput}
          onChange={e => handleSearchChange(e.target.value)}
        />
        <select
          className="admin-sort-select"
          value={`${sort}:${order}`}
          onChange={e => {
            const [s, o] = e.target.value.split(':');
            setSort(s);
            setOrder(o);
            setPage(1);
          }}
        >
          <option value="created_at:desc">Newest first</option>
          <option value="created_at:asc">Oldest first</option>
          <option value="username:asc">Username A-Z</option>
          <option value="username:desc">Username Z-A</option>
          <option value="last_login_at:desc">Recently active</option>
          <option value="tracked_deck_count:desc">Most decks</option>
        </select>
      </div>

      {/* User List */}
      {loading && users.length === 0 && <p className="admin-empty">Loading...</p>}

      {!loading && users.length === 0 && (
        <p className="admin-empty">{search ? 'No users match your search.' : 'No users found.'}</p>
      )}

      {users.length > 0 && (
        <ul className="admin-users-list">
          {users.map(u => (
            <li key={u.id} className="admin-user-row">
              <div className="admin-user-info">
                <div>
                  <span className="admin-user-name">{u.username}</span>
                  {!!u.is_admin && <span className="admin-user-badge">Admin</span>}
                  {!!u.suspended && <span className="admin-user-badge admin-user-badge--suspended">Suspended</span>}
                </div>
                <div className="admin-user-meta">
                  {u.email ? (
                    <>{u.email} {u.email_verified ? <span className="admin-user-badge admin-user-badge--verified" title="Email verified">{'\u2713'}</span> : <span className="admin-user-badge admin-user-badge--unverified" title="Email not verified">?</span>}</>
                  ) : 'No email'} &middot; {u.tracked_deck_count} decks &middot; {u.snapshot_count} snapshots
                  <br />
                  Joined {formatDate(u.created_at)} &middot; Last login {timeAgo(u.last_login_at)}
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
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => handleForceLogout(u.id, u.username)}>
                    Logout
                  </button>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => handleToggleAdmin(u.id, u.username, !!u.is_admin)}>
                    {u.is_admin ? 'Demote' : 'Promote'}
                  </button>
                  {!u.is_admin && (
                    u.suspended
                      ? <button className="btn btn-secondary btn-sm" type="button" onClick={() => handleUnsuspend(u.id, u.username)}>Unsuspend</button>
                      : <button className="btn btn-secondary btn-sm btn-danger" type="button" onClick={() => handleSuspend(u.id, u.username)}>Suspend</button>
                  )}
                  <button className="btn btn-secondary btn-sm btn-danger" type="button" onClick={() => handleDeleteUser(u.id, u.username)}>
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Pagination */}
      {total > limit && (
        <div className="admin-pagination">
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => setPage(p => p - 1)}
            disabled={page <= 1}
          >
            &laquo; Prev
          </button>
          <span>
            Showing {startItem}–{endItem} of {total} users
          </span>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => setPage(p => p + 1)}
            disabled={page >= totalPages}
          >
            Next &raquo;
          </button>
        </div>
      )}
    </div>
  );
}
