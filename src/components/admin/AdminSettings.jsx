import { useState, useEffect } from 'react';
import { getAdminSettings, updateAdminSetting } from '../../lib/api';
import { toast } from '../Toast';

export default function AdminSettings() {
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    getAdminSettings()
      .then(d => setSettings(d.settings))
      .catch(() => toast.error('Failed to load settings'));
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
      <h3>Settings</h3>
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
