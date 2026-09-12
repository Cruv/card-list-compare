import { useState, useEffect, useCallback, useMemo } from 'react';
import { sourceBatchFeedback } from '../lib/sourceSync';
import { useConfirm } from './ConfirmModal';
import { toast } from './Toast';
import {
  getOwners, addOwner, removeOwner, getOwnerDecks,
  getTrackedDecks, trackDeck, untrackDeck, refreshDeck, refreshAllDecks,
  exportDecks,
  getDeckOverlap,
  getNotificationHistory,
} from '../lib/api';
import DeckGridCard from './DeckGridCard';
import useDeckArtwork, { deckCommanders } from '../hooks/useDeckArtwork';
import Icon from './Icon';
import Skeleton from './Skeleton';
import './UserSettings.css';
import './DeckLibrary.css';

export default function DeckLibrary() {
  const [confirm, ConfirmDialog] = useConfirm();
  const [activeTab, setActiveTab] = useState('deck-tracker');

  return (
    <div className="settings-page deck-library-page">
      <div className="user-settings">
        {ConfirmDialog}
        <div className="user-settings-header">
          <div><span className="deck-library-eyebrow">Your workspace</span><h1>Deck Library</h1>
            <p>Keep your decks, changes and paper copies together.</p></div>
          <a className="btn btn-primary" href="#compare"><Icon name="plus" size={18} /> Import a deck</a>
        </div>

        <nav className="user-settings-tabs" aria-label="Library sections">
          <button
            className={`user-settings-tab${activeTab === 'deck-tracker' ? ' user-settings-tab--active' : ''}`}
            onClick={() => setActiveTab('deck-tracker')}
            type="button"
          >
            Deck Tracker
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
  const [initialLoading, setInitialLoading] = useState(true);
  const [showSources, setShowSources] = useState(false);
  const coverFor = useDeckArtwork(trackedDecks);

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
      setError(null);
      setOwners(ownersData.owners);
      setTrackedDecks(decksData.decks);
    } catch {
      setError('Failed to load your decks. Please refresh to try again.');
      toast.error('Failed to load tracking data.');
    } finally { setInitialLoading(false); }
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
    const ids = trackedDecks.filter(deck => selectedDecks.has(deck.id) && deck.source_type !== 'manual').map(deck => deck.id);
    const results = [];
    for (const id of ids) {
      try {
        results.push(await refreshDeck(id));
      } catch {
        results.push({ error: true });
      }
    }
    const feedback = sourceBatchFeedback({ results });
    toast(feedback.message, feedback.tone);
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
      const feedback = sourceBatchFeedback(data);
      toast(feedback.message, feedback.tone, 5000);
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

      {initialLoading && <div className="deck-library-loading" role="status" aria-label="Loading decks"><Skeleton lines={8} /></div>}
      {trackedDecks.length > 0 && (
        <div className="settings-tracker-decks">
          <div className="settings-tracker-decks-header">
            <div><h2>Your decks <span className="deck-library-count">{trackedDecks.length}</span></h2><p className="deck-library-section-hint">Open a deck to review changes or prepare a print.</p></div>
            <div className="settings-tracker-decks-header-actions">
              <button
                className={`btn btn-secondary btn-sm${bulkMode ? ' btn--active' : ''}`}
                onClick={toggleBulkMode}
                type="button"
              >
                {bulkMode ? 'Done selecting' : 'Select decks'}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleRefreshAll}
                disabled={refreshingAll || trackedDecks.every(deck => deck.source_type === 'manual')}
                type="button"
              >
                <Icon name="refresh" size={16} /> {refreshingAll ? 'Refreshing...' : 'Refresh all'}
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
                  <button className="btn btn-primary btn-sm" onClick={handleBulkRefresh} disabled={!trackedDecks.some(deck => selectedDecks.has(deck.id) && deck.source_type !== 'manual')} type="button">
                    Refresh ({trackedDecks.filter(deck => selectedDecks.has(deck.id) && deck.source_type !== 'manual').length})
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
          {trackedDecks.length > 0 && (
            <div className="settings-tracker-filter-row">
              <div className="settings-tracker-search"><Icon name="search" size={18} />
                <input
                  className="settings-tracker-search-input"
                  type="text"
                  placeholder="Search decks or users…"
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
                      aria-label={`Select all decks by ${ownerName}`}
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
                        imageUri={coverFor(deckCommanders(deck)[0])}
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

      {!initialLoading && trackedDecks.length === 0 && <div className="deck-library-empty">
        <Icon name="library" size={42} /><h2>Your next deck starts here</h2>
        <p>Import a list on Compare, or track an Archidekt user to follow their decks.</p>
        <a className="btn btn-primary" href="#compare">Import a deck</a>
      </div>}
      {!initialLoading && <details className="deck-library-sources" open={showSources || trackedDecks.length === 0}
        onToggle={event => setShowSources(event.currentTarget.open)}>
        <summary><Icon name="plus" size={18} /><span>Track decks & manage sources</span><span className="deck-library-source-count">{owners.length} user{owners.length === 1 ? '' : 's'}</span></summary>
        <div className="deck-library-sources-body"><p>Follow an Archidekt user, then choose the decks to track.</p>
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

        </div>
      </details>}
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
