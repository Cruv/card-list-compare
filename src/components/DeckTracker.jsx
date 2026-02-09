import { useState, useEffect, useCallback } from 'react';
import {
  getOwners,
  addOwner,
  removeOwner,
  getOwnerDecks,
  getTrackedDecks,
  trackDeck,
  untrackDeck,
  refreshDeck,
  refreshAllDecks,
} from '../lib/api';
import TrackedDeckCard from './TrackedDeckCard';
import Skeleton from './Skeleton';
import { useConfirm } from './ConfirmModal';
import { toast } from './Toast';
import './DeckTracker.css';

export default function DeckTracker({ onLoadToCompare }) {
  const [owners, setOwners] = useState([]);
  const [trackedDecks, setTrackedDecks] = useState([]);
  const [newOwner, setNewOwner] = useState('');
  const [expandedOwner, setExpandedOwner] = useState(null);
  const [ownerDecks, setOwnerDecks] = useState([]);
  const [loadingOwnerDecks, setLoadingOwnerDecks] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [confirm, ConfirmDialog] = useConfirm();

  const refresh = useCallback(async () => {
    try {
      const [ownersData, decksData] = await Promise.all([getOwners(), getTrackedDecks()]);
      setOwners(ownersData.owners);
      setTrackedDecks(decksData.decks);
    } catch {
      toast.error('Failed to load tracking data. Check your connection.');
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
      await trackDeck(ownerId, deck.id, deck.name, deck.url);
      toast.success(`Now tracking "${deck.name}"`);
      // Refresh the browse list to update tracked status
      const data = await getOwnerDecks(ownerId);
      setOwnerDecks(data.decks);
      await refresh();
    } catch (err) {
      setError(err.message);
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
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRefreshDeck(id) {
    try {
      const result = await refreshDeck(id);
      await refresh();
      return result;
    } catch (err) {
      setError(err.message);
      throw err;
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

  return (
    <div className="deck-tracker">
      {ConfirmDialog}
      <h2 className="deck-tracker-title">Deck Tracker</h2>
      <p className="deck-tracker-subtitle">
        Track Archidekt users and their decks to automatically build change history
      </p>

      {error && <div className="deck-tracker-error" role="alert">{error}</div>}

      <form className="deck-tracker-add" onSubmit={handleAddOwner}>
        <input
          type="text"
          placeholder="Archidekt username"
          value={newOwner}
          onChange={e => setNewOwner(e.target.value)}
          disabled={loading}
          aria-label="Archidekt username to track"
        />
        <button className="btn btn-primary" type="submit" disabled={loading || !newOwner.trim()}>
          {loading ? 'Adding...' : 'Track User'}
        </button>
      </form>

      {owners.length === 0 && trackedDecks.length === 0 && (
        <div className="deck-tracker-empty">
          <p className="deck-tracker-empty-title">No tracked users yet</p>
          <p className="deck-tracker-empty-hint">
            Enter an Archidekt username above to start tracking their decks.
            You can then select which decks to follow and build a snapshot history.
          </p>
        </div>
      )}

      {owners.length > 0 && (
        <div className="deck-tracker-owners">
          {owners.map(owner => (
            <div key={owner.id} className="deck-tracker-owner">
              <div className="deck-tracker-owner-header">
                <span className="deck-tracker-owner-name">{owner.archidekt_username}</span>
                <div className="deck-tracker-owner-actions">
                  <button
                    className={`btn btn-secondary btn-sm${expandedOwner === owner.id ? ' btn--active' : ''}`}
                    onClick={() => handleBrowseDecks(owner.id)}
                    type="button"
                    aria-expanded={expandedOwner === owner.id}
                  >
                    {loadingOwnerDecks && expandedOwner === owner.id ? 'Loading...' : 'Browse Decks'}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm btn-danger"
                    onClick={() => handleRemoveOwner(owner.id)}
                    type="button"
                    aria-label={`Remove ${owner.archidekt_username}`}
                  >
                    Remove
                  </button>
                </div>
              </div>

              {expandedOwner === owner.id && loadingOwnerDecks && (
                <div className="deck-tracker-browse">
                  <Skeleton lines={4} />
                </div>
              )}

              {expandedOwner === owner.id && !loadingOwnerDecks && (
                <div className="deck-tracker-browse">
                  {ownerDecks.length === 0 ? (
                    <p className="deck-tracker-browse-empty">No public decks found.</p>
                  ) : (
                    <ul className="deck-tracker-browse-list">
                      {ownerDecks.map(deck => (
                        <li key={deck.id} className="deck-tracker-browse-item">
                          <span className="deck-tracker-browse-name">{deck.name}</span>
                          {deck.tracked ? (
                            <span className="deck-tracker-browse-tracked">Tracking</span>
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
        <div className="deck-tracker-decks">
          <div className="deck-tracker-decks-header">
            <h3 className="deck-tracker-decks-title">Tracked Decks</h3>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleRefreshAll}
              disabled={refreshingAll}
              type="button"
              title="Refresh all tracked decks from Archidekt"
            >
              {refreshingAll ? 'Refreshing All...' : `Refresh All (${trackedDecks.length})`}
            </button>
          </div>
          {trackedDecks.map(deck => (
            <TrackedDeckCard
              key={deck.id}
              deck={deck}
              onRefresh={() => handleRefreshDeck(deck.id)}
              onUntrack={() => handleUntrackDeck(deck.id)}
              onLoadToCompare={onLoadToCompare}
              onUpdate={refresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}
