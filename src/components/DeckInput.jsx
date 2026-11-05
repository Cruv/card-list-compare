import { useRef, useState, useEffect, useCallback, useId } from 'react';
import { fetchDeckFromUrl, detectSite } from '../lib/fetcher';
import { getTrackedDecks, getDeckSnapshots, getSnapshot, createSnapshot } from '../lib/api';
import { parse } from '../lib/parser';
import { toast } from './Toast';
import Icon from './Icon';
import './DeckInput.css';
import { sourceStatusLabel } from '../lib/sourceSync';
import './SourceSyncReview.css';

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

export default function DeckInput({ label, caption, value, onChange, user }) {
  const fileRef = useRef(null);
  const textRef = useRef(null);
  const snapshotRequest = useRef(0);
  const inputId = useId();
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

  const [showAllSnapshots, setShowAllSnapshots] = useState(false);
  const [importedList, setImportedList] = useState(null);

  // Manual save-to-tracked panel state
  const [showSavePanel, setShowSavePanel] = useState(false);
  const [savePanelDecks, setSavePanelDecks] = useState([]);
  const [savePanelLoading, setSavePanelLoading] = useState(false);
  const [savePanelSaving, setSavePanelSaving] = useState(false);
  const [savePanelSelected, setSavePanelSelected] = useState(null);
  const [savePanelNickname, setSavePanelNickname] = useState('');

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
      setImportedList(null);
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
    setImportedList(null);
    try {
      const { text, site, stats } = await fetchDeckFromUrl(url);
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

      setImportedList({ text, site });
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

  async function handleOpenSavePanel() {
    if (!value.trim()) return;
    setShowSavePanel(true);
    setSavePanelLoading(true);
    setSavePanelNickname(importedList?.text === value ? `Imported from ${siteLabel(importedList.site)}` : '');
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
    const request = ++snapshotRequest.current;
    if (expandedDeckId === deckId) {
      setExpandedDeckId(null);
      setDeckSnapshots([]);
      setShowAllSnapshots(false);
      return;
    }
    setExpandedDeckId(deckId);
    setDeckSnapshots([]);
    setShowAllSnapshots(false);
    setSnapshotsLoading(true);
    try {
      const data = await getDeckSnapshots(deckId);
      if (request === snapshotRequest.current) setDeckSnapshots(data.snapshots);
    } catch {
      if (request === snapshotRequest.current) setError('Failed to load versions');
    } finally {
      if (request === snapshotRequest.current) setSnapshotsLoading(false);
    }
  }

  async function handleLoadTrackedSnapshot(deckId, snapshotId) {
    setLoading(true);
    try {
      const data = await getSnapshot(deckId, snapshotId);
      onChange(data.snapshot.deck_text);
      setShowTracked(false);
      setExpandedDeckId(null);
      setImportedList(null);
    } catch {
      setError('Failed to load snapshot');
    } finally {
      setLoading(false);
    }
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : iso + 'Z').toLocaleString();
  }

  return (
    <div className="deck-input">
      <div className="deck-input-header">
        <div className="deck-input-heading">
          <label className="deck-input-label" htmlFor={inputId}>{label}</label>
          <span className="deck-input-caption">{caption || 'Paste deck text or a deck URL'}</span>
        </div>
        {user && value.trim() && (
          <button
            className={`deck-input-btn deck-input-save-toggle${showSavePanel ? ' deck-input-btn--active' : ''}`}
            onClick={() => {
              if (showSavePanel) setShowSavePanel(false);
              else { closeAllPanels(); handleOpenSavePanel(); }
            }}
            type="button"
            aria-expanded={showSavePanel}
            title="Save a version to a deck in your library"
          ><Icon name="plus" size={16} /> Save version</button>
        )}
      </div>
      <div className="deck-input-actions" role="group" aria-label={`${label} import options`}>
          <button
            className={`deck-input-btn${showUrl ? ' deck-input-btn--active' : ''}`}
            onClick={() => { closeAllPanels(); setImportedList(null); setShowUrl(!showUrl); }}
            type="button"
            title="Import from URL"
            aria-expanded={showUrl}
          >
            <Icon name="connections" size={16} /> Import URL
          </button>
          {user && (
            <button
              className={`deck-input-btn${showTracked ? ' deck-input-btn--active' : ''}`}
              onClick={() => { closeAllPanels(); setImportedList(null); setShowTracked(!showTracked); }}
              type="button"
              title="Load a saved deck version"
              aria-expanded={showTracked}
            >
              <Icon name="library" size={16} /> Load saved
            </button>
          )}
          <button
            className="deck-input-btn"
            onClick={() => fileRef.current?.click()}
            type="button"
            title="Upload a file"
          >
            <Icon name="download" size={16} /> Upload file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,.dec,.dek,.mwDeck"
            onChange={handleFile}
            hidden
          />
      </div>

      {showUrl && (
        <div className="deck-input-url-bar">
          <input
            className="deck-input-url"
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            placeholder="https://archidekt.com/decks/…"
            aria-label={`${label} deck URL`}
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

      {showSavePanel && (
        <div className="deck-input-save-panel">
          {savePanelLoading ? (
            <p className="deck-input-tracked-empty">Loading your decks…</p>
          ) : savePanelDecks.length === 0 ? (
            <p className="deck-input-tracked-empty">No saved decks yet. <a href="#library">Add a deck in your library.</a></p>
          ) : (
            <>
              <div className="deck-input-save-panel-row">
                <label className="deck-input-save-panel-label" htmlFor={`${inputId}-save-deck`}>Deck</label>
                <select
                  id={`${inputId}-save-deck`}
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
                <label className="deck-input-save-panel-label" htmlFor={`${inputId}-nickname`}>Version name</label>
                <input
                  id={`${inputId}-nickname`}
                  className="deck-input-save-panel-nick"
                  type="text"
                  value={savePanelNickname}
                  onChange={(e) => setSavePanelNickname(e.target.value)}
                  placeholder="Optional version name"
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
                  {savePanelSaving ? 'Saving...' : 'Save version'}
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
            <p className="deck-input-tracked-empty">Loading your decks…</p>
          ) : trackedDecks.length === 0 ? (
            <p className="deck-input-tracked-empty">No saved decks yet. <a href="#library">Add a deck in your library.</a></p>
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
                        <Icon name="chevron" size={16} className={expandedDeckId === deck.id ? 'deck-input-chevron--open' : ''} /> {deck.deck_name}
                      </span>
                      <span className="deck-input-tracked-deck-meta">
                        {deck.source_type === 'manual' ? 'Manual deck' : deck.archidekt_username} &middot; {deck.snapshot_count} version{deck.snapshot_count !== 1 ? 's' : ''}
                      </span>
                      {deck.source_type !== 'manual' && ['pending_review', 'local_changes'].includes(deck.source_sync?.status) &&
                        <span className={`source-sync-badge${deck.source_sync.status === 'pending_review' ? ' source-sync-badge--pending' : ''}`}>{sourceStatusLabel(deck.source_sync.status)}</span>}
                    </button>
                  </div>
                  {expandedDeckId === deck.id && (
                    <div className="deck-input-tracked-snaps">
                      <a className="deck-input-manage-link" href={`#library/${deck.id}`}>Manage versions in this deck ↗</a>
                      {snapshotsLoading ? (
                        <p className="deck-input-tracked-empty">Loading...</p>
                      ) : deckSnapshots.length === 0 ? (
                        <p className="deck-input-tracked-empty">No saved versions yet.</p>
                      ) : (
                        <ul className="deck-input-tracked-snap-list">
                          {(showAllSnapshots ? deckSnapshots : deckSnapshots.slice(0, INITIAL_SNAP_LIMIT)).map((snap, index) => (
                            <li key={snap.id} className="deck-input-tracked-snap-row">
                              <button className="deck-input-tracked-snap-btn"
                                onClick={() => handleLoadTrackedSnapshot(deck.id, snap.id)}
                                disabled={loading} type="button">
                                <span className="deck-input-tracked-snap-number">{index === 0 ? 'Latest' : `#${snap.id}`}</span>
                                <span className="deck-input-tracked-snap-date">{formatDate(snap.created_at)}</span>
                                {snap.nickname && <span className="deck-input-tracked-snap-nick">{snap.nickname}</span>}
                                {!!snap.is_paper && <span className="deck-input-tracked-snap-nick">Paper version</span>}
                              </button>
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
                                  : `Show all ${deckSnapshots.length} versions`}
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
        id={inputId}
        ref={textRef}
        className="deck-input-textarea"
        value={value}
        onChange={(e) => { onChange(e.target.value); setError(null); setImportedList(null); }}
        onPaste={handlePaste}
        placeholder={PLACEHOLDER}
        spellCheck={false}
        aria-label={`${label} deck list`}
        aria-describedby={`${inputId}-hint`}
      />
      <div className="deck-input-footer" id={`${inputId}-hint`}>
        <a href="#guide/importing-decks">Supported list formats</a>
        <span>{value.trim() ? `${value.trim().split('\n').length} lines` : 'Ready for your list'}</span>
      </div>
    </div>
  );
}
