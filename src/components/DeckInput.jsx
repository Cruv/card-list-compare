import { useRef, useState, useEffect, useCallback } from 'react';
import { fetchDeckFromUrl, detectSite } from '../lib/fetcher';
import { getTrackedDecks, getDeckSnapshots, getSnapshot, refreshDeck, deleteSnapshot as apiDeleteSnapshot, renameSnapshot, createSnapshot } from '../lib/api';
import { parse } from '../lib/parser';
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

function siteLabel(site) {
  if (site === 'archidekt') return 'Archidekt';
  if (site === 'moxfield') return 'Moxfield';
  if (site === 'deckcheck') return 'DeckCheck';
  if (site === 'tappedout') return 'TappedOut';
  if (site === 'deckstats') return 'Deckstats';
  return site;
}

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

  // Save-to-tracked prompt state (auto-prompt after URL import)
  const [savePrompt, setSavePrompt] = useState(null);
  const [selectedSaveDeck, setSelectedSaveDeck] = useState(null);

  // Manual save-to-tracked panel state
  const [showSavePanel, setShowSavePanel] = useState(false);
  const [savePanelDecks, setSavePanelDecks] = useState([]);
  const [savePanelLoading, setSavePanelLoading] = useState(false);
  const [savePanelSaving, setSavePanelSaving] = useState(false);
  const [savePanelSelected, setSavePanelSelected] = useState(null);
  const [savePanelNickname, setSavePanelNickname] = useState('');

  const [confirm, ConfirmDialog] = useConfirm();

  const closeAllPanels = useCallback(() => {
    setShowUrl(false);
    setShowTracked(false);
    setShowSavePanel(false);
    setError(null);
  }, []);

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      onChange(ev.target.result);
      setError(null);
      setSavePrompt(null);
    };
    reader.onerror = () => {
      setError('Failed to read file. Please try again.');
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // Match imported commanders against tracked decks
  function findMatchingDecks(commanders, decks) {
    if (!commanders || commanders.length === 0 || !decks || decks.length === 0) return [];
    const importedSet = new Set(commanders.map(c => c.toLowerCase()));
    return decks.filter(deck => {
      let deckCommanders = [];
      try {
        deckCommanders = JSON.parse(deck.commanders || '[]');
      } catch { return false; }
      if (!Array.isArray(deckCommanders) || deckCommanders.length === 0) return false;
      return deckCommanders.some(c => importedSet.has(c.toLowerCase()));
    });
  }

  async function importFromUrl(url) {
    setLoading(true);
    setError(null);
    setSavePrompt(null);
    try {
      const { text, site, commanders, stats } = await fetchDeckFromUrl(url);
      onChange(text);
      setShowUrl(false);
      setUrlInput('');

      // Show metadata coverage feedback
      if (stats && stats.totalCards > 0) {
        const pct = Math.round((stats.cardsWithMeta / stats.totalCards) * 100);
        if (stats.cardsWithMeta > 0) {
          toast.success(`Imported ${stats.totalCards} cards from ${siteLabel(site)} \u2014 ${pct}% with printing info`);
        } else {
          toast.info(`Imported ${stats.totalCards} cards from ${siteLabel(site)} (no printing info available)`);
        }
      }

      // Check for tracked deck commander match
      if (user && commanders && commanders.length > 0) {
        try {
          const data = await getTrackedDecks();
          const matches = findMatchingDecks(commanders, data.decks);
          if (matches.length > 0) {
            setSavePrompt({ text, site, commanders, matchingDecks: matches });
            setSelectedSaveDeck(matches[0].id);
          }
        } catch {
          // Non-fatal — just skip the prompt
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleUrlImport() {
    if (!urlInput.trim()) return;
    importFromUrl(urlInput.trim());
  }

  function handlePaste(e) {
    const pasted = e.clipboardData?.getData('text/plain')?.trim();
    if (!pasted || pasted.includes('\n')) return; // Multi-line = deck text, not a URL
    if (detectSite(pasted)) {
      e.preventDefault();
      importFromUrl(pasted);
    }
  }

  async function handleSaveToTracked() {
    if (!savePrompt || !selectedSaveDeck) return;
    const deck = savePrompt.matchingDecks.find(d => d.id === selectedSaveDeck);
    const nickname = `Imported from ${siteLabel(savePrompt.site)}`;
    try {
      await createSnapshot(selectedSaveDeck, savePrompt.text, nickname);
      toast.success(`Snapshot saved to ${deck?.deck_name || 'tracked deck'}`);
      setSavePrompt(null);
    } catch (err) {
      toast.error(err.message || 'Failed to save snapshot');
    }
  }

  async function handleOpenSavePanel() {
    if (!value.trim()) return;
    setShowSavePanel(true);
    setSavePanelLoading(true);
    setSavePanelNickname('');
    try {
      const data = await getTrackedDecks();
      const allDecks = data.decks || [];
      setSavePanelDecks(allDecks);

      // Try to auto-select a matching deck by commander
      const parsed = parse(value);
      const commanders = parsed.commanders || [];
      if (commanders.length > 0) {
        const matches = findMatchingDecks(commanders, allDecks);
        setSavePanelSelected(matches.length > 0 ? matches[0].id : (allDecks[0]?.id || null));
      } else {
        setSavePanelSelected(allDecks[0]?.id || null);
      }
    } catch {
      toast.error('Failed to load tracked decks');
      setShowSavePanel(false);
    } finally {
      setSavePanelLoading(false);
    }
  }

  async function handleSavePanelConfirm() {
    if (!savePanelSelected || !value.trim()) return;
    setSavePanelSaving(true);
    const deck = savePanelDecks.find(d => d.id === savePanelSelected);
    try {
      await createSnapshot(savePanelSelected, value.trim(), savePanelNickname.trim() || null);
      toast.success(`Snapshot saved to ${deck?.deck_name || 'tracked deck'}`);
      setShowSavePanel(false);
    } catch (err) {
      toast.error(err.message || 'Failed to save snapshot');
    } finally {
      setSavePanelSaving(false);
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
      setSavePrompt(null);
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
      if (expandedDeckId === deckId) {
        const data = await getDeckSnapshots(deckId);
        setDeckSnapshots(data.snapshots);
      }
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
      const data = await getDeckSnapshots(deckId);
      setDeckSnapshots(data.snapshots);
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
            onClick={() => { closeAllPanels(); setSavePrompt(null); setShowUrl(!showUrl); }}
            type="button"
            title="Import from URL"
          >
            URL
          </button>
          {user && (
            <button
              className={`deck-input-btn${showTracked ? ' deck-input-btn--active' : ''}`}
              onClick={() => { closeAllPanels(); setSavePrompt(null); setShowTracked(!showTracked); }}
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
          {user && value.trim() && (
            <button
              className={`deck-input-btn${showSavePanel ? ' deck-input-btn--active' : ''}`}
              onClick={() => {
                if (showSavePanel) {
                  setShowSavePanel(false);
                } else {
                  closeAllPanels();
                  setSavePrompt(null);
                  handleOpenSavePanel();
                }
              }}
              type="button"
              title="Save this deck list as a snapshot to a tracked deck"
            >
              Save
            </button>
          )}
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
            placeholder="Paste Archidekt, Moxfield, TappedOut, Deckstats, or DeckCheck URL..."
            autoFocus
            disabled={loading}
          />
          <button
            className="deck-input-url-go"
            onClick={handleUrlImport}
            disabled={loading || !urlInput.trim()}
            type="button"
          >
            {loading ? <><span className="spinner" /> Importing...</> : 'Import'}
          </button>
        </div>
      )}

      {savePrompt && (
        <div className="deck-input-save-prompt">
          {savePrompt.matchingDecks.length === 1 ? (
            <span className="deck-input-save-prompt-text">
              Commanders match <strong>{savePrompt.matchingDecks[0].deck_name}</strong>. Save as snapshot?
            </span>
          ) : (
            <span className="deck-input-save-prompt-text">
              Commanders match tracked decks. Save to:{' '}
              <select
                className="deck-input-save-prompt-select"
                value={selectedSaveDeck || ''}
                onChange={(e) => setSelectedSaveDeck(Number(e.target.value))}
              >
                {savePrompt.matchingDecks.map(d => (
                  <option key={d.id} value={d.id}>{d.deck_name}</option>
                ))}
              </select>
            </span>
          )}
          <div className="deck-input-save-prompt-actions">
            <button
              className="deck-input-save-prompt-btn deck-input-save-prompt-btn--save"
              onClick={handleSaveToTracked}
              type="button"
            >
              Save
            </button>
            <button
              className="deck-input-save-prompt-btn deck-input-save-prompt-btn--dismiss"
              onClick={() => setSavePrompt(null)}
              type="button"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {showSavePanel && (
        <div className="deck-input-save-panel">
          {savePanelLoading ? (
            <p className="deck-input-tracked-empty">Loading tracked decks...</p>
          ) : savePanelDecks.length === 0 ? (
            <p className="deck-input-tracked-empty">No tracked decks yet. Add them in Settings.</p>
          ) : (
            <>
              <div className="deck-input-save-panel-row">
                <label className="deck-input-save-panel-label">Save to:</label>
                <select
                  className="deck-input-save-panel-select"
                  value={savePanelSelected || ''}
                  onChange={(e) => setSavePanelSelected(Number(e.target.value))}
                >
                  {savePanelDecks.map(d => (
                    <option key={d.id} value={d.id}>{d.deck_name}</option>
                  ))}
                </select>
              </div>
              <div className="deck-input-save-panel-row">
                <label className="deck-input-save-panel-label">Nickname:</label>
                <input
                  className="deck-input-save-panel-nick"
                  type="text"
                  value={savePanelNickname}
                  onChange={(e) => setSavePanelNickname(e.target.value)}
                  placeholder="Optional nickname"
                  maxLength={100}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSavePanelConfirm();
                    if (e.key === 'Escape') setShowSavePanel(false);
                  }}
                />
              </div>
              <div className="deck-input-save-panel-actions">
                <button
                  className="deck-input-save-prompt-btn deck-input-save-prompt-btn--save"
                  onClick={handleSavePanelConfirm}
                  disabled={savePanelSaving || !savePanelSelected}
                  type="button"
                >
                  {savePanelSaving ? 'Saving...' : 'Save Snapshot'}
                </button>
                <button
                  className="deck-input-save-prompt-btn deck-input-save-prompt-btn--dismiss"
                  onClick={() => setShowSavePanel(false)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </>
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
        onChange={(e) => { onChange(e.target.value); setError(null); setSavePrompt(null); }}
        onPaste={handlePaste}
        placeholder={PLACEHOLDER}
        spellCheck={false}
        aria-label={`${label} deck list`}
      />
    </div>
  );
}
