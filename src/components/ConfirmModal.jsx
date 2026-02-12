import { useEffect, useRef, useState } from 'react';
import './ConfirmModal.css';

/**
 * Styled replacement for window.confirm().
 * Usage:
 *   <ConfirmModal
 *     title="Delete Snapshot?"
 *     message="This cannot be undone."
 *     confirmLabel="Delete"
 *     danger
 *     onConfirm={() => doDelete()}
 *     onCancel={() => setShow(false)}
 *   />
 *
 * Or use the hook: const [confirm, ConfirmDialog] = useConfirm();
 */
export default function ConfirmModal({
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  typeToConfirm,
  onConfirm,
  onCancel,
}) {
  const confirmRef = useRef(null);
  const inputRef = useRef(null);
  const [typed, setTyped] = useState('');
  const needsTyping = !!typeToConfirm;
  const typingMatches = !needsTyping || typed === typeToConfirm;

  useEffect(() => {
    if (needsTyping) {
      inputRef.current?.focus();
    } else {
      confirmRef.current?.focus();
    }
  }, [needsTyping]);

  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  return (
    <div
      className="confirm-modal-overlay"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      aria-describedby={message ? 'confirm-modal-desc' : undefined}
    >
      <div className="confirm-modal" onClick={e => e.stopPropagation()}>
        <h3 className="confirm-modal-title" id="confirm-modal-title">{title}</h3>
        {message && <p className="confirm-modal-message" id="confirm-modal-desc">{message}</p>}
        {needsTyping && (
          <div className="confirm-modal-type">
            <label className="confirm-modal-type-label">
              Type <strong>{typeToConfirm}</strong> to confirm:
            </label>
            <input
              ref={inputRef}
              className="confirm-modal-type-input"
              type="text"
              value={typed}
              onChange={e => setTyped(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && typingMatches) onConfirm(); }}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
        <div className="confirm-modal-actions">
          <button className="btn btn-secondary" type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            type="button"
            onClick={onConfirm}
            disabled={!typingMatches}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Hook for imperative confirm dialogs.
 * Returns [confirm, ConfirmDialog] where confirm() returns a Promise<boolean>.
 *
 * Usage:
 *   const [confirm, ConfirmDialog] = useConfirm();
 *   async function handleDelete() {
 *     if (await confirm({ title: 'Delete?', message: 'Cannot undo.', danger: true })) {
 *       doDelete();
 *     }
 *   }
 *   return <>{ConfirmDialog}<button onClick={handleDelete}>Delete</button></>;
 */
export function useConfirm() {
  const [state, setState] = useState(null);

  function confirm(options = {}) {
    return new Promise(resolve => {
      setState({ ...options, resolve });
    });
  }

  const dialog = state ? (
    <ConfirmModal
      title={state.title}
      message={state.message}
      confirmLabel={state.confirmLabel}
      cancelLabel={state.cancelLabel}
      danger={state.danger}
      typeToConfirm={state.typeToConfirm}
      onConfirm={() => { state.resolve(true); setState(null); }}
      onCancel={() => { state.resolve(false); setState(null); }}
    />
  ) : null;

  return [confirm, dialog];
}
