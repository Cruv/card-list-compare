import { useRef, useState, useEffect, useCallback } from 'react';
import { fetchDeckFromUrl } from '../lib/fetcher';
import { getTrackedDecks, getDeckSnapshots, getSnapshot } from '../lib/api';
import NameModal from './NameModal';
import './DeckInput.css';

const PLACEHOLDER = `Paste your deck list here...

Supported formats:
4 Lightning Bolt
4x Lightning Bolt
4 Lightning Bolt (M10) 123
CSV with header row

Separate sideboard with a blank line
or a "Sideboard" header.`;

export default function DeckInput({ label, value, onChange, snapshots, onLoadSnapshot, onSaveSnapshot, user }) {
  const fileRef = useRef(null);
  const [urlInput, setUrlInput] = useState('');
  const [showUrl, setShowUrl] = useState(false);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [showTracked, setShowTracked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showNameModal, setShowNameModal] = useState(false);

  // Tracked deck state
  const [trackedDecks, setTrackedDecks] = useState([]);
  const [trackedLoading, setTrackedLoading] = useState(false);
  const [expandedDeckId, setExpandedDeckId] = useState(null);
  const [deckSnapshots, setDeckSnapshots] = useState([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);

  const closeAllPanels = useCallback(() => {
    setShowUrl(false);
    setShowSnapshots(false);
    setShowTracked(false);
    setError(null);
  }, []);

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      onChange(ev.target.result);
      setError(null);
    };
    reader.onerror = () => {
      setError('Failed to read file. Please try again.');
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  async function handleUrlImport() {
    if (!urlInput.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const { text } = await fetchDeckFromUrl(urlInput.trim());
      onChange(text);
      setShowUrl(false);
      setUrlInput('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleUrlKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleUrlImport();
    }
    if (e.key === 'Escape') {
      setShowUrl(false);
      setError(null);
    }
  }

  function handleSave() {
    if (!value.trim()) return;
    setShowNameModal(true);
  }

  // Load tracked decks when panel opens
  useEffect(() => {
    if (!showTracked) return;
    setTrackedLoading(true);
    getTrackedDecks()
      .then(data => setTrackedDecks(data.decks))
      .catch(() => setError('Failed to load tracked decks'))
      .finally(() => setTrackedLoading(false));
  }, [showTracked]);

  async function handleExpandDeck(deckId) {
    if (expandedDeckId === deckId) {
      setExpandedDeckId(null);
      setDeckSnapshots([]);
      return;
    }
    setExpandedDeckId(deckId);
    setSnapshotsLoading(true);
    try {
      const data = await getDeckSnapshots(deckId);
      setDeckSnapshots(data.snapshots);
    } catch {
      setError('Failed to load snapshots');
    } finally {
      setSnapshotsLoading(false);
    }
  }

  async function handleLoadTrackedSnapshot(deckId, snapshotId) {
    setLoading(true);
    try {
      const data = await getSnapshot(deckId, snapshotId);
      onChange(data.snapshot.deck_text);
      setShowTracked(false);
      setExpandedDeckId(null);
    } catch {
      setError('Failed to load snapshot');
    } finally {
      setLoading(false);
    }
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso + 'Z').toLocaleString();
  }

  return (
    <div className="deck-input">
      <div className="deck-input-header">
        <label className="deck-input-label">{label}</label>
        <div className="deck-input-actions">
          <button
            className={`deck-input-btn${showUrl ? ' deck-input-btn--active' : ''}`}
            onClick={() => { closeAllPanels(); setShowUrl(!showUrl); }}
            type="button"
            title="Import from URL"
          >
            URL
          </button>
          <button
            className={`deck-input-btn${showSnapshots ? ' deck-input-btn--active' : ''}`}
            onClick={() => { closeAllPanels(); setShowSnapshots(!showSnapshots); }}
            type="button"
            title="Load a saved snapshot"
          >
            Snapshots
          </button>
          {user && (
            <button
              className={`deck-input-btn${showTracked ? ' deck-input-btn--active' : ''}`}
              onClick={() => { closeAllPanels(); setShowTracked(!showTracked); }}
              type="button"
              title="Load from tracked decks"
            >
              Tracked
            </button>
          )}
          <button
            className="deck-input-btn"
            onClick={handleSave}
            disabled={!value.trim()}
            type="button"
            title="Save current list as snapshot"
          >
            Save
          </button>
          <button
            className="deck-input-btn"
            onClick={() => fileRef.current?.click()}
            type="button"
            title="Upload a file"
          >
            File
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,.dec,.dek,.mwDeck"
            onChange={handleFile}
            hidden
          />
        </div>
      </div>

      {showUrl && (
        <div className="deck-input-url-bar">
          <input
            className="deck-input-url"
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            placeholder="Paste Archidekt or Moxfield URL..."
            autoFocus
            disabled={loading}
          />
          <button
            className="deck-input-url-go"
            onClick={handleUrlImport}
            disabled={loading || !urlInput.trim()}
            type="button"
          >
            {loading ? 'Loading...' : 'Import'}
          </button>
        </div>
      )}

      {showSnapshots && (
        <div className="deck-input-snapshots">
          {snapshots.length === 0 ? (
            <p className="deck-input-snapshots-empty">No saved snapshots yet.</p>
          ) : (
            <ul className="deck-input-snapshots-list">
              {snapshots.map((snap) => (
                <li key={snap.id} className="deck-input-snapshot-item">
                  <button
                    className="deck-input-snapshot-btn"
                    onClick={() => {
                      onLoadSnapshot(snap);
                      setShowSnapshots(false);
                    }}
                    type="button"
                  >
                    <span className="snapshot-name">{snap.name}</span>
                    <span className="snapshot-meta">
                      {snap.source !== 'paste' && <span className="snapshot-source">{snap.source}</span>}
                      {new Date(snap.createdAt).toLocaleDateString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showTracked && (
        <div className="deck-input-tracked">
          {trackedLoading ? (
            <p className="deck-input-tracked-empty">Loading tracked decks...</p>
          ) : trackedDecks.length === 0 ? (
            <p className="deck-input-tracked-empty">No tracked decks yet. Add them in Settings.</p>
          ) : (
            <ul className="deck-input-tracked-list">
              {trackedDecks.map(deck => (
                <li key={deck.id} className="deck-input-tracked-deck">
                  <button
                    className="deck-input-tracked-deck-btn"
                    onClick={() => handleExpandDeck(deck.id)}
                    type="button"
                    aria-expanded={expandedDeckId === deck.id}
                  >
                    <span className="deck-input-tracked-deck-name">
                      {expandedDeckId === deck.id ? '\u25BC' : '\u25B6'} {deck.deck_name}
                    </span>
                    <span className="deck-input-tracked-deck-meta">
                      {deck.archidekt_username} &middot; {deck.snapshot_count} snapshot{deck.snapshot_count !== 1 ? 's' : ''}
                    </span>
                  </button>
                  {expandedDeckId === deck.id && (
                    <div className="deck-input-tracked-snaps">
                      {snapshotsLoading ? (
                        <p className="deck-input-tracked-empty">Loading...</p>
                      ) : deckSnapshots.length === 0 ? (
                        <p className="deck-input-tracked-empty">No snapshots yet.</p>
                      ) : (
                        <ul className="deck-input-tracked-snap-list">
                          {deckSnapshots.map(snap => (
                            <li key={snap.id}>
                              <button
                                className="deck-input-tracked-snap-btn"
                                onClick={() => handleLoadTrackedSnapshot(deck.id, snap.id)}
                                disabled={loading}
                                type="button"
                              >
                                <span className="deck-input-tracked-snap-date">{formatDate(snap.created_at)}</span>
                                {snap.nickname && (
                                  <span className="deck-input-tracked-snap-nick">{snap.nickname}</span>
                                )}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <div className="deck-input-error" role="alert">
          {error.split('\n').map((line, i) => (
            <span key={i}>{line}<br /></span>
          ))}
        </div>
      )}

      <textarea
        className="deck-input-textarea"
        value={value}
        onChange={(e) => { onChange(e.target.value); setError(null); }}
        placeholder={PLACEHOLDER}
        spellCheck={false}
        aria-label={`${label} deck list`}
      />

      {showNameModal && (
        <NameModal
          defaultValue={`${label} - ${new Date().toLocaleDateString()}`}
          title="Save Snapshot"
          placeholder="Snapshot name..."
          onConfirm={(name) => {
            onSaveSnapshot(name, value);
            setShowNameModal(false);
          }}
          onCancel={() => setShowNameModal(false)}
        />
      )}
    </div>
  );
}
