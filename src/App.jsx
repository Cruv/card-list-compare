import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import DeckInput from './components/DeckInput';
import ChangelogOutput from './components/ChangelogOutput';
import SnapshotManager from './components/SnapshotManager';
import AuthBar from './components/AuthBar';
import AdminPanel from './components/AdminPanel';
import UserSettings from './components/UserSettings';
import ForgotPassword from './components/ForgotPassword';
import ResetPassword from './components/ResetPassword';
import ErrorBoundary from './components/ErrorBoundary';
import { useAuth } from './context/AuthContext';
import { parse } from './lib/parser';
import { computeDiff } from './lib/differ';
import { getSnapshots, saveSnapshot, deleteSnapshot } from './lib/snapshots';
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
  const [snapshots, setSnapshots] = useState(() => getSnapshots());
  const [showManager, setShowManager] = useState(false);
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

  const refreshSnapshots = useCallback(() => {
    setSnapshots(getSnapshots());
  }, []);

  function handleCompare() {
    const before = parse(beforeText);
    const after = parse(afterText);
    setDiffResult(computeDiff(before, after));
  }

  function handleClear() {
    setBeforeText('');
    setAfterText('');
    setDiffResult(null);
  }

  function handleSwap() {
    setBeforeText(afterText);
    setAfterText(beforeText);
    setDiffResult(null);
  }

  function handleSaveSnapshot(name, text) {
    saveSnapshot({ name, text, source: 'paste' });
    refreshSnapshots();
    toast.success(`Snapshot "${name}" saved`);
  }

  function handleDeleteSnapshot(id) {
    deleteSnapshot(id);
    refreshSnapshots();
  }

  function handleLoadSnapshot(snap, target) {
    if (target === 'before') setBeforeText(snap.text);
    else setAfterText(snap.text);
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
        setDiffResult(computeDiff(before, after));
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
    <div className="app">
      <header className="app-header">
        <AuthBar
          onShowSettings={() => { setShowSettings(true); setShowAdmin(false); setShowForgotPassword(false); }}
          onShowAdmin={() => { setShowAdmin(true); setShowSettings(false); setShowForgotPassword(false); }}
          onShowForgotPassword={() => { setShowForgotPassword(true); setShowSettings(false); setShowAdmin(false); }}
        />
        <h1 className="app-title">Card List Compare</h1>
        <p className="app-subtitle">
          Compare two deck lists &mdash; paste, upload, or import from Archidekt / Moxfield
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

      <div className="app-inputs">
        <DeckInput
          label="Before"
          value={beforeText}
          onChange={setBeforeText}
          snapshots={snapshots}
          onLoadSnapshot={(snap) => { setBeforeText(snap.text); setDiffResult(null); }}
          onSaveSnapshot={handleSaveSnapshot}
          user={user}
        />
        <DeckInput
          label="After"
          value={afterText}
          onChange={setAfterText}
          snapshots={snapshots}
          onLoadSnapshot={(snap) => { setAfterText(snap.text); setDiffResult(null); }}
          onSaveSnapshot={handleSaveSnapshot}
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
        <button
          className={`btn btn-secondary${showManager ? ' btn--active' : ''}`}
          onClick={() => setShowManager(!showManager)}
          type="button"
        >
          Manage Snapshots ({snapshots.length})
        </button>
      </div>

      {showManager && (
        <SnapshotManager
          snapshots={snapshots}
          onDelete={handleDeleteSnapshot}
          onLoad={handleLoadSnapshot}
          onClose={() => setShowManager(false)}
        />
      )}

      <ErrorBoundary>
        {diffResult && <ChangelogOutput diffResult={diffResult} onShare={handleShare} />}
      </ErrorBoundary>

      {!diffResult && !showManager && (
        <div className="app-empty">
          <p>
            Paste, upload, or import deck lists from{' '}
            <strong>Archidekt</strong> or <strong>Moxfield</strong> URLs,
            then click <strong>Compare Lists</strong> to generate a changelog.
          </p>
          <p className="app-empty-hint">
            Save snapshots to track your deck over time and compare any two versions.
          </p>
        </div>
      )}

    </div>
  );
}
