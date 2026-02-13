import { useState, useEffect, useCallback } from 'react';
import { getAdminAuditLog } from '../../lib/api';
import { toast } from '../Toast';

const ACTION_BADGE_MAP = {
  delete_user: 'danger',
  delete_share: 'danger',
  suspend_user: 'danger',
  reset_password: 'warning',
  toggle_admin: 'info',
  unsuspend_user: 'info',
  update_setting: 'neutral',
};

function timeAgo(iso) {
  if (!iso) return '';
  const date = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatAction(action) {
  return action.replace(/_/g, ' ');
}

const ACTION_OPTIONS = [
  { value: '', label: 'All actions' },
  { value: 'reset_password', label: 'Reset password' },
  { value: 'delete_user', label: 'Delete user' },
  { value: 'toggle_admin', label: 'Toggle admin' },
  { value: 'suspend_user', label: 'Suspend user' },
  { value: 'unsuspend_user', label: 'Unsuspend user' },
  { value: 'update_setting', label: 'Update setting' },
  { value: 'delete_share', label: 'Delete share' },
];

export default function AdminAuditLog() {
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [actionFilter, setActionFilter] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    getAdminAuditLog({ page, limit, action: actionFilter || undefined })
      .then(d => {
        setEntries(d.entries || []);
        setTotal(d.total || 0);
      })
      .catch(() => toast.error('Failed to load audit log'))
      .finally(() => setLoading(false));
  }, [page, limit, actionFilter]);

  useEffect(() => { refresh(); }, [refresh]);

  function handleFilterChange(value) {
    setActionFilter(value);
    setPage(1);
  }

  const totalPages = Math.ceil(total / limit);
  const startItem = (page - 1) * limit + 1;
  const endItem = Math.min(page * limit, total);

  return (
    <div>
      <h3>Audit Log</h3>

      {/* Toolbar */}
      <div className="admin-audit-toolbar">
        <select
          className="admin-sort-select"
          value={actionFilter}
          onChange={e => handleFilterChange(e.target.value)}
        >
          {ACTION_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <span className="admin-audit-count">
          {total} {total === 1 ? 'entry' : 'entries'}
        </span>
      </div>

      {/* Log entries */}
      {loading && entries.length === 0 && <p className="admin-empty">Loading...</p>}

      {!loading && entries.length === 0 && <p className="admin-empty">No audit log entries.</p>}

      {entries.length > 0 && (
        <ul className="admin-audit-list">
          {entries.map(entry => {
            const badgeType = ACTION_BADGE_MAP[entry.action] || 'neutral';
            return (
              <li key={entry.id} className="admin-audit-row">
                <span className="admin-audit-time">{timeAgo(entry.created_at)}</span>
                <span className={`admin-audit-action-badge admin-audit-action-badge--${badgeType}`}>
                  {formatAction(entry.action)}
                </span>
                <span className="admin-audit-body">
                  <span className="admin-audit-summary">
                    <strong>{entry.admin_username}</strong>
                    {entry.target_username ? <> &rarr; <strong>{entry.target_username}</strong></> : null}
                  </span>
                  {entry.details && (
                    <div className="admin-audit-detail">{entry.details}</div>
                  )}
                </span>
              </li>
            );
          })}
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
            Showing {startItem}–{endItem} of {total}
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
