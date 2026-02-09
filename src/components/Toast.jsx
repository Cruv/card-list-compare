import { useState, useEffect, useCallback } from 'react';
import './Toast.css';

const ICONS = {
  success: '\u2713',
  error: '\u2717',
  info: '\u2139',
};

function ToastItem({ toast, onDismiss }) {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setExiting(true);
      setTimeout(() => onDismiss(toast.id), 200);
    }, toast.duration || 3000);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, onDismiss]);

  function handleDismiss() {
    setExiting(true);
    setTimeout(() => onDismiss(toast.id), 200);
  }

  return (
    <div
      className={`toast toast--${toast.type}${exiting ? ' toast--exiting' : ''}`}
      role="alert"
      aria-live="polite"
    >
      <span className="toast-icon" aria-hidden="true">{ICONS[toast.type] || ICONS.info}</span>
      <span className="toast-message">{toast.message}</span>
      <button
        className="toast-dismiss"
        onClick={handleDismiss}
        aria-label="Dismiss notification"
        type="button"
      >
        &times;
      </button>
    </div>
  );
}

// Global toast state — components call addToast() directly
let globalAddToast = null;
let nextId = 0;

export function toast(message, type = 'info', duration = 3000) {
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
