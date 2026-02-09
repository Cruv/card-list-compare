import { useConfirm } from './ConfirmModal';
import { toast } from './Toast';
import './SnapshotManager.css';

export default function SnapshotManager({ snapshots, onDelete, onLoad, onClose }) {
  const [confirm, ConfirmDialog] = useConfirm();

  function countCards(text) {
    const lines = text.split('\n').filter((l) => l.trim() && !/^(sideboard|sb|mainboard|deck)/i.test(l.trim()));
    return lines.length;
  }

  async function handleDelete(snap) {
    const confirmed = await confirm({
      title: 'Delete snapshot?',
      message: `This will permanently delete "${snap.name}".`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    onDelete(snap.id);
    toast.success('Snapshot deleted');
  }

  return (
    <div className="snapshot-manager">
      {ConfirmDialog}
      <div className="snapshot-manager-header">
        <h3 className="snapshot-manager-title">Saved Snapshots</h3>
        <button className="snapshot-manager-close" onClick={onClose} type="button">
          &times;
        </button>
      </div>

      {snapshots.length === 0 ? (
        <p className="snapshot-manager-empty">
          No snapshots saved yet. Use the <strong>Save</strong> button on either deck input to save a snapshot.
        </p>
      ) : (
        <div className="snapshot-manager-list">
          {snapshots.map((snap) => (
            <div key={snap.id} className="snapshot-manager-item">
              <div className="snapshot-manager-item-info">
                <span className="snapshot-manager-item-name">{snap.name}</span>
                <span className="snapshot-manager-item-meta">
                  {snap.source !== 'paste' && (
                    <span className="snapshot-manager-item-source">{snap.source}</span>
                  )}
                  <span>{countCards(snap.text)} cards</span>
                  <span>&middot;</span>
                  <span>{new Date(snap.createdAt).toLocaleString()}</span>
                </span>
              </div>
              <div className="snapshot-manager-item-actions">
                <button
                  className="snapshot-manager-action"
                  onClick={() => onLoad(snap, 'before')}
                  type="button"
                >
                  &larr; Before
                </button>
                <button
                  className="snapshot-manager-action"
                  onClick={() => onLoad(snap, 'after')}
                  type="button"
                >
                  After &rarr;
                </button>
                <button
                  className="snapshot-manager-action snapshot-manager-action--delete"
                  onClick={() => handleDelete(snap)}
                  type="button"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
