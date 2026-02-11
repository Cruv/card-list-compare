import { useState, useEffect, useCallback } from 'react';
import './Toast.css';

const ICONS = {
  success: '\u2713',
  error: '\u2717',
  info: '\u2139',
};

// Default durations by type. 0 = persistent (dismiss manually).
const DEFAULT_DURATIONS = {
  success: 3000,
  info: 3000,
  error: 0, // errors are persistent by default
};

function ToastItem({ toast: t, onDismiss }) {
  const [exiting, setExiting] = useState(false);
  const duration = t.duration ?? DEFAULT_DURATIONS[t.type] ?? 3000;

  useEffect(() => {
    if (duration <= 0) return; // persistent — no auto-dismiss
    const timer = setTimeout(() => {
      setExiting(true);
      setTimeout(() => onDismiss(t.id), 200);
    }, duration);
    return () => clearTimeout(timer);
  }, [t.id, duration, onDismiss]);

  function handleDismiss() {
    setExiting(true);
    setTimeout(() => onDismiss(t.id), 200);
  }

  return (
    <div
      className={`toast toast--${t.type}${exiting ? ' toast--exiting' : ''}${duration <= 0 ? ' toast--persistent' : ''}`}
      role="alert"
      aria-live="polite"
    >
      <span className="toast-icon" aria-hidden="true">{ICONS[t.type] || ICONS.info}</span>
      <span className="toast-message">{t.message}</span>
      <button
        className="toast-dismiss"
        onClick={handleDismiss}
        aria-label="Dismiss notification"
        type="button"
      >
        &times;
      </button>
      {duration > 0 && (
        <div
          className="toast-progress"
          style={{ animationDuration: `${duration}ms` }}
        />
      )}
    </div>
  );
}

// Global toast state — components call addToast() directly
let globalAddToast = null;
let nextId = 0;

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'info'|'success'|'error'} type
 * @param {number|undefined} duration - ms to auto-dismiss. Pass undefined for default, 0 for persistent.
 */
export function toast(message, type = 'info', duration) {
  if (globalAddToast) {
    globalAddToast({ id: nextId++, message, type, duration });
  }
}

toast.success = (message, duration) => toast(message, 'success', duration);
toast.error = (message, duration) => toast(message, 'error', duration);
toast.info = (message, duration) => toast(message, 'info', duration);

export default function ToastContainer() {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((t) => {
    setToasts(prev => [...prev, t]);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  useEffect(() => {
    globalAddToast = addToast;
    return () => { globalAddToast = null; };
  }, [addToast]);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" aria-label="Notifications">
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} onDismiss={dismissToast} />
      ))}
    </div>
  );
}
