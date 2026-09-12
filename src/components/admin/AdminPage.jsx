import { useState, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import AdminDashboard from './AdminDashboard';
import AdminUserList from './AdminUserList';
import AdminSettings from './AdminSettings';
import AdminShares from './AdminShares';
import AdminAuditLog from './AdminAuditLog';
import AdminInvites from './AdminInvites';
import Icon from '../Icon';
import './AdminPage.css';

const SECTIONS = [
  { key: 'dashboard', label: 'Dashboard', icon: 'station' },
  { key: 'users', label: 'Users', icon: 'user' },
  { key: 'invites', label: 'Invites', icon: 'plus' },
  { key: 'settings', label: 'Settings', icon: 'settings' },
  { key: 'shares', label: 'Shares', icon: 'connections' },
  { key: 'audit', label: 'Audit Log', icon: 'guide' },
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
      <header className="page-heading"><p className="eyebrow">Behind the scenes</p><h1>Administration</h1><p>A clear view of your community, activity and app settings.</p></header>
      <aside className="admin-sidebar">
        <nav className="admin-sidebar-nav" aria-label="Administration sections">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              className={`admin-nav-item${activeSection === s.key ? ' admin-nav-item--active' : ''}`}
              aria-current={activeSection === s.key ? 'page' : undefined}
              onClick={() => setActiveSection(s.key)}
              type="button"
            >
              <Icon name={s.icon} size={18} />
              {s.label}
            </button>
          ))}
        </nav>
      </aside>
      <section className="admin-content" aria-live="polite">
        {content}
      </section>
    </div>
  );
}
