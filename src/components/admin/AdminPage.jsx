import { useState, useCallback, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import AdminDashboard from './AdminDashboard';
import AdminUserList from './AdminUserList';
import AdminSettings from './AdminSettings';
import AdminShares from './AdminShares';
import AdminAuditLog from './AdminAuditLog';
import AdminInvites from './AdminInvites';
import AdminSystem from './AdminSystem';
import Icon from '../Icon';
import './AdminPage.css';

const SECTIONS = [
  { key: 'dashboard', label: 'Overview', icon: 'station' },
  { key: 'users', label: 'Users', icon: 'user' },
  { key: 'invites', label: 'All invitations', icon: 'plus' },
  { key: 'settings', label: 'App settings', icon: 'settings' },
  { key: 'shares', label: 'Shared links', icon: 'connections' },
  { key: 'audit', label: 'Audit log', icon: 'guide' },
  { key: 'system', label: 'System', icon: 'station' },
];

function sectionFromHash() {
  const section = window.location.hash.split('/')[1];
  return SECTIONS.some(item => item.key === section) ? section : 'dashboard';
}

export default function AdminPage() {
  const { user } = useAuth();
  const [activeSection, setActiveSection] = useState(sectionFromHash);

  useEffect(() => {
    const update = () => setActiveSection(sectionFromHash());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

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
    case 'system':
      content = <AdminSystem />;
      break;
    default:
      content = <AdminDashboard />;
  }

  return (
    <div className="admin-page">
      <header className="page-heading"><h1>Administration</h1><p>Manage access, app settings and maintenance.</p></header>
      <aside className="admin-sidebar">
        <nav className="admin-sidebar-nav" aria-label="Administration sections">
          {SECTIONS.map((s) => (
            <a
              key={s.key}
              className={`admin-nav-item${activeSection === s.key ? ' admin-nav-item--active' : ''}`}
              aria-current={activeSection === s.key ? 'page' : undefined}
              href={`#admin/${s.key}`}
            >
              <Icon name={s.icon} size={18} />
              {s.label}
            </a>
          ))}
        </nav>
      </aside>
      <section className="admin-content" aria-live="polite">
        {content}
      </section>
    </div>
  );
}
