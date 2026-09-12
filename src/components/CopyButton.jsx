import { useEffect, useRef, useState, memo } from 'react';
import Icon from './Icon';
import { toast } from './Toast';
import './CopyButton.css';

export default memo(function CopyButton({ getText, label = 'Copy', className = 'copy-btn' }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  async function handleCopy() {
    try {
      const text = getText();
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const previouslyFocused = document.activeElement;
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.readOnly = true;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        try {
          ta.select();
          if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
        } finally {
          ta.remove();
          previouslyFocused?.focus?.();
        }
      }
      clearTimeout(timerRef.current);
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy. Your browser may not allow clipboard access.');
    }
  }

  return (
    <button className={className} onClick={handleCopy} type="button" aria-label={label}>
      <Icon name={copied ? 'check' : 'cards'} size={16} />
      <span aria-live="polite">{copied ? 'Copied!' : label}</span>
    </button>
  );
});
