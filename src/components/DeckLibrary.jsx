import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useAppSettings } from '../context/AppSettingsContext';
import { useConfirm } from './ConfirmModal';
import { toast } from './Toast';
import {
  getOwners, addOwner, removeOwner, getOwnerDecks,
  getTrackedDecks, trackDeck, untrackDeck, refreshDeck, refreshAllDecks,
  getDeckSnapshots, deleteSnapshot as apiDeleteSnapshot, renameSnapshot,
  getDeckChangelog, updateDeckCommanders, updateDeckNotify,
  lockSnapshot, unlockSnapshot, setPaperSnapshot, clearPaperSnapshot,
  getDeckTimeline, exportDecks, getSnapshot,
  shareDeck, unshareDeck,
  updateDeckNotes, updateDeckPinned, updateDeckTags,
  updateDeckDiscordWebhook,
  getCollection, importCollection, updateCollectionCard, deleteCollectionCard, clearCollection, getCollectionSummary,
  getDeckOverlap, getDeckPrices, updateDeckPriceAlert, updateDeckAutoRefresh,
  getNotificationHistory,
} from '../lib/api';
import { parse } from '../lib/parser';
import { formatDeckForMpc } from '../lib/formatter';
import CopyButton from './CopyButton';
import Skeleton from './Skeleton';
import TimelineOverlay from './TimelineOverlay';
import RecommendationsOverlay from './RecommendationsOverlay';
import ComparisonOverlay from './ComparisonOverlay';
import MpcOverlay from './MpcOverlay';
import PriceHistoryOverlay from './PriceHistoryOverlay';
import './UserSettings.css';
import './DeckLibrary.css';

export default function DeckLibrary() {
  const { user } = useAuth();
  const [confirm, ConfirmDialog] = useConfirm();
  const [activeTab, setActiveTab] = useState('deck-tracker');

  return (
    <div className="settings-page">
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

  // Per-deck expanded snapshots
  const [expandedDeckId, setExpandedDeckId] = useState(null);
  const [deckSnapshots, setDeckSnapshots] = useState([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [editingNickname, setEditingNickname] = useState(null);
  const [nicknameValue, setNicknameValue] = useState('');
  const [refreshingDeck, setRefreshingDeck] = useState(null);

  // Commander editing state
  const [editingCommanderDeckId, setEditingCommanderDeckId] = useState(null);
  const [commanderValue, setCommanderValue] = useState('');
  const [savingCommander, setSavingCommander] = useState(false);

  // Compare mode state (snapshot comparison within a deck)
  const [compareMode, setCompareMode] = useState(false);
  const [compareA, setCompareA] = useState('');
  const [compareB, setCompareB] = useState('');
  const [changelogDeckId, setChangelogDeckId] = useState(null);

  // ComparisonOverlay state
  const [comparisonOverlay, setComparisonOverlay] = useState(null);

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

  function toggleOwnerCollapse(owner) {
    setCollapsedOwners(prev => {
      const next = new Set(prev);
      if (next.has(owner)) next.delete(owner);
      else next.add(owner);
      return next;
    });
  }

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
          toast('No commander detected — click the pencil icon to set one.', 'info', 5000);
        }
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSaveCommanders(deckId) {
    setSavingCommander(true);
    try {
      const commanders = commanderValue
        .split(',')
        .map(c => c.trim())
        .filter(Boolean);
      await updateDeckCommanders(deckId, commanders);
      toast.success(commanders.length > 0 ? 'Commanders updated' : 'Commanders cleared');
      setEditingCommanderDeckId(null);
      setCommanderValue('');
      await refresh();
    } catch (err) {
      toast.error(err.message || 'Failed to update commanders');
    } finally {
      setSavingCommander(false);
    }
  }

  async function handleUntrackDeck(id) {
    const deck = trackedDecks.find(d => d.id === id);
    const confirmed = await confirm({
      title: 'Untrack this deck?',
      message: `All snapshots for "${deck?.deck_name || 'this deck'}" will be permanently deleted.`,
      confirmLabel: 'Untrack',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await untrackDeck(id);
      toast.success('Deck untracked');
      if (expandedDeckId === id) {
        setExpandedDeckId(null);
        setDeckSnapshots([]);
      }
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRefreshDeck(id) {
    setRefreshingDeck(id);
    try {
      const result = await refreshDeck(id);
      const msg = result.changed ? 'New snapshot saved!' : 'No changes detected.';
      toast(msg, result.changed ? 'success' : 'info');
      if (expandedDeckId === id) {
        const data = await getDeckSnapshots(id);
        setDeckSnapshots(data.snapshots);
      }
      await refresh();
    } catch (err) {
      toast.error(err.message || 'Refresh failed');
    } finally {
      setRefreshingDeck(null);
    }
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

  async function handleViewChangelog(deckId) {
    // Open ComparisonOverlay with latest changelog (no specific snapshot IDs)
    const deck = trackedDecks.find(d => d.id === deckId);
    let commanders = [];
    try { commanders = JSON.parse(deck?.commanders || '[]'); } catch { /* ignore */ }
    setComparisonOverlay({
      beforeDeckId: deckId,
      afterDeckId: deckId,
      deckName: deck?.deck_name || 'Deck',
      commanders,
    });
  }

  // Bulk operations
  function toggleBulkMode() {
    setBulkMode(!bulkMode);
    setSelectedDecks(new Set());
  }

  function toggleDeckSelection(deckId) {
    setSelectedDecks(prev => {
      const next = new Set(prev);
      if (next.has(deckId)) next.delete(deckId);
      else next.add(deckId);
      return next;
    });
  }

  function toggleOwnerSelection(ownerDecks) {
    const allSelected = ownerDecks.every(d => selectedDecks.has(d.id));
    setSelectedDecks(prev => {
      const next = new Set(prev);
      for (const d of ownerDecks) {
        if (allSelected) next.delete(d.id);
        else next.add(d.id);
      }
      return next;
    });
  }

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

  // Share
  async function handleShareDeck(deckId) {
    try {
      const data = await shareDeck(deckId);
      const url = `${window.location.origin}${window.location.pathname}#deck/${data.shareId}`;
      await navigator.clipboard.writeText(url);
      toast.success('Share link copied to clipboard');
      await refresh();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleUnshareDeck(deckId) {
    try {
      await unshareDeck(deckId);
      toast.success('Deck is no longer shared');
      await refresh();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleCompareSnapshots(deckId) {
    if (!compareA || !compareB) return;
    const deck = trackedDecks.find(d => d.id === deckId);
    let commanders = [];
    try { commanders = JSON.parse(deck?.commanders || '[]'); } catch { /* ignore */ }
    setComparisonOverlay({
      beforeDeckId: deckId,
      afterDeckId: deckId,
      beforeSnapshotId: compareA,
      afterSnapshotId: compareB,
      deckName: deck?.deck_name || 'Deck',
      commanders,
    });
  }

  async function handleExpandDeckSnapshots(deckId) {
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
      toast.error('Failed to load snapshots');
    } finally {
      setSnapshotsLoading(false);
    }
  }

  async function handleDeleteSnapshot(deckId, snapshotId) {
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
      await refresh();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleToggleLock(deckId, snapshotId, isLocked) {
    try {
      if (isLocked) {
        const deck = trackedDecks.find(d => d.id === deckId);
        if (deck?.paper_snapshot_id === snapshotId) {
          toast('Warning: unlocking your paper snapshot may allow it to be auto-pruned', 'info', 5000);
        }
        await unlockSnapshot(deckId, snapshotId);
        toast.success('Snapshot unlocked');
      } else {
        await lockSnapshot(deckId, snapshotId);
        toast.success('Snapshot locked — it will be protected from auto-pruning');
      }
      const data = await getDeckSnapshots(deckId);
      setDeckSnapshots(data.snapshots);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleTogglePaper(deckId, snapshotId, isPaper) {
    try {
      if (isPaper) {
        await clearPaperSnapshot(deckId);
        toast.success('Paper marker removed');
      } else {
        const result = await setPaperSnapshot(deckId, snapshotId);
        if (result.autoLocked) {
          toast.success('Marked as paper deck (auto-locked to prevent pruning)');
        } else {
          toast.success('Marked as paper deck');
        }
      }
      await refresh();
      if (expandedDeckId === deckId) {
        const data = await getDeckSnapshots(deckId);
        setDeckSnapshots(data.snapshots);
      }
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleCompareToPaper(deckId) {
    const deck = trackedDecks.find(d => d.id === deckId);
    if (!deck?.paper_snapshot_id) return;

    let commanders = [];
    try { commanders = JSON.parse(deck.commanders || '[]'); } catch { /* ignore */ }

    // Get latest snapshot ID
    let latestId;
    if (expandedDeckId === deckId && deckSnapshots.length > 0) {
      latestId = deckSnapshots[0].id; // snapshots are ordered DESC
    } else {
      try {
        const data = await getDeckSnapshots(deckId);
        if (data.snapshots.length === 0) {
          toast.error('No snapshots available');
          return;
        }
        latestId = data.snapshots[0].id;
      } catch (err) {
        toast.error(err.message || 'Failed to load snapshots');
        return;
      }
    }

    if (latestId === deck.paper_snapshot_id) {
      toast('Paper version is already the latest snapshot — no changes to swap', 'info');
      return;
    }

    setComparisonOverlay({
      beforeDeckId: deckId,
      afterDeckId: deckId,
      beforeSnapshotId: deck.paper_snapshot_id,
      afterSnapshotId: latestId,
      deckName: `${deck.deck_name} — Paper vs. Latest`,
      commanders,
    });
  }

  async function handleSaveNickname(deckId, snapshotId) {
    try {
      await renameSnapshot(deckId, snapshotId, nicknameValue || null);
      setEditingNickname(null);
      const data = await getDeckSnapshots(deckId);
      setDeckSnapshots(data.snapshots);
    } catch (err) {
      toast.error(err.message);
    }
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso + 'Z').toLocaleString();
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
                  <div className="settings-tracker-owner-group-decks">
                    {decks.map(deck => {
                      let deckCommanders = [];
                      try { deckCommanders = JSON.parse(deck.commanders || '[]'); } catch { /* ignore */ }

                      return (
                        <DeckCard
                          key={deck.id}
                          deck={deck}
                          deckCommanders={deckCommanders}
                          expandedDeckId={expandedDeckId}
                          handleExpandDeckSnapshots={handleExpandDeckSnapshots}
                          handleRefreshDeck={handleRefreshDeck}
                          refreshingDeck={refreshingDeck}
                          handleUntrackDeck={handleUntrackDeck}
                          editingCommanderDeckId={editingCommanderDeckId}
                          setEditingCommanderDeckId={setEditingCommanderDeckId}
                          commanderValue={commanderValue}
                          setCommanderValue={setCommanderValue}
                          handleSaveCommanders={handleSaveCommanders}
                          savingCommander={savingCommander}
                          handleViewChangelog={handleViewChangelog}
                          compareMode={compareMode}
                          setCompareMode={setCompareMode}
                          changelogDeckId={changelogDeckId}
                          setChangelogDeckId={setChangelogDeckId}
                          compareA={compareA}
                          setCompareA={setCompareA}
                          compareB={compareB}
                          setCompareB={setCompareB}
                          handleCompareSnapshots={handleCompareSnapshots}
                          deckSnapshots={deckSnapshots}
                          snapshotsLoading={snapshotsLoading}
                          editingNickname={editingNickname}
                          setEditingNickname={setEditingNickname}
                          nicknameValue={nicknameValue}
                          setNicknameValue={setNicknameValue}
                          handleSaveNickname={handleSaveNickname}
                          handleDeleteSnapshot={handleDeleteSnapshot}
                          handleToggleLock={handleToggleLock}
                          formatDate={formatDate}
                          bulkMode={bulkMode}
                          isSelected={selectedDecks.has(deck.id)}
                          onToggleSelect={() => toggleDeckSelection(deck.id)}
                          handleShareDeck={handleShareDeck}
                          handleUnshareDeck={handleUnshareDeck}
                          handleRefreshTrackedDecks={refresh}
                        />
                      );
                    })}
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

      {comparisonOverlay && (
        <ComparisonOverlay
          beforeDeckId={comparisonOverlay.beforeDeckId}
          afterDeckId={comparisonOverlay.afterDeckId}
          beforeSnapshotId={comparisonOverlay.beforeSnapshotId}
          afterSnapshotId={comparisonOverlay.afterSnapshotId}
          deckName={comparisonOverlay.deckName}
          commanders={comparisonOverlay.commanders}
          onClose={() => setComparisonOverlay(null)}
        />
      )}
    </div>
  );
}

// --- Deck Card (extracted for owner-group rendering) ---

function DeckCard({
  deck, deckCommanders,
  expandedDeckId, handleExpandDeckSnapshots,
  handleRefreshDeck, refreshingDeck,
  handleUntrackDeck,
  editingCommanderDeckId, setEditingCommanderDeckId,
  commanderValue, setCommanderValue,
  handleSaveCommanders, savingCommander,
  handleViewChangelog,
  compareMode, setCompareMode,
  changelogDeckId, setChangelogDeckId,
  compareA, setCompareA,
  compareB, setCompareB,
  handleCompareSnapshots,
  deckSnapshots, snapshotsLoading,
  editingNickname, setEditingNickname,
  nicknameValue, setNicknameValue,
  handleSaveNickname,
  handleDeleteSnapshot,
  handleToggleLock,
  formatDate,
  bulkMode, isSelected, onToggleSelect,
  handleShareDeck, handleUnshareDeck,
  handleRefreshTrackedDecks,
}) {
  const { priceDisplayEnabled } = useAppSettings();
  const [timelineData, setTimelineData] = useState(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [overlayEntry, setOverlayEntry] = useState(null);
  const [showRecommendations, setShowRecommendations] = useState(false);
  const [showMpc, setShowMpc] = useState(false);
  const [mpcCards, setMpcCards] = useState(null);
  const [showPriceHistory, setShowPriceHistory] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Notes editing state
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState(deck.notes || '');
  const [savingNotes, setSavingNotes] = useState(false);

  // Tag editing state
  const [editingTags, setEditingTags] = useState(false);
  const [tagInput, setTagInput] = useState('');

  // Discord webhook state
  const [editingWebhook, setEditingWebhook] = useState(false);
  const [webhookValue, setWebhookValue] = useState(deck.discord_webhook_url || '');
  const [savingWebhook, setSavingWebhook] = useState(false);

  // Price alert state
  const [editingPriceAlert, setEditingPriceAlert] = useState(false);
  const [priceAlertValue, setPriceAlertValue] = useState(deck.price_alert_threshold ?? '');
  const [priceAlertMode, setPriceAlertMode] = useState(deck.price_alert_mode || 'specific');
  const [savingPriceAlert, setSavingPriceAlert] = useState(false);
  const [priceData, setPriceData] = useState(null);
  const [loadingPrices, setLoadingPrices] = useState(false);

  async function handleSaveNotes() {
    setSavingNotes(true);
    try {
      await updateDeckNotes(deck.id, notesValue.trim() || null);
      toast.success('Notes saved');
      setEditingNotes(false);
      if (typeof handleRefreshTrackedDecks === 'function') handleRefreshTrackedDecks();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingNotes(false);
    }
  }

  async function handleSaveWebhook() {
    setSavingWebhook(true);
    try {
      await updateDeckDiscordWebhook(deck.id, webhookValue.trim() || null);
      toast.success(webhookValue.trim() ? 'Discord webhook saved' : 'Discord webhook removed');
      setEditingWebhook(false);
      if (typeof handleRefreshTrackedDecks === 'function') handleRefreshTrackedDecks();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingWebhook(false);
    }
  }

  async function handleSavePriceAlert() {
    setSavingPriceAlert(true);
    try {
      const threshold = priceAlertValue === '' ? null : parseFloat(priceAlertValue);
      await updateDeckPriceAlert(deck.id, threshold, priceAlertMode);
      toast.success(threshold ? `Price alert set at $${threshold} (${priceAlertMode} printing)` : 'Price alert removed');
      setEditingPriceAlert(false);
      if (typeof handleRefreshTrackedDecks === 'function') handleRefreshTrackedDecks();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingPriceAlert(false);
    }
  }

  async function handleCheckPrices() {
    setLoadingPrices(true);
    try {
      const data = await getDeckPrices(deck.id);
      setPriceData(data);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoadingPrices(false);
    }
  }

  async function handleTogglePin() {
    try {
      await updateDeckPinned(deck.id, !deck.pinned);
      toast.success(deck.pinned ? 'Unpinned' : 'Pinned to top');
      if (typeof handleRefreshTrackedDecks === 'function') handleRefreshTrackedDecks();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handlePrintProxies() {
    try {
      const snapData = await getDeckSnapshots(deck.id);
      if (!snapData.snapshots || snapData.snapshots.length === 0) {
        toast.error('No snapshots available. Refresh the deck first.');
        return;
      }
      const latestSnap = snapData.snapshots[0];
      const snapshotDetail = await getSnapshot(deck.id, latestSnap.id);
      const parsed = parse(snapshotDetail.snapshot.deck_text);
      const cards = formatDeckForMpc(parsed);
      if (cards.length === 0) {
        toast.error('No cards found in the deck.');
        return;
      }
      setMpcCards(cards);
      setShowMpc(true);
    } catch (err) {
      toast.error('Failed to load deck for proxy printing');
    }
  }

  async function handleAddTag(tag) {
    const trimmed = tag.trim().toLowerCase();
    if (!trimmed) return;
    const currentTags = deck.tags || [];
    if (currentTags.includes(trimmed)) return;
    try {
      await updateDeckTags(deck.id, [...currentTags, trimmed]);
      setTagInput('');
      if (typeof handleRefreshTrackedDecks === 'function') handleRefreshTrackedDecks();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleRemoveTag(tag) {
    const currentTags = deck.tags || [];
    try {
      await updateDeckTags(deck.id, currentTags.filter(t => t !== tag));
      if (typeof handleRefreshTrackedDecks === 'function') handleRefreshTrackedDecks();
    } catch (err) {
      toast.error(err.message);
    }
  }

  function handleTimelineEntryClick(entry, index) {
    const prevId = index > 0 ? timelineData[index - 1].snapshotId : null;
    setOverlayEntry({ entry, prevSnapshotId: prevId });
  }

  async function handleShowTimeline() {
    if (showTimeline) { setShowTimeline(false); return; }
    setTimelineLoading(true);
    setShowTimeline(true);
    try {
      const data = await getDeckTimeline(deck.id);
      setTimelineData(data.entries);
    } catch {
      toast.error('Failed to load timeline');
      setShowTimeline(false);
    } finally {
      setTimelineLoading(false);
    }
  }

  return (
    <div className={`settings-tracker-deck${isSelected ? ' settings-tracker-deck--selected' : ''}${deck.pinned ? ' settings-tracker-deck--pinned' : ''}`}>
      <div className="settings-tracker-deck-header">
        {bulkMode && (
          <input
            type="checkbox"
            className="settings-tracker-bulk-checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
          />
        )}
        {!bulkMode && (
          <button
            className={`settings-tracker-pin-btn${deck.pinned ? ' settings-tracker-pin-btn--active' : ''}`}
            onClick={handleTogglePin}
            type="button"
            title={deck.pinned ? 'Unpin from top' : 'Pin to top'}
          >
            {'\u{1F4CC}'}
          </button>
        )}
        <button
          className="settings-tracker-deck-name"
          onClick={() => bulkMode ? onToggleSelect() : handleExpandDeckSnapshots(deck.id)}
          type="button"
          aria-expanded={expandedDeckId === deck.id}
        >
          {!bulkMode && (expandedDeckId === deck.id ? '\u25BC' : '\u25B6')} {deck.deck_name}
        </button>
        <span className="settings-tracker-deck-meta">
          {deck.snapshot_count} snapshot{deck.snapshot_count !== 1 ? 's' : ''}
          {deck.share_id && <span className="settings-tracker-shared-badge" title="Shared">Shared</span>}
          {priceDisplayEnabled && deck.last_known_price > 0 && (
            <span className="settings-tracker-price-badge">
              ${deck.last_known_price.toFixed(2)}
              {deck.last_known_budget_price != null && deck.last_known_budget_price > 0 && Math.abs(deck.last_known_budget_price - deck.last_known_price) >= 0.01 && (
                <span className="settings-tracker-budget-price">(${deck.last_known_budget_price.toFixed(2)})</span>
              )}
            </span>
          )}
          {deck.paper_snapshot_id && (
            <span className="settings-tracker-paper-badge-header" title="Paper deck marked">Paper</span>
          )}
        </span>
        {!bulkMode && (
          <div className="settings-tracker-deck-actions">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => handleRefreshDeck(deck.id)}
              disabled={refreshingDeck === deck.id}
              type="button"
            >
              {refreshingDeck === deck.id ? '...' : 'Refresh'}
            </button>
            <button
              className="btn btn-sm btn-ghost-danger"
              onClick={() => handleUntrackDeck(deck.id)}
              type="button"
            >
              Untrack
            </button>
          </div>
        )}
      </div>
      {/* Tags */}
      <div className="settings-tracker-deck-tags">
        {(deck.tags || []).map(tag => (
          <span key={tag} className="deck-tag">
            {tag}
            {editingTags && (
              <button className="deck-tag-remove" onClick={() => handleRemoveTag(tag)} type="button" title="Remove tag">&times;</button>
            )}
          </span>
        ))}
        {editingTags ? (
          <span className="deck-tag-input-wrap">
            <input
              className="deck-tag-input"
              type="text"
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); handleAddTag(tagInput); }
                if (e.key === 'Escape') setEditingTags(false);
              }}
              placeholder="Add tag..."
              autoFocus
            />
            <button className="btn btn-secondary btn-sm" onClick={() => setEditingTags(false)} type="button">Done</button>
          </span>
        ) : (
          <button className="deck-tag-edit-btn" onClick={() => setEditingTags(true)} type="button" title="Edit tags">+ tag</button>
        )}
      </div>
      <div className="settings-tracker-deck-commanders">
        {editingCommanderDeckId === deck.id ? (
          <div className="settings-tracker-commander-edit">
            <input
              type="text"
              value={commanderValue}
              onChange={e => setCommanderValue(e.target.value)}
              placeholder="Commander name(s), comma-separated"
              onKeyDown={e => {
                if (e.key === 'Enter') handleSaveCommanders(deck.id);
                if (e.key === 'Escape') setEditingCommanderDeckId(null);
              }}
              disabled={savingCommander}
              autoFocus
            />
            <button
              className="btn btn-primary btn-sm"
              onClick={() => handleSaveCommanders(deck.id)}
              disabled={savingCommander}
              type="button"
            >
              {savingCommander ? '...' : 'Save'}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setEditingCommanderDeckId(null)}
              type="button"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="settings-tracker-commander-display">
            {deckCommanders.length > 0 ? (
              <span className="settings-tracker-commander-names">
                {deckCommanders.join(' / ')}
              </span>
            ) : (
              <span className="settings-tracker-commander-warn">No commander set</span>
            )}
            <button
              className="settings-tracker-commander-edit-btn"
              onClick={() => {
                setEditingCommanderDeckId(deck.id);
                setCommanderValue(deckCommanders.join(', '));
              }}
              type="button"
              title="Edit commander(s)"
            >
              &#9998;
            </button>
          </div>
        )}
      </div>

      {/* Notes */}
      {(deck.notes || editingNotes) && (
        <div className="settings-tracker-deck-notes">
          {editingNotes ? (
            <div className="settings-tracker-notes-edit">
              <textarea
                className="settings-tracker-notes-textarea"
                value={notesValue}
                onChange={e => setNotesValue(e.target.value)}
                placeholder="Deck notes..."
                rows={3}
                maxLength={2000}
                disabled={savingNotes}
              />
              <div className="settings-tracker-notes-actions">
                <button className="btn btn-primary btn-sm" onClick={handleSaveNotes} disabled={savingNotes} type="button">
                  {savingNotes ? '...' : 'Save'}
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => { setEditingNotes(false); setNotesValue(deck.notes || ''); }} type="button">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div
              className="settings-tracker-notes-display"
              onClick={() => { setEditingNotes(true); setNotesValue(deck.notes || ''); }}
              title="Click to edit notes"
              role="button"
              tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter') { setEditingNotes(true); setNotesValue(deck.notes || ''); } }}
            >
              {deck.notes}
            </div>
          )}
        </div>
      )}

      {expandedDeckId === deck.id && (
        <div className="settings-tracker-snapshots">
          <div className="settings-tracker-changelog-actions">
            <button className="btn btn-primary btn-sm" onClick={() => handleViewChangelog(deck.id)} type="button">
              View Changelog
            </button>
            {deck.paper_snapshot_id && (
              <button className="btn btn-primary btn-sm" onClick={() => handleCompareToPaper(deck.id)} type="button">
                Paper vs. Latest
              </button>
            )}
            <button
              className={`btn btn-secondary btn-sm${showTimeline ? ' btn--active' : ''}`}
              onClick={handleShowTimeline}
              type="button"
            >
              {timelineLoading ? '...' : 'Timeline'}
            </button>
            <button
              className={`btn btn-secondary btn-sm${compareMode && changelogDeckId === deck.id ? ' btn--active' : ''}`}
              onClick={() => { setCompareMode(!compareMode); setChangelogDeckId(deck.id); setCompareA(''); setCompareB(''); }}
              type="button"
            >
              Compare
            </button>
            {deck.deck_url && (
              <a href={deck.deck_url} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm">
                Archidekt
              </a>
            )}
            <div className="settings-tracker-actions-menu">
              <button
                className={`btn btn-secondary btn-sm settings-tracker-menu-trigger${menuOpen ? ' btn--active' : ''}`}
                onClick={() => setMenuOpen(!menuOpen)}
                type="button"
                aria-label="More actions"
                aria-expanded={menuOpen}
              >
                &#x22EE;
              </button>
              {menuOpen && (
                <>
                  <div className="settings-tracker-menu-backdrop" onClick={() => setMenuOpen(false)} />
                  <div className="settings-tracker-dropdown">
                    <button
                      className="settings-tracker-dropdown-item"
                      onClick={() => { deck.share_id ? handleUnshareDeck(deck.id) : handleShareDeck(deck.id); setMenuOpen(false); }}
                      type="button"
                    >
                      {deck.share_id ? 'Unshare deck' : 'Share deck'}
                    </button>
                    <button
                      className={`settings-tracker-dropdown-item${deck.notify_on_change ? ' settings-tracker-dropdown-item--active' : ''}`}
                      onClick={async () => {
                        try {
                          await updateDeckNotify(deck.id, !deck.notify_on_change);
                          toast.success(deck.notify_on_change ? 'Notifications disabled' : 'Notifications enabled');
                          if (typeof handleRefreshTrackedDecks === 'function') handleRefreshTrackedDecks();
                        } catch (err) { toast.error(err.message); }
                        setMenuOpen(false);
                      }}
                      type="button"
                    >
                      {deck.notify_on_change ? 'Notifications: On' : 'Notifications: Off'}
                    </button>
                    <button
                      className="settings-tracker-dropdown-item"
                      onClick={() => { setEditingNotes(true); setNotesValue(deck.notes || ''); setMenuOpen(false); }}
                      type="button"
                    >
                      {deck.notes ? 'Edit notes' : 'Add notes'}
                    </button>
                    <button
                      className={`settings-tracker-dropdown-item${deck.discord_webhook_url ? ' settings-tracker-dropdown-item--active' : ''}`}
                      onClick={() => { setEditingWebhook(!editingWebhook); setWebhookValue(deck.discord_webhook_url || ''); setMenuOpen(false); }}
                      type="button"
                    >
                      {deck.discord_webhook_url ? 'Edit webhook' : 'Set up webhook'}
                    </button>
                    <button
                      className={`settings-tracker-dropdown-item${deck.price_alert_threshold ? ' settings-tracker-dropdown-item--active' : ''}`}
                      onClick={() => { setEditingPriceAlert(!editingPriceAlert); setPriceAlertValue(deck.price_alert_threshold ?? ''); setMenuOpen(false); }}
                      type="button"
                    >
                      {deck.price_alert_threshold ? `Price alert: $${deck.price_alert_threshold}` : 'Set price alert'}
                    </button>
                    <button
                      className="settings-tracker-dropdown-item"
                      onClick={() => { handleCheckPrices(); setMenuOpen(false); }}
                      disabled={loadingPrices}
                      type="button"
                    >
                      {loadingPrices ? 'Checking...' : 'Check prices'}
                    </button>
                    {priceDisplayEnabled && deck.last_known_price > 0 && (
                      <button
                        className="settings-tracker-dropdown-item"
                        onClick={() => { setShowPriceHistory(true); setMenuOpen(false); }}
                        type="button"
                      >
                        Price history
                      </button>
                    )}
                    <button
                      className="settings-tracker-dropdown-item"
                      onClick={() => { setShowRecommendations(true); setMenuOpen(false); }}
                      type="button"
                    >
                      Suggest cards
                    </button>
                    <button
                      className="settings-tracker-dropdown-item"
                      onClick={() => { handlePrintProxies(); setMenuOpen(false); }}
                      type="button"
                    >
                      Print proxies
                    </button>
                    <div className="settings-tracker-dropdown-divider" />
                    <select
                      className="settings-tracker-auto-refresh-select"
                      value={deck.auto_refresh_hours || ''}
                      onChange={async (e) => {
                        const val = e.target.value ? parseInt(e.target.value, 10) : null;
                        try {
                          await updateDeckAutoRefresh(deck.id, val);
                          toast.success(val ? `Auto-refresh set to every ${val}h` : 'Auto-refresh disabled');
                          if (typeof handleRefreshTrackedDecks === 'function') handleRefreshTrackedDecks();
                        } catch (err) { toast.error(err.message); }
                        setMenuOpen(false);
                      }}
                      title="Auto-refresh schedule"
                    >
                      <option value="">Auto-refresh: Off</option>
                      <option value="6">Auto-refresh: 6h</option>
                      <option value="12">Auto-refresh: 12h</option>
                      <option value="24">Auto-refresh: 24h</option>
                      <option value="48">Auto-refresh: 48h</option>
                      <option value="168">Auto-refresh: 7d</option>
                    </select>
                  </div>
                </>
              )}
            </div>
          </div>

          {editingWebhook && (
            <div className="settings-tracker-webhook-edit">
              <input
                type="url"
                className="settings-tracker-webhook-input"
                value={webhookValue}
                onChange={e => setWebhookValue(e.target.value)}
                placeholder="https://discord.com/api/webhooks/..."
                disabled={savingWebhook}
              />
              <div className="settings-tracker-webhook-actions">
                <button className="btn btn-primary btn-sm" onClick={handleSaveWebhook} disabled={savingWebhook} type="button">
                  {savingWebhook ? '...' : 'Save'}
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => setEditingWebhook(false)} type="button">
                  Cancel
                </button>
                {deck.discord_webhook_url && (
                  <button
                    className="btn btn-sm btn-ghost-danger"
                    onClick={() => { setWebhookValue(''); handleSaveWebhook(); }}
                    disabled={savingWebhook}
                    type="button"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          )}

          {editingPriceAlert && (
            <div className="settings-tracker-webhook-edit">
              <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', marginBottom: '4px', display: 'block' }}>
                Alert when total deck value changes by more than ($):
              </label>
              <input
                type="number"
                className="settings-tracker-webhook-input"
                value={priceAlertValue}
                onChange={e => setPriceAlertValue(e.target.value)}
                placeholder="e.g. 25"
                min="0"
                step="1"
                disabled={savingPriceAlert}
              />
              <div className="settings-tracker-price-alert-mode">
                <span className="settings-tracker-price-alert-mode-label">Alert based on:</span>
                <label className="settings-tracker-price-alert-mode-option">
                  <input
                    type="radio"
                    name={`priceAlertMode-${deck.id}`}
                    value="specific"
                    checked={priceAlertMode === 'specific'}
                    onChange={() => setPriceAlertMode('specific')}
                    disabled={savingPriceAlert}
                  />
                  Your printings
                </label>
                <label className="settings-tracker-price-alert-mode-option">
                  <input
                    type="radio"
                    name={`priceAlertMode-${deck.id}`}
                    value="cheapest"
                    checked={priceAlertMode === 'cheapest'}
                    onChange={() => setPriceAlertMode('cheapest')}
                    disabled={savingPriceAlert}
                  />
                  Cheapest printings
                </label>
              </div>
              <div className="settings-tracker-webhook-actions">
                <button className="btn btn-primary btn-sm" onClick={handleSavePriceAlert} disabled={savingPriceAlert} type="button">
                  {savingPriceAlert ? '...' : 'Save'}
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => setEditingPriceAlert(false)} type="button">
                  Cancel
                </button>
                {deck.price_alert_threshold && (
                  <button
                    className="btn btn-sm btn-ghost-danger"
                    onClick={() => { setPriceAlertValue(''); handleSavePriceAlert(); }}
                    disabled={savingPriceAlert}
                    type="button"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          )}

          {priceData && (
            <div className="settings-tracker-price-summary">
              <div className="settings-tracker-price-header">
                <span className="settings-tracker-price-total">
                  Total: ${priceData.totalPrice.toFixed(2)}
                  {priceData.budgetPrice != null && Math.abs(priceData.budgetPrice - priceData.totalPrice) >= 0.01 && (
                    <span className="settings-tracker-budget-price"> (Budget: ${priceData.budgetPrice.toFixed(2)})</span>
                  )}
                </span>
                {priceData.previousPrice != null && priceData.previousPrice !== priceData.totalPrice && (
                  <span className={`settings-tracker-price-delta ${priceData.totalPrice > priceData.previousPrice ? 'delta-add' : 'delta-remove'}`}>
                    {priceData.totalPrice > priceData.previousPrice ? '+' : ''}${(priceData.totalPrice - priceData.previousPrice).toFixed(2)}
                  </span>
                )}
                <button className="btn btn-secondary btn-sm" onClick={() => setPriceData(null)} type="button">&times;</button>
              </div>
              {priceData.budgetPrice != null && priceData.totalPrice > priceData.budgetPrice + 0.01 && (
                <div className="settings-tracker-price-savings">
                  Savings with cheapest printings: <strong>${(priceData.totalPrice - priceData.budgetPrice).toFixed(2)}</strong>
                </div>
              )}
              {priceData.cards.length > 0 && (
                <div className="settings-tracker-price-cards">
                  {priceData.cards.slice(0, 10).map((c, i) => (
                    <span key={i} className="settings-tracker-price-card">
                      {c.quantity > 1 ? `${c.quantity}x ` : ''}{c.name} — ${c.total.toFixed(2)}
                      {c.cheapestTotal != null && Math.abs(c.cheapestTotal - c.total) >= 0.01 && (
                        <span className="settings-tracker-budget-price"> (${c.cheapestTotal.toFixed(2)})</span>
                      )}
                    </span>
                  ))}
                  {priceData.cards.length > 10 && (
                    <span className="settings-tracker-price-card settings-tracker-price-more">
                      +{priceData.cards.length - 10} more cards
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {showTimeline && (
            <SnapshotTimeline entries={timelineData} loading={timelineLoading} onEntryClick={handleTimelineEntryClick} paperSnapshotId={deck.paper_snapshot_id} />
          )}

          {overlayEntry && (
            <TimelineOverlay
              deckId={deck.id}
              entry={overlayEntry.entry}
              prevSnapshotId={overlayEntry.prevSnapshotId}
              deckName={deck.deck_name}
              commanders={deckCommanders}
              onClose={() => setOverlayEntry(null)}
            />
          )}

          {showRecommendations && (
            <RecommendationsOverlay
              deckId={deck.id}
              deckName={deck.deck_name}
              onClose={() => setShowRecommendations(false)}
            />
          )}

          {showMpc && mpcCards && (
            <MpcOverlay
              cards={mpcCards}
              deckName={deck.deck_name}
              deckId={deck.id}
              onClose={() => { setShowMpc(false); setMpcCards(null); }}
            />
          )}

          {showPriceHistory && (
            <PriceHistoryOverlay
              deckId={deck.id}
              deckName={deck.deck_name}
              onClose={() => setShowPriceHistory(false)}
            />
          )}

          {compareMode && changelogDeckId === deck.id && (
            <div className="settings-tracker-compare">
              <select value={compareA} onChange={e => setCompareA(e.target.value)} aria-label="Select older snapshot">
                <option value="">Before (older)...</option>
                {deckSnapshots.map(s => (
                  <option key={s.id} value={s.id}>{s.nickname ? `${s.nickname} (${formatDate(s.created_at)})` : formatDate(s.created_at)}</option>
                ))}
              </select>
              <select value={compareB} onChange={e => setCompareB(e.target.value)} aria-label="Select newer snapshot">
                <option value="">After (newer)...</option>
                {deckSnapshots.map(s => (
                  <option key={s.id} value={s.id}>{s.nickname ? `${s.nickname} (${formatDate(s.created_at)})` : formatDate(s.created_at)}</option>
                ))}
              </select>
              <button className="btn btn-primary btn-sm" onClick={() => handleCompareSnapshots(deck.id)} disabled={!compareA || !compareB} type="button">
                Compare
              </button>
            </div>
          )}

          {snapshotsLoading ? (
            <Skeleton lines={3} />
          ) : deckSnapshots.length === 0 ? (
            <p className="settings-tracker-empty">No snapshots yet. Click Refresh to fetch the current list.</p>
          ) : (
            <ul className="settings-tracker-snap-list">
              {deckSnapshots.map(snap => (
                <li key={snap.id} className={`settings-tracker-snap${snap.locked ? ' settings-tracker-snap--locked' : ''}${deck.paper_snapshot_id === snap.id ? ' settings-tracker-snap--paper' : ''}`}>
                  <div className="settings-tracker-snap-info">
                    {editingNickname === snap.id ? (
                      <span className="settings-tracker-snap-edit">
                        <input
                          type="text"
                          value={nicknameValue}
                          onChange={e => setNicknameValue(e.target.value)}
                          placeholder="Nickname (optional)"
                          onKeyDown={e => {
                            if (e.key === 'Enter') handleSaveNickname(deck.id, snap.id);
                            if (e.key === 'Escape') setEditingNickname(null);
                          }}
                          autoFocus
                        />
                        <button className="btn btn-primary btn-sm" onClick={() => handleSaveNickname(deck.id, snap.id)} type="button">Save</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => setEditingNickname(null)} type="button">Cancel</button>
                      </span>
                    ) : (
                      <>
                        <span className="settings-tracker-snap-date">{formatDate(snap.created_at)}</span>
                        {snap.nickname && <span className="settings-tracker-snap-nick">{snap.nickname}</span>}
                        {deck.paper_snapshot_id === snap.id && (
                          <span className="settings-tracker-snap-paper-badge" title="Paper deck">Paper</span>
                        )}
                      </>
                    )}
                  </div>
                  <div className="settings-tracker-snap-actions">
                    <button
                      className="settings-tracker-lock-btn"
                      onClick={() => handleToggleLock(deck.id, snap.id, !!snap.locked)}
                      type="button"
                      title={snap.locked ? 'Unlock snapshot (allow auto-pruning)' : 'Lock snapshot (prevent auto-pruning)'}
                    >
                      {snap.locked ? '\uD83D\uDD12' : '\uD83D\uDD13'}
                    </button>
                    <button
                      className={`settings-tracker-paper-btn${deck.paper_snapshot_id === snap.id ? ' settings-tracker-paper-btn--active' : ''}`}
                      onClick={() => handleTogglePaper(deck.id, snap.id, deck.paper_snapshot_id === snap.id)}
                      type="button"
                      title={deck.paper_snapshot_id === snap.id ? 'Remove paper marker' : 'Mark as paper deck'}
                    >
                      {'\uD83D\uDCCB'}
                    </button>
                    <button
                      className="settings-tracker-snap-icon-btn"
                      onClick={() => { setEditingNickname(snap.id); setNicknameValue(snap.nickname || ''); }}
                      type="button"
                      title={snap.nickname ? 'Edit nickname' : 'Add nickname'}
                    >
                      &#9998;
                    </button>
                    <button
                      className="settings-tracker-snap-icon-btn settings-tracker-snap-icon-btn--delete"
                      onClick={() => handleDeleteSnapshot(deck.id, snap.id)}
                      type="button"
                      disabled={!!snap.locked}
                      title={snap.locked ? 'Unlock to delete' : 'Delete snapshot'}
                    >
                      &#10005;
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
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

  // Build sorted shared card list for a selected pair
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

// Playgroups removed — future TapTogether integration planned

// --- Snapshot Timeline ---

function SnapshotTimeline({ entries, loading, onEntryClick, paperSnapshotId }) {
  if (loading) return <Skeleton lines={4} />;
  if (!entries || entries.length === 0) return <p className="settings-tracker-empty">No snapshots to show.</p>;

  function formatTimelineDate(iso) {
    if (!iso) return '';
    return new Date(iso + 'Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Display newest first, but keep original indices for prev-snapshot lookup
  const displayed = entries.map((entry, originalIndex) => ({ entry, originalIndex })).reverse();

  return (
    <div className="settings-timeline">
      {displayed.map(({ entry, originalIndex }, i) => (
        <div
          key={entry.snapshotId}
          className={`settings-timeline-entry${onEntryClick ? ' settings-timeline-entry--clickable' : ''}`}
          onClick={onEntryClick ? () => onEntryClick(entry, originalIndex) : undefined}
          role={onEntryClick ? 'button' : undefined}
          tabIndex={onEntryClick ? 0 : undefined}
          onKeyDown={onEntryClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEntryClick(entry, originalIndex); } } : undefined}
        >
          <div className="settings-timeline-left">
            <div className={`settings-timeline-dot${paperSnapshotId === entry.snapshotId ? ' settings-timeline-dot--paper' : ''}`} />
            {i < displayed.length - 1 && <div className="settings-timeline-line" />}
          </div>
          <div className="settings-timeline-content">
            <div className="settings-timeline-info">
              <span className="settings-timeline-date">{formatTimelineDate(entry.date)}</span>
              {entry.nickname && <span className="settings-timeline-nick">{entry.nickname}</span>}
              {entry.locked && <span className="settings-timeline-lock" title="Locked">{'\uD83D\uDD12'}</span>}
              {paperSnapshotId === entry.snapshotId && <span className="settings-timeline-paper" title="Paper deck">{'\uD83D\uDCCB'}</span>}
            </div>
            <div className="settings-timeline-stats">
              <span className="settings-timeline-card-count">{entry.cardCount} cards</span>
              {entry.delta && (
                <span className="settings-timeline-delta">
                  {entry.delta.added > 0 && <span className="delta-add">+{entry.delta.added}</span>}
                  {entry.delta.removed > 0 && <span className="delta-remove">-{entry.delta.removed}</span>}
                  {entry.delta.changed > 0 && <span className="delta-change">~{entry.delta.changed}</span>}
                  {entry.delta.added === 0 && entry.delta.removed === 0 && entry.delta.changed === 0 && (
                    <span className="delta-none">no changes</span>
                  )}
                </span>
              )}
              {!entry.delta && <span className="settings-timeline-baseline">baseline</span>}
            </div>
          </div>
        </div>
      ))}
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
