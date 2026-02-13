import { useState, useEffect, useRef } from 'react';
import { getAdminStats, getAdminAuditLog, downloadBackup, downloadUsersExport, adminBulkSuspend, adminCleanupTokens, adminCleanupAuditLog } from '../../lib/api';
import { useConfirm } from '../ConfirmModal';
import { toast } from '../Toast';

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return '...';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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
  const [cleanupDays, setCleanupDays] = useState(90);
  const [confirm, ConfirmDialog] = useConfirm();
  const intervalRef = useRef(null);

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

  useEffect(() => {
    loadData();
    // Auto-refresh stats every 60 seconds
    intervalRef.current = setInterval(loadData, 60000);
    return () => clearInterval(intervalRef.current);
  }, []);

  async function handleBackup() {
    try {
      await downloadBackup();
      toast.success('Backup downloaded');
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleExportUsers() {
    try {
      await downloadUsersExport();
      toast.success('Users exported');
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleCleanupTokens() {
    try {
      const data = await adminCleanupTokens();
      toast.success(`Cleaned up ${data.removed} expired tokens`);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleCleanupAuditLog() {
    try {
      const data = await adminCleanupAuditLog(cleanupDays);
      toast.success(`Removed ${data.removed} audit entries older than ${cleanupDays}d`);
      loadData();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleEmergencyLockdown() {
    const confirmed = await confirm({
      title: 'Emergency Lockdown',
      message: 'This will immediately suspend ALL non-admin users. They will be logged out and unable to log in until unsuspended.',
      confirmLabel: 'Suspend All Users',
      danger: true,
    });
    if (!confirmed) return;
    try {
      const data = await adminBulkSuspend();
      toast.success(`Lockdown active — ${data.count} users suspended`);
      loadData();
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (loading && !stats) return <p className="admin-empty">Loading...</p>;

  return (
    <div>
      {ConfirmDialog}
      <div className="admin-dashboard-header">
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
          <div className="admin-stat-card">
            <div className="admin-stat-value">{formatUptime(stats.uptime)}</div>
            <div className="admin-stat-label">Uptime</div>
          </div>
          <div className="admin-stat-card">
            <div className="admin-stat-value">{formatBytes(stats.memoryUsage?.heapUsed || 0)}</div>
            <div className="admin-stat-label">Memory</div>
          </div>
          <div className="admin-stat-card">
            <div className="admin-stat-value">{stats.nodeVersion || '...'}</div>
            <div className="admin-stat-label">Node</div>
          </div>
        </div>
      )}

      {recentAudit.length > 0 && (
        <div>
          <h4 className="admin-subsection-title">
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

      {/* Maintenance Section */}
      <div>
        <h4 style={{ margin: '24px 0 12px', fontSize: 14, color: 'var(--text-secondary)', fontWeight: 600 }}>
          Maintenance
        </h4>
        <div className="admin-maintenance">
          <div className="admin-maintenance-row">
            <button className="btn btn-secondary btn-sm" type="button" onClick={handleBackup}>
              Download Backup
            </button>
            <button className="btn btn-secondary btn-sm" type="button" onClick={handleExportUsers}>
              Export Users CSV
            </button>
            <button className="btn btn-secondary btn-sm" type="button" onClick={handleCleanupTokens}>
              Cleanup Expired Tokens
            </button>
          </div>
          <div className="admin-maintenance-row">
            <div className="admin-maintenance-input-group">
              <button className="btn btn-secondary btn-sm" type="button" onClick={handleCleanupAuditLog}>
                Cleanup Audit Log
              </button>
              <input
                type="number"
                min="1"
                max="365"
                value={cleanupDays}
                onChange={e => setCleanupDays(parseInt(e.target.value, 10) || 90)}
                className="admin-maintenance-days-input"
                title="Days to keep"
              />
              <span className="admin-maintenance-label">days</span>
            </div>
          </div>
          <div className="admin-maintenance-row admin-maintenance-danger">
            <button className="btn btn-secondary btn-sm btn-danger" type="button" onClick={handleEmergencyLockdown}>
              Emergency Lockdown
            </button>
            <span className="admin-maintenance-label">Suspend all non-admin users immediately</span>
          </div>
        </div>
      </div>
    </div>
  );
}
