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

  async function handleRegistrationModeChange(value) {
    try {
      await updateAdminSetting('registration_enabled', value);
      setSettings(prev => ({ ...prev, registration_enabled: value }));
      const labels = { open: 'Open', invite: 'Invite Only', closed: 'Closed' };
      toast.success(`Registration mode set to ${labels[value] || value}`);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleToggleSetting(key, value) {
    try {
      await updateAdminSetting(key, value);
      setSettings(prev => ({ ...prev, [key]: value }));
      toast.success('Setting saved');
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleNumericSetting(key, value) {
    const num = parseInt(value, 10);
    if (isNaN(num) || num < 0 || num > 1000) {
      toast.error('Value must be 0-1000 (0 = unlimited)');
      return;
    }
    try {
      await updateAdminSetting(key, String(num));
      setSettings(prev => ({ ...prev, [key]: String(num) }));
      toast.success('Setting saved');
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (!settings) return <p className="admin-empty">Loading...</p>;

  // Normalize legacy values
  const regMode = settings.registration_enabled === 'true' ? 'open'
    : settings.registration_enabled === 'false' ? 'closed'
    : settings.registration_enabled || 'open';

  const modeDescriptions = {
    open: 'Anyone can create an account freely.',
    invite: 'Users need a valid invite code to register. Admins and users with invite permission can generate codes.',
    closed: 'Registration is disabled. Only admins can create accounts.',
  };

  return (
    <div>
      <h3>Settings</h3>

      {/* Registration Mode */}
      <div className="admin-setting-row">
        <div>
          <div className="admin-setting-label">Registration Mode</div>
          <div className="admin-setting-desc">{modeDescriptions[regMode] || ''}</div>
        </div>
        <select
          className="admin-sort-select"
          value={regMode}
          onChange={e => handleRegistrationModeChange(e.target.value)}
        >
          <option value="open">Open</option>
          <option value="invite">Invite Only</option>
          <option value="closed">Closed</option>
        </select>
      </div>

      {/* Price Display */}
      <div className="admin-setting-row">
        <div>
          <div className="admin-setting-label">Price Display</div>
          <div className="admin-setting-desc">
            Show Scryfall card prices on card lines, deck summaries, and changelogs.
          </div>
        </div>
        <select
          className="admin-sort-select"
          value={settings.price_display_enabled || 'true'}
          onChange={e => handleToggleSetting('price_display_enabled', e.target.value)}
        >
          <option value="true">Enabled</option>
          <option value="false">Disabled</option>
        </select>
      </div>

      {/* Snapshot Limits */}
      <div className="admin-setting-row">
        <div>
          <div className="admin-setting-label">Max Snapshots Per Deck</div>
          <div className="admin-setting-desc">
            Oldest unlocked snapshots are auto-pruned when this limit is exceeded. Set to 0 for unlimited.
          </div>
        </div>
        <input
          type="number"
          className="admin-setting-number"
          min="0"
          max="1000"
          value={settings.max_snapshots_per_deck || '25'}
          onChange={e => setSettings(prev => ({ ...prev, max_snapshots_per_deck: e.target.value }))}
          onBlur={e => handleNumericSetting('max_snapshots_per_deck', e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleNumericSetting('max_snapshots_per_deck', e.target.value); }}
        />
      </div>

      <div className="admin-setting-row">
        <div>
          <div className="admin-setting-label">Max Locked Snapshots Per Deck</div>
          <div className="admin-setting-desc">
            Users can lock snapshots to prevent auto-pruning. Set to 0 for unlimited locks.
          </div>
        </div>
        <input
          type="number"
          className="admin-setting-number"
          min="0"
          max="1000"
          value={settings.max_locked_per_deck || '5'}
          onChange={e => setSettings(prev => ({ ...prev, max_locked_per_deck: e.target.value }))}
          onBlur={e => handleNumericSetting('max_locked_per_deck', e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleNumericSetting('max_locked_per_deck', e.target.value); }}
        />
      </div>
    </div>
  );
}
