import { useState, memo } from 'react';

export default memo(function CopyButton({ getText, label = 'Copy', className = 'copy-btn' }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(getText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = getText();
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <button className={className} onClick={handleCopy} type="button">
      {copied ? 'Copied!' : label}
    </button>
  );
});
