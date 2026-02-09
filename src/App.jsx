import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import DeckInput from './components/DeckInput';
import ChangelogOutput from './components/ChangelogOutput';
import SnapshotManager from './components/SnapshotManager';
import AuthBar from './components/AuthBar';
import DeckTracker from './components/DeckTracker';
import ErrorBoundary from './components/ErrorBoundary';
import { useAuth } from './context/AuthContext';
import { parse } from './lib/parser';
import { computeDiff } from './lib/differ';
import { getSnapshots, saveSnapshot, deleteSnapshot } from './lib/snapshots';
import { createShare, getShare } from './lib/api';
import { toast } from './components/Toast';
import './App.css';

export default function App() {
  const { user } = useAuth();
  const [beforeText, setBeforeText] = useState('');
  const [afterText, setAfterText] = useState('');
  const [diffResult, setDiffResult] = useState(null);
  const [snapshots, setSnapshots] = useState(() => getSnapshots());
  const [showManager, setShowManager] = useState(false);

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

  const handleLoadToCompare = useCallback((text, target) => {
    if (target === 'before') setBeforeText(text);
    else setAfterText(text);
    setDiffResult(null);
  }, []);

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

  return (
    <div className="app">
      <header className="app-header">
        <AuthBar />
        <h1 className="app-title">Card List Compare</h1>
        <p className="app-subtitle">
          Compare two deck lists &mdash; paste, upload, or import from Archidekt / Moxfield
        </p>
      </header>

      <div className="app-inputs">
        <DeckInput
          label="Before"
          value={beforeText}
          onChange={setBeforeText}
          snapshots={snapshots}
          onLoadSnapshot={(snap) => { setBeforeText(snap.text); setDiffResult(null); }}
          onSaveSnapshot={handleSaveSnapshot}
        />
        <DeckInput
          label="After"
          value={afterText}
          onChange={setAfterText}
          snapshots={snapshots}
          onLoadSnapshot={(snap) => { setAfterText(snap.text); setDiffResult(null); }}
          onSaveSnapshot={handleSaveSnapshot}
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

      <ErrorBoundary>
        {user && (
          <DeckTracker
            onLoadToCompare={handleLoadToCompare}
          />
        )}
      </ErrorBoundary>
    </div>
  );
}
