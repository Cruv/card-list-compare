import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from './ConfirmModal';
import { toast } from './Toast';
import {
  getMe, changePassword, updateEmail, deleteAccount,
  getOwners, addOwner, removeOwner, getOwnerDecks,
  getTrackedDecks, trackDeck, untrackDeck, refreshDeck, refreshAllDecks,
  getDeckSnapshots, deleteSnapshot as apiDeleteSnapshot, renameSnapshot,
  getDeckChangelog,
} from '../lib/api';
import CopyButton from './CopyButton';
import { formatChangelog, formatMpcFill, formatReddit, formatJSON } from '../lib/formatter';
import Skeleton from './Skeleton';
import './UserSettings.css';

export default function UserSettings({ onClose }) {
  const { user, logoutUser } = useAuth();
  const [confirm, ConfirmDialog] = useConfirm();

  // Account info
  const [email, setEmail] = useState('');
  const [createdAt, setCreatedAt] = useState('');
  const [emailSaving, setEmailSaving] = useState(false);

  // Change password
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);

  // Delete account
  const [deleteUsername, setDeleteUsername] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    getMe().then(data => {
      setEmail(data.user.email || '');
      setCreatedAt(data.user.createdAt || '');
    }).catch(() => {});
  }, []);

  async function handleEmailSave(e) {
    e.preventDefault();
    setEmailSaving(true);
    try {
      const data = await updateEmail(email.trim() || null);
      setEmail(data.user.email || '');
      toast.success(email.trim() ? 'Email updated' : 'Email removed');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setEmailSaving(false);
    }
  }

  async function handlePasswordChange(e) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error('New passwords do not match');
      return;
    }
    setPasswordSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      toast.success('Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setPasswordSaving(false);
    }
  }

  async function handleDeleteAccount(e) {
    e.preventDefault();
    const confirmed = await confirm({
      title: 'Delete your account?',
      message: 'This will permanently delete your account and all tracked decks, snapshots, and data. This cannot be undone.',
      confirmLabel: 'Delete Account',
      danger: true,
    });
    if (!confirmed) return;

    setDeleting(true);
    try {
      await deleteAccount(deleteUsername);
      toast.success('Account deleted');
      logoutUser();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
    }
  }

  const formattedDate = createdAt
    ? new Date(createdAt + 'Z').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : '...';

  return (
    <div className="user-settings">
      {ConfirmDialog}
      <div className="user-settings-header">
        <h2>Account Settings</h2>
        <button className="btn btn-secondary btn-sm" onClick={onClose} type="button">Close</button>
      </div>

      {/* Account Info */}
      <section className="user-settings-section">
        <h3>Account Info</h3>
        <div className="user-settings-field">
          <label>Username</label>
          <span className="user-settings-value">{user?.username}</span>
        </div>
        <div className="user-settings-field">
          <label>Member since</label>
          <span className="user-settings-value">{formattedDate}</span>
        </div>
        <form className="user-settings-form" onSubmit={handleEmailSave}>
          <label htmlFor="settings-email">Email <span className="user-settings-optional">(optional — needed for password reset)</span></label>
          <div className="user-settings-input-row">
            <input
              id="settings-email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              disabled={emailSaving}
              autoComplete="email"
            />
            <button className="btn btn-primary btn-sm" type="submit" disabled={emailSaving}>
              {emailSaving ? '...' : 'Save'}
            </button>
          </div>
        </form>
      </section>

      {/* Change Password */}
      <section className="user-settings-section">
        <h3>Change Password</h3>
        <form className="user-settings-form" onSubmit={handlePasswordChange}>
          <label htmlFor="settings-current-pw">Current Password</label>
          <input
            id="settings-current-pw"
            type="password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            disabled={passwordSaving}
            autoComplete="current-password"
            required
          />
          <label htmlFor="settings-new-pw">New Password</label>
          <input
            id="settings-new-pw"
            type="password"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            disabled={passwordSaving}
            autoComplete="new-password"
            minLength={8}
            required
          />
          <label htmlFor="settings-confirm-pw">Confirm New Password</label>
          <input
            id="settings-confirm-pw"
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            disabled={passwordSaving}
            autoComplete="new-password"
            minLength={8}
            required
          />
          <button className="btn btn-primary btn-sm" type="submit" disabled={passwordSaving}>
            {passwordSaving ? '...' : 'Change Password'}
          </button>
        </form>
      </section>

      {/* Deck Tracker */}
      <section className="user-settings-section">
        <h3>Deck Tracker</h3>
        <p className="user-settings-desc">Track Archidekt users and their decks to build snapshot history.</p>
        <DeckTrackerSettings confirm={confirm} />
      </section>

      {/* Danger Zone */}
      <section className="user-settings-section user-settings-danger">
        <h3>Danger Zone</h3>
        <p>Permanently delete your account and all associated data. This action cannot be undone.</p>
        <form className="user-settings-form" onSubmit={handleDeleteAccount}>
          <label htmlFor="settings-delete-confirm">Type your username to confirm</label>
          <div className="user-settings-input-row">
            <input
              id="settings-delete-confirm"
              type="text"
              placeholder={user?.username}
              value={deleteUsername}
              onChange={e => setDeleteUsername(e.target.value)}
              disabled={deleting}
              autoComplete="off"
            />
            <button
              className="btn btn-sm btn-danger"
              type="submit"
              disabled={deleting || deleteUsername.toLowerCase() !== (user?.username || '').toLowerCase()}
            >
              {deleting ? '...' : 'Delete Account'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

// --- Deck Tracker Management (embedded in Settings) ---

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

  // Per-deck expanded snapshots
  const [expandedDeckId, setExpandedDeckId] = useState(null);
  const [deckSnapshots, setDeckSnapshots] = useState([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [editingNickname, setEditingNickname] = useState(null);
  const [nicknameValue, setNicknameValue] = useState('');
  const [refreshingDeck, setRefreshingDeck] = useState(null);

  // Changelog state
  const [changelog, setChangelog] = useState(null);
  const [changelogDeckId, setChangelogDeckId] = useState(null);
  const [compareMode, setCompareMode] = useState(false);
  const [compareA, setCompareA] = useState('');
  const [compareB, setCompareB] = useState('');

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
      await trackDeck(ownerId, deck.id, deck.name, deck.url);
      toast.success(`Now tracking "${deck.name}"`);
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
    try {
      const data = await getDeckChangelog(deckId);
      setChangelog(data);
      setChangelogDeckId(deckId);
      setCompareMode(false);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleCompareSnapshots(deckId) {
    if (!compareA || !compareB) return;
    try {
      const data = await getDeckChangelog(deckId, compareA, compareB);
      setChangelog(data);
      setChangelogDeckId(deckId);
    } catch (err) {
      toast.error(err.message);
    }
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
                    className="btn btn-secondary btn-sm btn-danger"
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
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleRefreshAll}
              disabled={refreshingAll}
              type="button"
            >
              {refreshingAll ? 'Refreshing...' : `Refresh All (${trackedDecks.length})`}
            </button>
          </div>
          {trackedDecks.map(deck => (
            <div key={deck.id} className="settings-tracker-deck">
              <div className="settings-tracker-deck-header">
                <button
                  className="settings-tracker-deck-name"
                  onClick={() => handleExpandDeckSnapshots(deck.id)}
                  type="button"
                  aria-expanded={expandedDeckId === deck.id}
                >
                  {expandedDeckId === deck.id ? '\u25BC' : '\u25B6'} {deck.deck_name}
                </button>
                <span className="settings-tracker-deck-meta">
                  {deck.archidekt_username} &middot; {deck.snapshot_count} snapshot{deck.snapshot_count !== 1 ? 's' : ''}
                </span>
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
                    className="btn btn-secondary btn-sm btn-danger"
                    onClick={() => handleUntrackDeck(deck.id)}
                    type="button"
                  >
                    Untrack
                  </button>
                </div>
              </div>

              {expandedDeckId === deck.id && (
                <div className="settings-tracker-snapshots">
                  <div className="settings-tracker-changelog-actions">
                    <button className="btn btn-primary btn-sm" onClick={() => handleViewChangelog(deck.id)} type="button">
                      View Latest Changelog
                    </button>
                    <button
                      className={`btn btn-secondary btn-sm${compareMode && changelogDeckId === deck.id ? ' btn--active' : ''}`}
                      onClick={() => { setCompareMode(!compareMode); setChangelog(null); setChangelogDeckId(deck.id); setCompareA(''); setCompareB(''); }}
                      type="button"
                    >
                      Compare...
                    </button>
                    {deck.deck_url && (
                      <a href={deck.deck_url} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm">
                        Archidekt
                      </a>
                    )}
                  </div>

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

                  {changelog && changelogDeckId === deck.id && (
                    <SettingsChangelogDisplay changelog={changelog} />
                  )}

                  {snapshotsLoading ? (
                    <Skeleton lines={3} />
                  ) : deckSnapshots.length === 0 ? (
                    <p className="settings-tracker-empty">No snapshots yet. Click Refresh to fetch the current list.</p>
                  ) : (
                    <ul className="settings-tracker-snap-list">
                      {deckSnapshots.map(snap => (
                        <li key={snap.id} className="settings-tracker-snap">
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
                              </>
                            )}
                          </div>
                          <div className="settings-tracker-snap-actions">
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => { setEditingNickname(snap.id); setNicknameValue(snap.nickname || ''); }}
                              type="button"
                            >
                              {snap.nickname ? 'Rename' : 'Nickname'}
                            </button>
                            <button
                              className="btn btn-secondary btn-sm btn-danger"
                              onClick={() => handleDeleteSnapshot(deck.id, snap.id)}
                              type="button"
                            >
                              Delete
                            </button>
                          </div>
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

      {owners.length === 0 && trackedDecks.length === 0 && (
        <p className="settings-tracker-empty">
          No tracked users yet. Enter an Archidekt username above to start tracking their decks.
        </p>
      )}
    </div>
  );
}

// --- Inline Changelog with Copy Buttons ---

function SettingsChangelogDisplay({ changelog }) {
  const { diff } = changelog;
  const { mainboard, sideboard, hasSideboard } = diff;

  const { hasMainChanges, hasSideChanges, noChanges, hasAdditions } = useMemo(() => {
    const hasMain =
      mainboard.cardsIn.length > 0 ||
      mainboard.cardsOut.length > 0 ||
      mainboard.quantityChanges.length > 0;

    const hasSide = hasSideboard && (
      sideboard.cardsIn.length > 0 ||
      sideboard.cardsOut.length > 0 ||
      sideboard.quantityChanges.length > 0
    );

    const none = !hasMain && !hasSide;

    const additions = mainboard.cardsIn.length > 0 ||
      sideboard.cardsIn.length > 0 ||
      [...mainboard.quantityChanges, ...sideboard.quantityChanges].some(c => c.delta > 0);

    return { hasMainChanges: hasMain, hasSideChanges: hasSide, noChanges: none, hasAdditions: additions };
  }, [mainboard, sideboard, hasSideboard]);

  if (noChanges) {
    return <p className="settings-tracker-empty">No changes detected.</p>;
  }

  const diffResult = { mainboard, sideboard, hasSideboard, commanders: [] };

  function formatSnapLabel(snap) {
    const d = snap.created_at ? new Date(snap.created_at + 'Z').toLocaleString() : '';
    return snap.nickname ? `${snap.nickname} (${d})` : d;
  }

  return (
    <div className="settings-tracker-changelog">
      <div className="settings-tracker-changelog-header">
        <strong>Changelog:</strong> {formatSnapLabel(changelog.before)} &rarr; {formatSnapLabel(changelog.after)}
      </div>
      <div className="settings-tracker-changelog-copy">
        {hasAdditions && (
          <CopyButton getText={() => formatMpcFill(diffResult)} label="Copy for MPCFill" className="copy-btn copy-btn--mpc" />
        )}
        <CopyButton getText={() => formatChangelog(diffResult)} />
        <CopyButton getText={() => formatReddit(diffResult)} label="Copy for Reddit" className="copy-btn copy-btn--reddit" />
        <CopyButton getText={() => formatJSON(diffResult)} label="Copy JSON" className="copy-btn copy-btn--json" />
      </div>
      <div className="changelog-inline">
        {hasMainChanges && <ChangelogSection title="Mainboard" section={mainboard} />}
        {hasSideChanges && <ChangelogSection title="Sideboard" section={sideboard} />}
      </div>
    </div>
  );
}

function ChangelogSection({ title, section }) {
  return (
    <div className="changelog-section">
      <div className="changelog-section-title">=== {title} ===</div>
      {section.cardsIn.length > 0 && (
        <div className="changelog-group">
          <div className="changelog-group-title">--- Cards In ---</div>
          {section.cardsIn.map(c => (
            <div key={c.name} className="changelog-line changelog-in">+ {c.quantity} {c.name}</div>
          ))}
        </div>
      )}
      {section.cardsOut.length > 0 && (
        <div className="changelog-group">
          <div className="changelog-group-title">--- Cards Out ---</div>
          {section.cardsOut.map(c => (
            <div key={c.name} className="changelog-line changelog-out">- {c.quantity} {c.name}</div>
          ))}
        </div>
      )}
      {section.quantityChanges.length > 0 && (
        <div className="changelog-group">
          <div className="changelog-group-title">--- Quantity Changes ---</div>
          {section.quantityChanges.map(c => (
            <div key={c.name} className="changelog-line changelog-qty">
              ~ {c.name} ({c.oldQty} &rarr; {c.newQty}, {c.delta > 0 ? '+' : ''}{c.delta})
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
