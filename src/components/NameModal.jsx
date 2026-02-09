import { useState, useEffect, useRef } from 'react';
import './NameModal.css';

export default function NameModal({ defaultValue, title, placeholder, onConfirm, onCancel }) {
  const [value, setValue] = useState(defaultValue || '');
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  function handleSubmit(e) {
    e.preventDefault();
    onConfirm(value);
  }

  return (
    <div
      className="name-modal-overlay"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="name-modal-title"
    >
      <div className="name-modal" onClick={e => e.stopPropagation()}>
        <h3 className="name-modal-title" id="name-modal-title">{title || 'Name this snapshot'}</h3>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            className="name-modal-input"
            type="text"
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder={placeholder || 'Snapshot name...'}
            aria-label={placeholder || 'Snapshot name'}
          />
          <div className="name-modal-actions">
            <button className="btn btn-primary" type="submit">Save</button>
            <button className="btn btn-secondary" type="button" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
