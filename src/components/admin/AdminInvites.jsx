import { useState, useEffect, useCallback } from 'react';
import { getAdminInvites, adminDeleteInvite } from '../../lib/api';
import { useConfirm } from '../ConfirmModal';
import { toast } from '../Toast';

function formatDate(iso) {
  if (!iso) return '...';
  return new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export default function AdminInvites() {
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirm, ConfirmDialog] = useConfirm();

  const refresh = useCallback(() => {
    setLoading(true);
    getAdminInvites()
      .then(d => setInvites(d.invites))
      .catch(() => toast.error('Failed to load invite codes'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleDelete(invite) {
    const confirmed = await confirm({
      title: 'Delete invite code?',
      message: `Delete code "${invite.code}" created by ${invite.creator_username}? This will not affect users who already registered with it.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await adminDeleteInvite(invite.id);
      toast.success('Invite code deleted');
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  }

  return (
    <div>
      {ConfirmDialog}
      <h3>Invite Codes</h3>

      {loading && invites.length === 0 && <p className="admin-empty">Loading...</p>}
      {!loading && invites.length === 0 && <p className="admin-empty">No invite codes have been created.</p>}

      {invites.length > 0 && (
        <ul className="admin-invite-list">
          {invites.map(inv => (
            <li key={inv.id} className="admin-invite-row">
              <div className="admin-invite-info">
                <code className="admin-invite-code">{inv.code}</code>
                <span className="admin-invite-usage">
                  {inv.use_count}/{inv.max_uses > 0 ? inv.max_uses : '\u221E'} used
                </span>
                <span className="admin-invite-creator">
                  by {inv.creator_username}
                </span>
                <span className="admin-invite-date">
                  {formatDate(inv.created_at)}
                </span>
              </div>
              <div className="admin-invite-actions">
                <button
                  className="btn btn-secondary btn-sm btn-danger"
                  type="button"
                  onClick={() => handleDelete(inv)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
