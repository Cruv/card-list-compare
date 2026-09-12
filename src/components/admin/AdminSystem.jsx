import { useState } from 'react';
import { downloadBackup, adminCleanupTokens, adminBulkSuspend } from '../../lib/api';
import { useConfirm } from '../ConfirmModal';
import { toast } from '../Toast';

export default function AdminSystem() {
  const [busy, setBusy] = useState(null);
  const [confirm, ConfirmDialog] = useConfirm();

  async function run(name, action) {
    if (busy) return;
    setBusy(name);
    try { await action(); } catch (error) { toast.error(error.message); }
    finally { setBusy(null); }
  }

  async function lockdown() {
    const accepted = await confirm({
      title: 'Emergency Lockdown',
      message: 'This will immediately suspend ALL non-admin users. They will be logged out and unable to log in until unsuspended.',
      confirmLabel: 'Suspend All Users',
      danger: true,
    });
    if (accepted) await run('lockdown', async () => {
      const result = await adminBulkSuspend();
      toast.success(`Lockdown active — ${result.count} users suspended`);
    });
  }

  return <div>
    {ConfirmDialog}
    <h3>System</h3>
    <section className="admin-system-section">
      <h4>Database backup</h4>
      <p>Download a copy of the CLC database. Keep it in a private location.</p>
      <button className="btn btn-secondary" disabled={!!busy} onClick={() => run('backup', async () => { await downloadBackup(); toast.success('Backup downloaded'); })}>{busy === 'backup' ? 'Downloading…' : 'Download database backup'}</button>
    </section>
    <section className="admin-system-section">
      <h4>Expired tokens</h4>
      <p>Remove expired email verification and password reset tokens.</p>
      <button className="btn btn-secondary" disabled={!!busy} onClick={() => run('tokens', async () => { const result = await adminCleanupTokens(); toast.success(`Cleaned up ${result.removed} expired tokens`); })}>{busy === 'tokens' ? 'Cleaning up…' : 'Clean up expired tokens'}</button>
    </section>
    <details className="admin-maintenance-panel admin-system-danger">
      <summary>Emergency lockdown</summary>
      <p>Suspend every non-admin account and invalidate their sessions. Restore access individually from Users.</p>
      <button className="btn btn-secondary btn-danger" disabled={!!busy} onClick={lockdown}>{busy === 'lockdown' ? 'Suspending…' : 'Review emergency lockdown'}</button>
    </details>
  </div>;
}
