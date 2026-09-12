import { useEffect, useId, useRef, useState } from 'react';
import Icon from './Icon';
import './ActionMenu.css';

/** A disclosure for secondary actions, with normal Tab navigation. */
export default function ActionMenu({ label = 'Export', ariaLabel, children, className = '' }) {
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const [position, setPosition] = useState({});
  const root = useRef(null);
  const trigger = useRef(null);
  const id = useId();
  const otherModalOwns = node => {
    const modal = node?.closest?.('[aria-modal="true"], dialog[open]');
    return modal && !modal.contains(root.current);
  };

  useEffect(() => {
    if (!open) return;
    const closeOutside = event => {
      const modal = event.target?.closest?.('[aria-modal="true"], dialog[open]');
      if (modal && !modal.contains(root.current)) return;
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  return <div className={`action-menu ${className}`} ref={root}
    onBlur={event => {
      if (event.currentTarget.contains(event.relatedTarget) || otherModalOwns(event.relatedTarget)) return;
      // A newly opened modal may take focus after the launcher's blur. Keep its
      // menu item mounted so the modal can restore keyboard focus on dismissal.
      requestAnimationFrame(() => {
        if (!root.current?.contains(document.activeElement) && !otherModalOwns(document.activeElement)) setOpen(false);
      });
    }}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    }}>
    <button ref={trigger} type="button" className="btn btn-secondary action-menu-trigger"
      aria-expanded={open} aria-controls={id} aria-label={ariaLabel || label}
      onClick={event => {
        event.currentTarget.focus();
        const rect = event.currentTarget.getBoundingClientRect();
        const placeAbove = window.innerHeight - rect.bottom < 260 && rect.top > window.innerHeight - rect.bottom;
        const width = Math.min(280, window.innerWidth - 32);
        const left = Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16));
        setAbove(placeAbove);
        setPosition({ width, left: left - root.current.getBoundingClientRect().left,
          maxHeight: Math.max(80, Math.min(360, (placeAbove ? rect.top : window.innerHeight - rect.bottom) - 16)) });
        setOpen(value => !value);
      }}>
      {label}<Icon name="chevron" size={14} />
    </button>
    {open && <div id={id} role="group" aria-label={`${label} options`}
      style={position} className={`action-menu-panel${above ? ' action-menu-panel--above' : ''}`}>{children}</div>}
  </div>;
}
