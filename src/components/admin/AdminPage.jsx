import { useState, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import AdminDashboard from './AdminDashboard';
import AdminUserList from './AdminUserList';
import AdminSettings from './AdminSettings';
import AdminShares from './AdminShares';
import AdminAuditLog from './AdminAuditLog';
import AdminInvites from './AdminInvites';
import './AdminPage.css';

const SECTIONS = [
  { key: 'dashboard', label: 'Dashboard', icon: '📊' },
  { key: 'users', label: 'Users', icon: '👥' },
  { key: 'invites', label: 'Invites', icon: '🎟️' },
  { key: 'settings', label: 'Settings', icon: '⚙️' },
  { key: 'shares', label: 'Shares', icon: '🔗' },
  { key: 'audit', label: 'Audit Log', icon: '📋' },
];

export default function AdminPage() {
  const { user } = useAuth();
  const [activeSection, setActiveSection] = useState('dashboard');

  const handleBack = useCallback(() => {
    window.location.hash = '';
  }, []);

  if (!user?.isAdmin) {
    return (
      <div className="admin-page">
        <div className="admin-unauthorized">
          <h2>Access Denied</h2>
          <p>You don't have permission to access this page.</p>
          <button className="btn btn-secondary" onClick={handleBack}>Back to Compare</button>
        </div>
      </div>
    );
  }

  let content;
  switch (activeSection) {
    case 'dashboard':
      content = <AdminDashboard />;
      break;
    case 'users':
      content = <AdminUserList currentUserId={user.id} />;
      break;
    case 'invites':
      content = <AdminInvites />;
      break;
    case 'settings':
      content = <AdminSettings />;
      break;
    case 'shares':
      content = <AdminShares />;
      break;
    case 'audit':
      content = <AdminAuditLog />;
      break;
    default:
      content = <AdminDashboard />;
  }

  return (
    <div className="admin-page">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-header">
          <h2 className="admin-sidebar-title">Admin</h2>
          <button className="admin-back-link" onClick={handleBack} type="button">
            &larr; Back to Compare
          </button>
        </div>
        <nav className="admin-sidebar-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              className={`admin-nav-item${activeSection === s.key ? ' admin-nav-item--active' : ''}`}
              onClick={() => setActiveSection(s.key)}
              type="button"
            >
              <span className="admin-nav-icon">{s.icon}</span>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="admin-sidebar-footer">
          <span className="admin-sidebar-user">Logged in as <strong>{user.username}</strong></span>
        </div>
      </aside>
      <main className="admin-content">
        {content}
      </main>
    </div>
  );
}
