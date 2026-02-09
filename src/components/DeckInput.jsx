import { useRef, useState, useEffect, useCallback } from 'react';
import { fetchDeckFromUrl } from '../lib/fetcher';
import { getTrackedDecks, getDeckSnapshots, getSnapshot, refreshDeck, deleteSnapshot as apiDeleteSnapshot, renameSnapshot } from '../lib/api';
import { useConfirm } from './ConfirmModal';
import { toast } from './Toast';
import './DeckInput.css';

const INITIAL_SNAP_LIMIT = 5;

const PLACEHOLDER = `Paste your deck list here...

Supported formats:
4 Lightning Bolt
4x Lightning Bolt
4 Lightning Bolt (M10) 123
CSV with header row

Separate sideboard with a blank line
or a "Sideboard" header.`;

export default function DeckInput({ label, value, onChange, user }) {
  const fileRef = useRef(null);
  const [urlInput, setUrlInput] = useState('');
  const [showUrl, setShowUrl] = useState(false);
  const [showTracked, setShowTracked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Tracked deck state
  const [trackedDecks, setTrackedDecks] = useState([]);
  const [trackedLoading, setTrackedLoading] = useState(false);
  const [expandedDeckId, setExpandedDeckId] = useState(null);
  const [deckSnapshots, setDeckSnapshots] = useState([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [refreshingDeckId, setRefreshingDeckId] = useState(null);

  // Nickname editing state
  const [editingNickname, setEditingNickname] = useState(null);
  const [nicknameValue, setNicknameValue] = useState('');
  const [showAllSnapshots, setShowAllSnapshots] = useState(false);

  const [confirm, ConfirmDialog] = useConfirm();

  const closeAllPanels = useCallback(() => {
    setShowUrl(false);
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

  // Load tracked decks when panel opens
  const loadTrackedDecks = useCallback(async () => {
    setTrackedLoading(true);
    try {
      const data = await getTrackedDecks();
      setTrackedDecks(data.decks);
    } catch {
      setError('Failed to load tracked decks');
    } finally {
      setTrackedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!showTracked) return;
    loadTrackedDecks();
  }, [showTracked, loadTrackedDecks]);

  async function handleExpandDeck(deckId) {
    if (expandedDeckId === deckId) {
      setExpandedDeckId(null);
      setDeckSnapshots([]);
      setShowAllSnapshots(false);
      setEditingNickname(null);
      return;
    }
    setExpandedDeckId(deckId);
    setShowAllSnapshots(false);
    setEditingNickname(null);
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

  async function handleRefreshDeck(e, deckId) {
    e.stopPropagation();
    setRefreshingDeckId(deckId);
    try {
      const result = await refreshDeck(deckId);
      const msg = result.changed ? 'New snapshot saved!' : 'No changes detected.';
      toast(msg, result.changed ? 'success' : 'info');
      // Reload snapshots if this deck is expanded
      if (expandedDeckId === deckId) {
        const data = await getDeckSnapshots(deckId);
        setDeckSnapshots(data.snapshots);
      }
      // Reload deck list to update snapshot counts
      const decksData = await getTrackedDecks();
      setTrackedDecks(decksData.decks);
    } catch (err) {
      toast.error(err.message || 'Failed to refresh deck');
    } finally {
      setRefreshingDeckId(null);
    }
  }

  async function handleDeleteSnapshot(e, deckId, snapshotId) {
    e.stopPropagation();
    const confirmed = await confirm({
      title: 'Delete snapshot?',
      message: 'This snapshot will be permanently deleted.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await apiDeleteSnapshot(deckId, snapshotId);
      toast.success('Snapshot deleted');
      // Reload snapshots
      const data = await getDeckSnapshots(deckId);
      setDeckSnapshots(data.snapshots);
      // Update deck list for snapshot counts
      const decksData = await getTrackedDecks();
      setTrackedDecks(decksData.decks);
    } catch (err) {
      toast.error(err.message || 'Failed to delete snapshot');
    }
  }

  async function handleSaveNickname(deckId, snapshotId) {
    try {
      await renameSnapshot(deckId, snapshotId, nicknameValue || null);
      setEditingNickname(null);
      toast.success('Nickname saved');
      const data = await getDeckSnapshots(deckId);
      setDeckSnapshots(data.snapshots);
    } catch (err) {
      toast.error(err.message || 'Failed to save nickname');
    }
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso + 'Z').toLocaleString();
  }

  return (
    <div className="deck-input">
      {ConfirmDialog}
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
                  <div className="deck-input-tracked-deck-row">
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
                        {deck.archidekt_username} &middot; {deck.snapshot_count} snap{deck.snapshot_count !== 1 ? 's' : ''}
                      </span>
                    </button>
                    <button
                      className="deck-input-tracked-refresh"
                      onClick={(e) => handleRefreshDeck(e, deck.id)}
                      disabled={refreshingDeckId === deck.id}
                      type="button"
                      title="Refresh deck from Archidekt"
                    >
                      {refreshingDeckId === deck.id ? '...' : '\u21BB'}
                    </button>
                  </div>
                  {expandedDeckId === deck.id && (
                    <div className="deck-input-tracked-snaps">
                      {snapshotsLoading ? (
                        <p className="deck-input-tracked-empty">Loading...</p>
                      ) : deckSnapshots.length === 0 ? (
                        <p className="deck-input-tracked-empty">No snapshots yet.</p>
                      ) : (
                        <ul className="deck-input-tracked-snap-list">
                          {(showAllSnapshots ? deckSnapshots : deckSnapshots.slice(0, INITIAL_SNAP_LIMIT)).map((snap, index) => (
                            <li key={snap.id} className="deck-input-tracked-snap-row">
                              {editingNickname === snap.id ? (
                                <div className="deck-input-tracked-snap-edit">
                                  <span className="deck-input-tracked-snap-number">#{index + 1}</span>
                                  <input
                                    type="text"
                                    className="deck-input-tracked-snap-nick-input"
                                    value={nicknameValue}
                                    onChange={(e) => setNicknameValue(e.target.value)}
                                    placeholder="Nickname (optional)"
                                    maxLength={100}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') handleSaveNickname(deck.id, snap.id);
                                      if (e.key === 'Escape') setEditingNickname(null);
                                    }}
                                    autoFocus
                                  />
                                  <button
                                    className="deck-input-tracked-snap-save"
                                    onClick={() => handleSaveNickname(deck.id, snap.id)}
                                    type="button"
                                    title="Save nickname"
                                  >
                                    &#10003;
                                  </button>
                                  <button
                                    className="deck-input-tracked-snap-cancel"
                                    onClick={() => setEditingNickname(null)}
                                    type="button"
                                    title="Cancel"
                                  >
                                    &#10005;
                                  </button>
                                </div>
                              ) : (
                                <>
                                  <button
                                    className="deck-input-tracked-snap-btn"
                                    onClick={() => handleLoadTrackedSnapshot(deck.id, snap.id)}
                                    disabled={loading}
                                    type="button"
                                  >
                                    <span className="deck-input-tracked-snap-number">#{index + 1}</span>
                                    <span className="deck-input-tracked-snap-date">{formatDate(snap.created_at)}</span>
                                    {snap.nickname && (
                                      <span className="deck-input-tracked-snap-nick">{snap.nickname}</span>
                                    )}
                                  </button>
                                  <button
                                    className="deck-input-tracked-snap-rename"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEditingNickname(snap.id);
                                      setNicknameValue(snap.nickname || '');
                                    }}
                                    type="button"
                                    title={snap.nickname ? 'Rename snapshot' : 'Add nickname'}
                                  >
                                    &#9998;
                                  </button>
                                  <button
                                    className="deck-input-tracked-snap-delete"
                                    onClick={(e) => handleDeleteSnapshot(e, deck.id, snap.id)}
                                    type="button"
                                    title="Delete this snapshot"
                                  >
                                    &times;
                                  </button>
                                </>
                              )}
                            </li>
                          ))}
                          {deckSnapshots.length > INITIAL_SNAP_LIMIT && (
                            <li className="deck-input-tracked-snap-toggle">
                              <button
                                className="deck-input-tracked-snap-toggle-btn"
                                onClick={() => setShowAllSnapshots(!showAllSnapshots)}
                                type="button"
                              >
                                {showAllSnapshots
                                  ? 'Show less'
                                  : `Show all ${deckSnapshots.length} snapshots`}
                              </button>
                            </li>
                          )}
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
    </div>
  );
}
