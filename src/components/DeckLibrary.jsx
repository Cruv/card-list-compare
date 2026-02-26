import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from './ConfirmModal';
import { toast } from './Toast';
import {
  getOwners, addOwner, removeOwner, getOwnerDecks,
  getTrackedDecks, trackDeck, untrackDeck, refreshDeck, refreshAllDecks,
  exportDecks,
  getCollection, importCollection, updateCollectionCard, deleteCollectionCard, clearCollection, getCollectionSummary,
  getDeckOverlap,
  getNotificationHistory,
} from '../lib/api';
import DeckGridCard from './DeckGridCard';
import Skeleton from './Skeleton';
import './UserSettings.css';
import './DeckLibrary.css';

export default function DeckLibrary() {
  const { user } = useAuth();
  const [confirm, ConfirmDialog] = useConfirm();
  const [activeTab, setActiveTab] = useState('deck-tracker');

  return (
    <div className="settings-page deck-library-page">
      <button className="settings-back-link" onClick={() => { window.location.hash = ''; }} type="button">
        &larr; Back to Compare
      </button>
      <div className="user-settings">
        {ConfirmDialog}
        <div className="user-settings-header">
          <h2>Deck Library</h2>
        </div>

        <nav className="user-settings-tabs">
          <button
            className={`user-settings-tab${activeTab === 'deck-tracker' ? ' user-settings-tab--active' : ''}`}
            onClick={() => setActiveTab('deck-tracker')}
            type="button"
          >
            Deck Tracker
          </button>
          <button
            className={`user-settings-tab${activeTab === 'collection' ? ' user-settings-tab--active' : ''}`}
            onClick={() => setActiveTab('collection')}
            type="button"
          >
            Collection
          </button>
          <button
            className={`user-settings-tab${activeTab === 'overlap' ? ' user-settings-tab--active' : ''}`}
            onClick={() => setActiveTab('overlap')}
            type="button"
          >
            Overlap
          </button>
          <button
            className={`user-settings-tab${activeTab === 'notifications' ? ' user-settings-tab--active' : ''}`}
            onClick={() => setActiveTab('notifications')}
            type="button"
          >
            Notifications
          </button>
        </nav>

        {activeTab === 'deck-tracker' && (
          <div className="user-settings-panel">
            <DeckTrackerSettings confirm={confirm} />
          </div>
        )}

        {activeTab === 'collection' && (
          <div className="user-settings-panel">
            <CollectionManager confirm={confirm} />
          </div>
        )}

        {activeTab === 'overlap' && (
          <div className="user-settings-panel">
            <DeckOverlapAnalysis />
          </div>
        )}

        {activeTab === 'notifications' && (
          <div className="user-settings-panel">
            <NotificationHistory />
          </div>
        )}

      </div>
    </div>
  );
}

// --- Deck Tracker Management ---

function DeckTrackerSettings({ confirm }) {
  const [owners, setOwners] = useState([]);
  const [trackedDecks, setTrackedDecks] = useState([]);
  const [newOwner, setNewOwner] = useState('');
  const [expandedOwner, setExpandedOwner] = useState(null);
  const [ownerDecks, setOwnerDecks] = useState([]);
  const [loadingOwnerDecks, setLoadingOwnerDecks] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);

  // Search + collapse + tag filter state
  const [deckSearch, setDeckSearch] = useState('');
  const [collapsedOwners, setCollapsedOwners] = useState(new Set());
  const [tagFilter, setTagFilter] = useState('');

  // Bulk mode
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedDecks, setSelectedDecks] = useState(new Set());

  // Collect all unique tags across decks
  const allTags = useMemo(() => {
    const tags = new Set();
    for (const deck of trackedDecks) {
      if (deck.tags) for (const t of deck.tags) tags.add(t);
    }
    return [...tags].sort();
  }, [trackedDecks]);

  // Group decks by owner
  const decksByOwner = useMemo(() => {
    const groups = new Map();
    for (const deck of trackedDecks) {
      const owner = deck.archidekt_username || 'Unknown';
      if (!groups.has(owner)) groups.set(owner, []);
      groups.get(owner).push(deck);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [trackedDecks]);

  // Filter by search and tag
  const filteredDecksByOwner = useMemo(() => {
    const term = deckSearch.trim().toLowerCase();
    const tag = tagFilter;
    if (!term && !tag) return decksByOwner;
    return decksByOwner
      .map(([owner, decks]) => {
        const filtered = decks.filter(d => {
          const matchesTerm = !term || d.deck_name.toLowerCase().includes(term) || owner.toLowerCase().includes(term);
          const matchesTag = !tag || (d.tags && d.tags.includes(tag));
          return matchesTerm && matchesTag;
        });
        return [owner, filtered];
      })
      .filter(([, decks]) => decks.length > 0);
  }, [decksByOwner, deckSearch, tagFilter]);

  const toggleOwnerCollapse = useCallback((owner) => {
    setCollapsedOwners(prev => {
      const next = new Set(prev);
      if (next.has(owner)) next.delete(owner);
      else next.add(owner);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [ownersData, decksData] = await Promise.all([getOwners(), getTrackedDecks()]);
      setOwners(ownersData.owners);
      setTrackedDecks(decksData.decks);
    } catch {
      toast.error('Failed to load tracking data.');
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleAddOwner(e) {
    e.preventDefault();
    if (!newOwner.trim()) return;
    setError(null);
    setLoading(true);
    try {
      await addOwner(newOwner.trim());
      toast.success(`Now tracking ${newOwner.trim()}`);
      setNewOwner('');
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRemoveOwner(id) {
    const owner = owners.find(o => o.id === id);
    const confirmed = await confirm({
      title: 'Remove tracked user?',
      message: `This will stop tracking "${owner?.archidekt_username || 'this user'}" and delete all their tracked decks and snapshots.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await removeOwner(id);
      if (expandedOwner === id) {
        setExpandedOwner(null);
        setOwnerDecks([]);
      }
      toast.success('User removed');
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleBrowseDecks(ownerId) {
    if (expandedOwner === ownerId) {
      setExpandedOwner(null);
      setOwnerDecks([]);
      return;
    }
    setLoadingOwnerDecks(true);
    setError(null);
    try {
      const data = await getOwnerDecks(ownerId);
      setOwnerDecks(data.decks);
      setExpandedOwner(ownerId);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingOwnerDecks(false);
    }
  }

  async function handleTrackDeck(ownerId, deck) {
    setError(null);
    try {
      const result = await trackDeck(ownerId, deck.id, deck.name, deck.url);
      toast.success(`Now tracking "${deck.name}"`);
      const data = await getOwnerDecks(ownerId);
      setOwnerDecks(data.decks);
      await refresh();

      const tracked = result?.deck;
      if (tracked) {
        let cmds = [];
        try { cmds = JSON.parse(tracked.commanders || '[]'); } catch { /* ignore */ }
        if (!cmds || cmds.length === 0) {
          toast('No commander detected — click the deck card to set one.', 'info', 5000);
        }
      }
    } catch (err) {
      setError(err.message);
    }
  }

  // Bulk operations
  function toggleBulkMode() {
    setBulkMode(!bulkMode);
    setSelectedDecks(new Set());
  }

  const toggleDeckSelection = useCallback((deckId) => {
    setSelectedDecks(prev => {
      const next = new Set(prev);
      if (next.has(deckId)) next.delete(deckId);
      else next.add(deckId);
      return next;
    });
  }, []);

  const toggleOwnerSelection = useCallback((ownerDecks) => {
    setSelectedDecks(prev => {
      const allSelected = ownerDecks.every(d => prev.has(d.id));
      const next = new Set(prev);
      for (const d of ownerDecks) {
        if (allSelected) next.delete(d.id);
        else next.add(d.id);
      }
      return next;
    });
  }, []);

  function selectAllDecks() {
    setSelectedDecks(new Set(trackedDecks.map(d => d.id)));
  }

  function deselectAllDecks() {
    setSelectedDecks(new Set());
  }

  async function handleBulkRefresh() {
    const ids = [...selectedDecks];
    let ok = 0, fail = 0;
    for (const id of ids) {
      try {
        await refreshDeck(id);
        ok++;
      } catch {
        fail++;
      }
    }
    if (fail > 0) {
      toast(`Refreshed ${ok} decks, ${fail} failed`, 'error');
    } else {
      toast.success(`Refreshed ${ok} decks`);
    }
    await refresh();
  }

  async function handleBulkExport() {
    const ids = [...selectedDecks];
    try {
      const data = await exportDecks(ids);
      const text = data.decks.map(d => `// ${d.name}${d.commanders ? ' — ' + d.commanders : ''}\n${d.text}`).join('\n\n---\n\n');
      await navigator.clipboard.writeText(text);
      toast.success(`${data.decks.length} decks copied to clipboard`);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleBulkUntrack() {
    const ids = [...selectedDecks];
    const confirmed = await confirm({
      title: `Untrack ${ids.length} decks?`,
      message: 'All snapshots for these decks will be permanently deleted.',
      confirmLabel: `Untrack ${ids.length}`,
      danger: true,
    });
    if (!confirmed) return;
    let ok = 0, fail = 0;
    for (const id of ids) {
      try {
        await untrackDeck(id);
        ok++;
      } catch {
        fail++;
      }
    }
    if (fail > 0) {
      toast(`Untracked ${ok} decks, ${fail} failed`, 'error');
    } else {
      toast.success(`Untracked ${ok} decks`);
    }
    setSelectedDecks(new Set());
    await refresh();
  }

  async function handleRefreshAll() {
    setRefreshingAll(true);
    setError(null);
    try {
      const data = await refreshAllDecks();
      const { summary } = data;
      if (summary.failed > 0) {
        toast(`Refreshed ${summary.total} decks: ${summary.changed} updated, ${summary.failed} failed`, 'error', 5000);
      } else if (summary.changed > 0) {
        toast.success(`Refreshed ${summary.total} decks: ${summary.changed} updated`);
      } else {
        toast('All decks are up to date', 'info');
      }
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setRefreshingAll(false);
    }
  }

  return (
    <div className="settings-tracker">
      {error && <div className="settings-tracker-error" role="alert">{error}</div>}

      <form className="settings-tracker-add" onSubmit={handleAddOwner}>
        <input
          type="text"
          placeholder="Archidekt username"
          value={newOwner}
          onChange={e => setNewOwner(e.target.value)}
          disabled={loading}
          aria-label="Archidekt username to track"
        />
        <button className="btn btn-primary btn-sm" type="submit" disabled={loading || !newOwner.trim()}>
          {loading ? 'Adding...' : 'Track User'}
        </button>
      </form>

      {owners.length > 0 && (
        <div className="settings-tracker-owners">
          {owners.map(owner => (
            <div key={owner.id} className="settings-tracker-owner">
              <div className="settings-tracker-owner-header">
                <span className="settings-tracker-owner-name">{owner.archidekt_username}</span>
                <div className="settings-tracker-owner-actions">
                  <button
                    className={`btn btn-secondary btn-sm${expandedOwner === owner.id ? ' btn--active' : ''}`}
                    onClick={() => handleBrowseDecks(owner.id)}
                    type="button"
                    aria-expanded={expandedOwner === owner.id}
                  >
                    {loadingOwnerDecks && expandedOwner === owner.id ? 'Loading...' : 'Browse Decks'}
                  </button>
                  <button
                    className="btn btn-sm btn-ghost-danger"
                    onClick={() => handleRemoveOwner(owner.id)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              </div>

              {expandedOwner === owner.id && loadingOwnerDecks && (
                <div className="settings-tracker-browse">
                  <Skeleton lines={4} />
                </div>
              )}

              {expandedOwner === owner.id && !loadingOwnerDecks && (
                <div className="settings-tracker-browse">
                  {ownerDecks.length === 0 ? (
                    <p className="settings-tracker-browse-empty">No public decks found.</p>
                  ) : (
                    <ul className="settings-tracker-browse-list">
                      {ownerDecks.map(deck => (
                        <li key={deck.id} className="settings-tracker-browse-item">
                          <span className="settings-tracker-browse-name">{deck.name}</span>
                          {deck.tracked ? (
                            <span className="settings-tracker-browse-tracked">Tracking</span>
                          ) : (
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() => handleTrackDeck(owner.id, deck)}
                              type="button"
                            >
                              Track
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {trackedDecks.length > 0 && (
        <div className="settings-tracker-decks">
          <div className="settings-tracker-decks-header">
            <h4>Tracked Decks</h4>
            <div className="settings-tracker-decks-header-actions">
              <button
                className={`btn btn-secondary btn-sm${bulkMode ? ' btn--active' : ''}`}
                onClick={toggleBulkMode}
                type="button"
              >
                {bulkMode ? 'Cancel Select' : 'Select'}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleRefreshAll}
                disabled={refreshingAll}
                type="button"
              >
                {refreshingAll ? 'Refreshing...' : `Refresh All (${trackedDecks.length})`}
              </button>
            </div>
          </div>

          {/* Bulk action bar */}
          {bulkMode && (
            <div className="settings-tracker-bulk-bar">
              <div className="settings-tracker-bulk-bar-left">
                <button className="btn btn-secondary btn-sm" onClick={selectAllDecks} type="button">All</button>
                <button className="btn btn-secondary btn-sm" onClick={deselectAllDecks} type="button">None</button>
                <span className="settings-tracker-bulk-count">{selectedDecks.size} selected</span>
              </div>
              {selectedDecks.size > 0 && (
                <div className="settings-tracker-bulk-bar-right">
                  <button className="btn btn-primary btn-sm" onClick={handleBulkRefresh} type="button">
                    Refresh ({selectedDecks.size})
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={handleBulkExport} type="button">
                    Export ({selectedDecks.size})
                  </button>
                  <button className="btn btn-sm btn-ghost-danger" onClick={handleBulkUntrack} type="button">
                    Untrack ({selectedDecks.size})
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Search + tag filter */}
          {trackedDecks.length > 3 && (
            <div className="settings-tracker-filter-row">
              <div className="settings-tracker-search">
                <input
                  className="settings-tracker-search-input"
                  type="text"
                  placeholder="Filter decks..."
                  value={deckSearch}
                  onChange={e => setDeckSearch(e.target.value)}
                  aria-label="Filter tracked decks"
                />
                {deckSearch && (
                  <button
                    className="settings-tracker-search-clear"
                    onClick={() => setDeckSearch('')}
                    type="button"
                    aria-label="Clear search"
                  >
                    &times;
                  </button>
                )}
              </div>
              {allTags.length > 0 && (
                <select
                  className="settings-tracker-tag-filter"
                  value={tagFilter}
                  onChange={e => setTagFilter(e.target.value)}
                  aria-label="Filter by tag"
                >
                  <option value="">All tags</option>
                  {allTags.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
            </div>
          )}

          {/* Owner groups */}
          {filteredDecksByOwner.length === 0 && (deckSearch.trim() || tagFilter) && (
            <p className="settings-tracker-empty">No decks matching "{deckSearch}"</p>
          )}

          {filteredDecksByOwner.map(([ownerName, decks]) => {
            const isSearchActive = deckSearch.trim().length > 0;
            const isCollapsed = !isSearchActive && collapsedOwners.has(ownerName);

            return (
              <div key={ownerName} className="settings-tracker-owner-group">
                <div className="settings-tracker-owner-group-header-row">
                  {bulkMode && (
                    <input
                      type="checkbox"
                      className="settings-tracker-bulk-checkbox"
                      checked={decks.every(d => selectedDecks.has(d.id))}
                      onChange={() => toggleOwnerSelection(decks)}
                      onClick={e => e.stopPropagation()}
                    />
                  )}
                  <button
                    className="settings-tracker-owner-group-header"
                    onClick={() => toggleOwnerCollapse(ownerName)}
                    type="button"
                    aria-expanded={!isCollapsed}
                  >
                    <span className="settings-tracker-owner-group-arrow">{isCollapsed ? '\u25B6' : '\u25BC'}</span>
                    <span className="settings-tracker-owner-group-name">{ownerName}</span>
                    <span className="settings-tracker-owner-group-count">{decks.length}</span>
                  </button>
                </div>
                {!isCollapsed && (
                  <div className="deck-tracker-grid">
                    {decks.map(deck => (
                      <DeckGridCard
                        key={deck.id}
                        deck={deck}
                        bulkMode={bulkMode}
                        isSelected={selectedDecks.has(deck.id)}
                        onToggleSelect={toggleDeckSelection}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {owners.length === 0 && trackedDecks.length === 0 && (
        <p className="settings-tracker-empty">
          No tracked users yet. Enter an Archidekt username above to start tracking their decks.
        </p>
      )}
    </div>
  );
}

// --- Collection Manager ---

function CollectionManager({ confirm }) {
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState('');
  const [summary, setSummary] = useState({ uniqueCards: 0, totalCards: 0 });

  const refresh = useCallback(async () => {
    try {
      const [collectionData, summaryData] = await Promise.all([
        getCollection(),
        getCollectionSummary(),
      ]);
      setCards(collectionData.cards);
      setSummary(summaryData);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleImport() {
    if (!importText.trim()) return;
    setImporting(true);
    try {
      const data = await importCollection(importText);
      toast.success(`Imported ${data.imported} cards${data.skipped ? ` (${data.skipped} skipped)` : ''}`);
      setImportText('');
      refresh();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setImporting(false);
    }
  }

  async function handleDeleteCard(id) {
    try {
      await deleteCollectionCard(id);
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleUpdateQty(id, newQty) {
    try {
      await updateCollectionCard(id, newQty);
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleClear() {
    const ok = await confirm('Clear your entire collection? This cannot be undone.');
    if (!ok) return;
    try {
      await clearCollection();
      toast.success('Collection cleared');
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  }

  const filteredCards = useMemo(() => {
    if (!search.trim()) return cards;
    const lower = search.toLowerCase();
    return cards.filter(c => c.card_name.toLowerCase().includes(lower));
  }, [cards, search]);

  return (
    <div className="settings-collection">
      <h3>My Collection</h3>
      <p className="settings-collection-summary">
        {summary.uniqueCards} unique cards, {summary.totalCards} total
      </p>

      <div className="settings-collection-import">
        <h4>Import Cards</h4>
        <p className="settings-collection-hint">Paste a card list — same format as deck text (e.g. "4 Lightning Bolt (m10) [227]")</p>
        <textarea
          className="settings-collection-textarea"
          value={importText}
          onChange={e => setImportText(e.target.value)}
          placeholder={'4 Lightning Bolt\n2 Sol Ring (c21) [281]\n1 Nazgul (ltr) [551] *F*'}
          rows={5}
          disabled={importing}
        />
        <div className="settings-collection-import-actions">
          <button className="btn btn-primary btn-sm" onClick={handleImport} disabled={importing || !importText.trim()} type="button">
            {importing ? 'Importing...' : 'Import'}
          </button>
          {cards.length > 0 && (
            <button className="btn btn-sm btn-ghost-danger" onClick={handleClear} type="button">
              Clear All
            </button>
          )}
        </div>
      </div>

      {cards.length > 0 && (
        <>
          {cards.length > 10 && (
            <div className="settings-collection-search">
              <input
                type="text"
                placeholder="Search collection..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="settings-tracker-search-input"
              />
            </div>
          )}
          <div className="settings-collection-list">
            {loading ? <Skeleton lines={5} /> : (
              filteredCards.length === 0 ? (
                <p className="settings-tracker-empty">No cards matching "{search}"</p>
              ) : (
                <table className="settings-collection-table">
                  <thead>
                    <tr>
                      <th>Qty</th>
                      <th>Card Name</th>
                      <th>Set</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCards.map(card => (
                      <tr key={card.id}>
                        <td>
                          <input
                            type="number"
                            className="settings-collection-qty"
                            value={card.quantity}
                            min={0}
                            onChange={e => handleUpdateQty(card.id, parseInt(e.target.value, 10) || 0)}
                          />
                        </td>
                        <td>
                          {card.card_name}
                          {card.is_foil ? ' \u2726' : ''}
                        </td>
                        <td className="settings-collection-set">
                          {card.set_code ? `(${card.set_code.toUpperCase()})` : ''}
                          {card.collector_number ? ` #${card.collector_number}` : ''}
                        </td>
                        <td>
                          <button
                            className="btn btn-sm btn-ghost-danger"
                            onClick={() => handleDeleteCard(card.id)}
                            type="button"
                            title="Remove from collection"
                          >
                            &times;
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}

// --- Deck Overlap Analysis ---

function DeckOverlapAnalysis() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedPair, setSelectedPair] = useState(null);

  useEffect(() => {
    getDeckOverlap()
      .then(setData)
      .catch(err => toast.error(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Skeleton lines={6} />;
  if (!data || data.decks.length < 2) {
    return (
      <div className="settings-overlap">
        <h3>Deck Overlap</h3>
        <p className="settings-tracker-empty">Track at least 2 decks with snapshots to see overlap analysis.</p>
      </div>
    );
  }

  const { decks, sharedCards, matrix } = data;
  const totalShared = Object.keys(sharedCards).length;

  let pairCards = [];
  if (selectedPair) {
    const [a, b] = selectedPair;
    pairCards = Object.entries(sharedCards)
      .filter(([, idxs]) => idxs.includes(a) && idxs.includes(b))
      .map(([name]) => name)
      .sort();
  }

  return (
    <div className="settings-overlap">
      <h3>Deck Overlap</h3>
      <p className="settings-overlap-summary">
        {totalShared} card{totalShared !== 1 ? 's' : ''} shared across {decks.length} decks
      </p>

      <div className="settings-overlap-matrix-wrap">
        <table className="settings-overlap-matrix">
          <thead>
            <tr>
              <th></th>
              {decks.map((d, i) => (
                <th key={i} title={d.name}>
                  <span className="settings-overlap-col-label">{d.name.length > 12 ? d.name.slice(0, 11) + '\u2026' : d.name}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {decks.map((row, i) => (
              <tr key={i}>
                <td className="settings-overlap-row-label" title={row.name}>
                  {row.name.length > 16 ? row.name.slice(0, 15) + '\u2026' : row.name}
                  {row.commanders && <span className="settings-overlap-cmdr">{row.commanders}</span>}
                </td>
                {decks.map((_, j) => {
                  const val = matrix[i][j];
                  const isDiag = i === j;
                  const isSelected = selectedPair && ((selectedPair[0] === i && selectedPair[1] === j) || (selectedPair[0] === j && selectedPair[1] === i));
                  return (
                    <td
                      key={j}
                      className={`settings-overlap-cell${isDiag ? ' settings-overlap-cell--diag' : ''}${val > 0 && !isDiag ? ' settings-overlap-cell--shared' : ''}${isSelected ? ' settings-overlap-cell--selected' : ''}`}
                      onClick={!isDiag && val > 0 ? () => setSelectedPair(i < j ? [i, j] : [j, i]) : undefined}
                      title={isDiag ? `${val} total cards` : `${val} shared cards`}
                    >
                      {val}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedPair && pairCards.length > 0 && (
        <div className="settings-overlap-detail">
          <div className="settings-overlap-detail-header">
            <h4>{matrix[selectedPair[0]][selectedPair[1]]} shared cards: {decks[selectedPair[0]].name} & {decks[selectedPair[1]].name}</h4>
            <button className="btn btn-secondary btn-sm" onClick={() => setSelectedPair(null)} type="button">&times;</button>
          </div>
          <div className="settings-overlap-card-list">
            {pairCards.map(name => (
              <span key={name} className="settings-overlap-card">{name}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Notification History ---

function NotificationHistory() {
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 20;

  useEffect(() => {
    setLoading(true);
    getNotificationHistory(page, limit)
      .then(data => {
        setNotifications(data.notifications);
        setTotal(data.total);
      })
      .catch(() => toast.error('Failed to load notification history'))
      .finally(() => setLoading(false));
  }, [page]);

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso + 'Z').toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  }

  function formatDetails(n) {
    if (!n.details) return null;
    try {
      const d = typeof n.details === 'string' ? JSON.parse(n.details) : n.details;
      if (n.notification_type === 'deck_change') {
        const parts = [];
        if (d.added > 0) parts.push(`+${d.added} in`);
        if (d.removed > 0) parts.push(`-${d.removed} out`);
        if (d.changed > 0) parts.push(`~${d.changed} changed`);
        return parts.join(', ') || null;
      }
      if (n.notification_type === 'price_alert') {
        const delta = d.delta || 0;
        return `$${d.previousPrice?.toFixed(2)} → $${d.currentPrice?.toFixed(2)} (${delta > 0 ? '+' : ''}$${delta.toFixed(2)})`;
      }
      return null;
    } catch { return null; }
  }

  const totalPages = Math.ceil(total / limit);

  const typeLabels = {
    deck_change: 'Deck Change',
    price_alert: 'Price Alert',
  };

  const channelLabels = {
    email: 'Email',
    discord: 'Discord',
  };

  return (
    <div>
      <h3>Notification History</h3>
      <p className="settings-section-desc">
        Recent notifications sent for your tracked decks.
      </p>

      {loading ? (
        <Skeleton lines={5} />
      ) : notifications.length === 0 ? (
        <p className="settings-tracker-empty">No notifications sent yet.</p>
      ) : (
        <>
          <div className="notification-history-list">
            {notifications.map(n => (
              <div key={n.id} className="notification-history-item">
                <div className="notification-history-header">
                  <span className={`notification-history-type notification-history-type--${n.notification_type}`}>
                    {typeLabels[n.notification_type] || n.notification_type}
                  </span>
                  <span className={`notification-history-channel notification-history-channel--${n.channel}`}>
                    {channelLabels[n.channel] || n.channel}
                  </span>
                  <span className="notification-history-date">{formatDate(n.created_at)}</span>
                </div>
                <div className="notification-history-body">
                  {n.deck_name && <span className="notification-history-deck">{n.deck_name}</span>}
                  {n.subject && <span className="notification-history-subject">{n.subject}</span>}
                  {formatDetails(n) && (
                    <span className="notification-history-details">{formatDetails(n)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="notification-history-pagination">
              <button
                className="btn btn-secondary btn-sm"
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
                type="button"
              >
                Previous
              </button>
              <span className="notification-history-page">
                Page {page} of {totalPages}
              </span>
              <button
                className="btn btn-secondary btn-sm"
                disabled={page >= totalPages}
                onClick={() => setPage(p => p + 1)}
                type="button"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
