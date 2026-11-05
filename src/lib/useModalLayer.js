import { useEffect, useRef } from 'react';
import { pushLayer, popLayer, isTopLayer } from './modalLayerStack';

/**
 * Shared behavior for every overlay/modal: Escape-to-close, focus trapping, and
 * body scroll lock — coordinated across STACKED layers.
 *
 * Why a shared registry: each overlay used to attach its own document-level
 * Escape listener that unconditionally called onClose, so one Escape press with
 * an overlay open inside another (MpcOverlay inside TimelineOverlay) closed
 * BOTH. Here only the topmost layer reacts, and the scroll lock is ref-counted
 * so closing a nested layer doesn't unlock the page while its parent is open.
 * Stacking rules live in modalLayerStack.js (unit-tested); this hook is the DOM half.
 *
 * Usage:
 *   const ref = useRef(null);
 *   useModalLayer(onClose, { containerRef: ref });
 *   return <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1}>…</div>;
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function insideClosedDetails(el) {
  // Some browsers still report layout rectangles for collapsed contents.
  // Only the first direct summary remains reachable in each closed ancestor.
  for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.localName !== 'details' || ancestor.open) continue;
    const summary = [...ancestor.children].find(child => child.localName === 'summary');
    if (!summary?.contains(el)) return true;
  }
  return false;
}

function visibleFocusable(container) {
  if (!container) return [];
  return [...container.querySelectorAll(FOCUSABLE)]
    .filter(el => el.tabIndex >= 0 && !el.matches(':disabled')
      && !el.closest('[inert], [aria-hidden="true"]')
      && !insideClosedDetails(el)
      && el.getClientRects().length > 0
      && getComputedStyle(el).visibility !== 'hidden')
    .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
}

/**
 * @param {() => void} onEscape  Called on Escape only when this layer is topmost.
 *   A component with an internal sub-panel (e.g. MpcOverlay's settings) can close
 *   that first and only close the whole overlay on a later press.
 * @param {object} options
 * @param {React.RefObject} options.containerRef      Element to trap focus within.
 * @param {React.RefObject} [options.initialFocusRef] Element to focus on open.
 * @param {boolean} [options.trapFocus=true]
 * @param {boolean} [options.lockScroll=true]
 */
export function useModalLayer(onEscape, options = {}) {
  const { containerRef, initialFocusRef, trapFocus = true, lockScroll = true } = options;

  // Latest-value refs so the effect can stay mounted for the layer's whole
  // lifetime — re-running it would reorder the stack on every render.
  const escapeRef = useRef(onEscape);
  useEffect(() => { escapeRef.current = onEscape; }, [onEscape]);

  const optionsRef = useRef({ containerRef, initialFocusRef, trapFocus, lockScroll });
  useEffect(() => {
    optionsRef.current = { containerRef, initialFocusRef, trapFocus, lockScroll };
  }, [containerRef, initialFocusRef, trapFocus, lockScroll]);

  useEffect(() => {
    const token = {};
    const { trapFocus: trap, lockScroll: lock } = optionsRef.current;

    const isFirst = pushLayer(token);
    let savedOverflow = null;
    if (lock && isFirst) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }

    const previouslyFocused = document.activeElement;

    if (trap) {
      const { containerRef: cRef, initialFocusRef: iRef } = optionsRef.current;
      // Synchronous: effects run after the DOM is committed, so the container and
      // its current children are focusable now. (Deferring via rAF would silently
      // skip focus whenever the tab is hidden — rAF is throttled there — and could
      // steal focus later when it un-hides.) The container carries tabIndex={-1},
      // so it is a valid target even before async content renders; the Tab handler
      // moves focus to real controls from there.
      const target =
        iRef?.current || visibleFocusable(cRef?.current)[0] || cRef?.current;
      target?.focus?.();
    }

    function handleKey(e) {
      if (!isTopLayer(token)) return; // a layer above us owns the keyboard

      if (e.key === 'Escape') {
        escapeRef.current?.();
        return;
      }

      const { containerRef: cRef, trapFocus: trapNow } = optionsRef.current;
      if (e.key !== 'Tab' || !trapNow) return;
      const container = cRef?.current;
      if (!container) return;

      const nodes = visibleFocusable(container);
      if (nodes.length === 0) {
        e.preventDefault();
        container.focus?.();
        return;
      }
      // Move every Tab ourselves. Safari's keyboard-navigation preference can
      // otherwise skip links/buttons inside the dialog and send focus to BODY
      // before a boundary-only trap has a chance to wrap it.
      e.preventDefault();
      const current = nodes.indexOf(document.activeElement);
      const next = current < 0
        ? (e.shiftKey ? nodes.length - 1 : 0)
        : (current + (e.shiftKey ? -1 : 1) + nodes.length) % nodes.length;
      nodes[next].focus();
    }

    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      const isLast = popLayer(token);
      if (lock && isLast) {
        document.body.style.overflow = savedOverflow || '';
      }
      if (trap && previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
    // Mount/unmount only — the layer's identity must not change across renders
    // (everything the effect needs is read through refs).
  }, []);
}
