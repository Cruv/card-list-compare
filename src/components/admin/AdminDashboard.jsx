import { useState, useEffect } from 'react';
import { getAdminStats, getAdminAuditLog } from '../../lib/api';
import { toast } from '../Toast';

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function AdminDashboard() {
  const [stats, setStats] = useState(null);
  const [recentAudit, setRecentAudit] = useState([]);
  const [loading, setLoading] = useState(true);

  function loadData() {
    setLoading(true);
    Promise.all([
      getAdminStats(),
      getAdminAuditLog({ limit: 5 }),
    ])
      .then(([statsData, auditData]) => {
        setStats(statsData);
        setRecentAudit(auditData.entries || []);
      })
      .catch(() => toast.error('Failed to load dashboard data'))
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadData(); }, []);

  if (loading && !stats) return <p className="admin-empty">Loading...</p>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <h3>Dashboard</h3>
        <button
          className="btn btn-secondary btn-sm admin-refresh-btn"
          onClick={loadData}
          type="button"
          disabled={loading}
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {stats && (
        <div className="admin-stats-grid">
          <div className="admin-stat-card">
            <div className="admin-stat-value">{stats.totalUsers}</div>
            <div className="admin-stat-label">Users</div>
          </div>
          <div className="admin-stat-card">
            <div className="admin-stat-value">{stats.recentLogins}</div>
            <div className="admin-stat-label">Active (7d)</div>
          </div>
          <div className="admin-stat-card">
            <div className="admin-stat-value">{stats.suspendedUsers}</div>
            <div className="admin-stat-label">Suspended</div>
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
      )}

      {recentAudit.length > 0 && (
        <div>
          <h4 style={{ margin: '24px 0 12px', fontSize: 14, color: 'var(--text-secondary)', fontWeight: 600 }}>
            Recent Activity
          </h4>
          <ul className="admin-audit-list">
            {recentAudit.map(entry => (
              <li key={entry.id} className="admin-audit-row">
                <span className="admin-audit-time">{timeAgo(entry.created_at)}</span>
                <span className="admin-audit-body">
                  <span className="admin-audit-summary">
                    <strong>{entry.admin_username}</strong>{' '}
                    {entry.action.replace(/_/g, ' ')}
                    {entry.target_username ? <> &rarr; <strong>{entry.target_username}</strong></> : null}
                  </span>
                  {entry.details && (
                    <div className="admin-audit-detail">{entry.details}</div>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
