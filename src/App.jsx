import { useState, useCallback } from 'react';
import DeckInput from './components/DeckInput';
import ChangelogOutput from './components/ChangelogOutput';
import SnapshotManager from './components/SnapshotManager';
import { parse } from './lib/parser';
import { computeDiff } from './lib/differ';
import { getSnapshots, saveSnapshot, deleteSnapshot } from './lib/snapshots';
import './App.css';

export default function App() {
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

  const canCompare = beforeText.trim().length > 0 || afterText.trim().length > 0;

  return (
    <div className="app">
      <header className="app-header">
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

      {diffResult && <ChangelogOutput diffResult={diffResult} />}

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
