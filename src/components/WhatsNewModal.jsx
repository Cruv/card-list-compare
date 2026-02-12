import { useEffect } from 'react';
import './WhatsNewModal.css';

export default function WhatsNewModal({ version, changes, onClose }) {
  // Close on Escape
  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className="whatsnew-backdrop" onClick={onClose}>
      <div
        className="whatsnew-modal"
        role="dialog"
        aria-label={`What's new in v${version}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="whatsnew-header">
          <h2 className="whatsnew-title">What's new in v{version}</h2>
          <button
            className="whatsnew-close"
            onClick={onClose}
            aria-label="Close"
            type="button"
          >
            &times;
          </button>
        </div>
        <ul className="whatsnew-list">
          {changes.map((item, i) => (
            <li key={i} className="whatsnew-item">{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
