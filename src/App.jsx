import { useState, useEffect, useRef, useMemo } from 'react';
import DeckInput from './components/DeckInput';
import ChangelogOutput from './components/ChangelogOutput';
import AuthBar from './components/AuthBar';
import AdminPanel from './components/AdminPanel';
import UserSettings from './components/UserSettings';
import ForgotPassword from './components/ForgotPassword';
import ResetPassword from './components/ResetPassword';
import ErrorBoundary from './components/ErrorBoundary';
import { useAuth } from './context/AuthContext';
import { parse } from './lib/parser';
import { computeDiff } from './lib/differ';
import { collectCardNames, fetchCardData } from './lib/scryfall';
import { createShare, getShare } from './lib/api';
import { toast } from './components/Toast';
import './App.css';

function getResetToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get('reset') || null;
}

export default function App() {
  const { user } = useAuth();
  const [beforeText, setBeforeText] = useState('');
  const [afterText, setAfterText] = useState('');
  const [diffResult, setDiffResult] = useState(null);
  const [cardMap, setCardMap] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetToken, setResetToken] = useState(getResetToken);

  // Prompt existing users without email (once per session)
  useEffect(() => {
    if (!user) return;
    if (user.email) return;
    if (sessionStorage.getItem('clc-email-prompted')) return;
    sessionStorage.setItem('clc-email-prompted', '1');
    // Small delay so it doesn't fire immediately on login
    const timer = setTimeout(() => {
      toast.info('Add an email in Settings to enable password reset.', 6000);
    }, 1500);
    return () => clearTimeout(timer);
  }, [user]);

  function handleCompare() {
    const before = parse(beforeText);
    const after = parse(afterText);
    const diff = computeDiff(before, after);
    setDiffResult(diff);
    setCardMap(null);

    // Fetch card data in the background (non-blocking)
    const names = collectCardNames(diff);
    if (names.length > 0) {
      fetchCardData(names)
        .then(setCardMap)
        .catch(() => {}); // Silent fail — cards just won't be grouped by type
    }
  }

  function handleClear() {
    setBeforeText('');
    setAfterText('');
    setDiffResult(null);
    setCardMap(null);
  }

  function handleSwap() {
    setBeforeText(afterText);
    setAfterText(beforeText);
    setDiffResult(null);
  }

  const canCompare = useMemo(
    () => beforeText.trim().length > 0 || afterText.trim().length > 0,
    [beforeText, afterText]
  );

  // Load shared comparison from URL hash (e.g. #share/abc123)
  useEffect(() => {
    async function loadFromHash() {
      const hash = window.location.hash;
      if (!hash.startsWith('#share/')) return;
      const shareId = hash.slice(7);
      if (!shareId) return;
      try {
        const data = await getShare(shareId);
        setBeforeText(data.beforeText || '');
        setAfterText(data.afterText || '');
        // Auto-compare
        const before = parse(data.beforeText || '');
        const after = parse(data.afterText || '');
        const diff = computeDiff(before, after);
        setDiffResult(diff);

        // Fetch card data in the background
        const names = collectCardNames(diff);
        if (names.length > 0) {
          fetchCardData(names)
            .then(setCardMap)
            .catch(() => {});
        }
      } catch {
        toast.error('Failed to load shared comparison. The link may be invalid or expired.');
      }
    }
    loadFromHash();
  }, []);

  async function handleShare() {
    const commanders = diffResult?.commanders || [];
    const title = commanders.length > 0 ? commanders.join(' / ') + ' Changelog' : null;
    const data = await createShare(beforeText, afterText, title);
    const url = `${window.location.origin}${window.location.pathname}#share/${data.id}`;
    window.history.replaceState(null, '', `#share/${data.id}`);
    return url;
  }

  // Ctrl+Enter to compare
  const handleCompareRef = useRef(handleCompare);
  const canCompareRef = useRef(canCompare);

  useEffect(() => {
    handleCompareRef.current = handleCompare;
    canCompareRef.current = canCompare;
  });

  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canCompareRef.current) {
        e.preventDefault();
        handleCompareRef.current();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // If a reset token is in the URL, show the reset password form
  if (resetToken) {
    return (
      <div className="app">
        <header className="app-header">
          <h1 className="app-title">Card List Compare</h1>
        </header>
        <ResetPassword
          token={resetToken}
          onComplete={() => {
            setResetToken(null);
            window.history.replaceState(null, '', window.location.pathname);
          }}
        />
      </div>
    );
  }

  return (
    <div className="app" role="main">
      <a href="#deck-inputs" className="sr-only sr-only-focusable">Skip to content</a>
      <header className="app-header">
        <AuthBar
          onShowSettings={() => { setShowSettings(true); setShowAdmin(false); setShowForgotPassword(false); }}
          onShowAdmin={() => { setShowAdmin(true); setShowSettings(false); setShowForgotPassword(false); }}
          onShowForgotPassword={() => { setShowForgotPassword(true); setShowSettings(false); setShowAdmin(false); }}
        />
        <h1 className="app-title">Card List Compare</h1>
        <p className="app-subtitle">
          Compare two deck lists &mdash; paste, upload, or import from Archidekt / Moxfield / DeckCheck
        </p>
      </header>

      {showAdmin && user?.isAdmin && (
        <ErrorBoundary>
          <AdminPanel onClose={() => setShowAdmin(false)} />
        </ErrorBoundary>
      )}

      {showSettings && user && (
        <ErrorBoundary>
          <UserSettings onClose={() => setShowSettings(false)} />
        </ErrorBoundary>
      )}

      {showForgotPassword && !user && (
        <ErrorBoundary>
          <ForgotPassword onClose={() => setShowForgotPassword(false)} />
        </ErrorBoundary>
      )}

      <div id="deck-inputs" className="app-inputs">
        <DeckInput
          label="Before"
          value={beforeText}
          onChange={setBeforeText}
          user={user}
        />
        <DeckInput
          label="After"
          value={afterText}
          onChange={setAfterText}
          user={user}
        />
      </div>

      <div className="app-actions">
        <button
          className="btn btn-primary"
          onClick={handleCompare}
          disabled={!canCompare}
          type="button"
          title="Ctrl+Enter"
          aria-keyshortcuts="Control+Enter"
        >
          Compare Lists
        </button>
        <button className="btn btn-secondary" onClick={handleSwap} type="button">
          Swap
        </button>
        <button className="btn btn-secondary" onClick={handleClear} type="button">
          Clear
        </button>
      </div>

      <ErrorBoundary>
        {diffResult && <ChangelogOutput diffResult={diffResult} cardMap={cardMap} onShare={handleShare} afterText={afterText} />}
      </ErrorBoundary>

      {!diffResult && (
        <div className="app-empty">
          <p>
            Paste, upload, or import deck lists from{' '}
            <strong>Archidekt</strong> or <strong>Moxfield</strong> URLs,
            then click <strong>Compare Lists</strong> to generate a changelog.
          </p>
          <p className="app-empty-hint">
            Track your decks in Settings to automatically snapshot changes and compare versions.
          </p>
        </div>
      )}

    </div>
  );
}
