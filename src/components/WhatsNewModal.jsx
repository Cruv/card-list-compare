import { useRef } from 'react';
import { useModalLayer } from '../lib/useModalLayer';
import './WhatsNewModal.css';

export default function WhatsNewModal({ version, changes, onClose }) {
  // Escape-to-close, focus trap and scroll lock (see useModalLayer).
  const modalRef = useRef(null);
  useModalLayer(onClose, { containerRef: modalRef });

  return (
    <div className="whatsnew-backdrop" onClick={onClose}>
      <div
        className="whatsnew-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`What's new in v${version}`}
        onClick={e => e.stopPropagation()}
        ref={modalRef}
        tabIndex={-1}
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
