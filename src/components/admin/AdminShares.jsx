import { useState, useEffect, useCallback } from 'react';
import { getAdminShares, adminDeleteShare } from '../../lib/api';
import { useConfirm } from '../ConfirmModal';
import { toast } from '../Toast';

function formatDate(iso) {
  if (!iso) return '...';
  return new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).toLocaleString();
}

function formatSize(before, after) {
  const total = (before || 0) + (after || 0);
  if (total < 1024) return `${total} chars`;
  return `${(total / 1024).toFixed(1)}K chars`;
}

export default function AdminShares() {
  const [shares, setShares] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirm, ConfirmDialog] = useConfirm();

  const refresh = useCallback(() => {
    setLoading(true);
    getAdminShares()
      .then(d => setShares(d.shares))
      .catch(() => toast.error('Failed to load shares'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleDelete(id) {
    const confirmed = await confirm({
      title: 'Delete shared comparison?',
      message: 'This will permanently remove the shared link. Anyone with the link will see an error.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await adminDeleteShare(id);
      toast.success('Shared comparison deleted');
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  }

  return (
    <div>
      {ConfirmDialog}
      <h3>Shared Comparisons</h3>

      {loading && shares.length === 0 && <p className="admin-empty">Loading...</p>}

      {!loading && shares.length === 0 && <p className="admin-empty">No shared comparisons.</p>}

      {shares.length > 0 && (
        <ul className="admin-shares-list">
          {shares.map(s => (
            <li key={s.id} className="admin-share-item">
              <div className="admin-share-info">
                <div className="admin-share-title">{s.title || s.id}</div>
                <div className="admin-share-meta">
                  {formatDate(s.created_at)} &middot; {formatSize(s.before_length, s.after_length)}
                </div>
              </div>
              <button className="btn btn-secondary btn-sm btn-danger" type="button" onClick={() => handleDelete(s.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
