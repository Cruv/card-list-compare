import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from './ConfirmModal';
import { toast } from './Toast';
import {
  getMe, changePassword, updateEmail, deleteAccount,
  getOwners, addOwner, removeOwner, getOwnerDecks,
  getTrackedDecks, trackDeck, untrackDeck, refreshDeck, refreshAllDecks,
  getDeckSnapshots, deleteSnapshot as apiDeleteSnapshot, renameSnapshot,
  getDeckChangelog, updateDeckCommanders, resendVerification,
  lockSnapshot, unlockSnapshot,
  createInviteCode, getMyInvites, deleteInviteCode,
  getDeckTimeline, exportDecks, getSnapshot,
  shareDeck, unshareDeck,
} from '../lib/api';
import CopyButton from './CopyButton';
import PasswordRequirements from './PasswordRequirements';
import { formatChangelog, formatMpcFill, formatReddit, formatJSON } from '../lib/formatter';
import Skeleton from './Skeleton';
import TimelineOverlay from './TimelineOverlay';
import './UserSettings.css';

export default function UserSettings() {
  const { user, logoutUser, loginUser } = useAuth();
  const [confirm, ConfirmDialog] = useConfirm();
  const [activeTab, setActiveTab] = useState('account');

  // User capabilities
  const [canInvite, setCanInvite] = useState(false);

  // Account info
  const [email, setEmail] = useState('');
  const [createdAt, setCreatedAt] = useState('');
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailVerified, setEmailVerified] = useState(false);
  const [resending, setResending] = useState(false);

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
      setEmailVerified(!!data.user.emailVerified);
      setCanInvite(!!data.user.canInvite);
    }).catch(() => {});
  }, []);

  async function handleEmailSave(e) {
    e.preventDefault();
    setEmailSaving(true);
    try {
      const data = await updateEmail(email.trim() || null);
      setEmail(data.user.email || '');
      setEmailVerified(!!data.user.emailVerified);
      if (email.trim()) {
        toast.success('Email updated — check your inbox for a verification link');
      } else {
        toast.success('Email removed');
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setEmailSaving(false);
    }
  }

  async function handleResendVerification() {
    setResending(true);
    try {
      await resendVerification();
      toast.success('Verification email sent — check your inbox');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setResending(false);
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
      const data = await changePassword(currentPassword, newPassword);
      // Update token so current session stays valid after password_changed_at is set
      if (data.token) {
        localStorage.setItem('clc-auth-token', data.token);
      }
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
    <div className="settings-page">
      <button className="settings-back-link" onClick={() => { window.location.hash = ''; }} type="button">
        &larr; Back to Compare
      </button>
      <div className="user-settings">
        {ConfirmDialog}
        <div className="user-settings-header">
          <h2>Account Settings</h2>
        </div>

        <nav className="user-settings-tabs">
          <button
            className={`user-settings-tab${activeTab === 'account' ? ' user-settings-tab--active' : ''}`}
            onClick={() => setActiveTab('account')}
            type="button"
          >
            Account
          </button>
          <button
            className={`user-settings-tab${activeTab === 'deck-tracker' ? ' user-settings-tab--active' : ''}`}
            onClick={() => setActiveTab('deck-tracker')}
            type="button"
          >
            Deck Tracker
          </button>
          {(canInvite || user?.isAdmin) && (
            <button
              className={`user-settings-tab${activeTab === 'invites' ? ' user-settings-tab--active' : ''}`}
              onClick={() => setActiveTab('invites')}
              type="button"
            >
              Invites
            </button>
          )}
        </nav>

      {activeTab === 'account' && (
        <div className="user-settings-panel">

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
          {email && (
            <div className="user-settings-email-status">
              {emailVerified ? (
                <span className="email-verified">{'\u2713'} Verified</span>
              ) : (
                <span className="email-unverified">
                  Not verified
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={handleResendVerification}
                    disabled={resending}
                  >
                    {resending ? '...' : 'Resend'}
                  </button>
                </span>
              )}
            </div>
          )}
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
          <PasswordRequirements password={newPassword} />
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
      )}

      {activeTab === 'deck-tracker' && (
        <div className="user-settings-panel">
          <DeckTrackerSettings confirm={confirm} />
        </div>
      )}

      {activeTab === 'invites' && (canInvite || user?.isAdmin) && (
        <div className="user-settings-panel">
          <InviteManagement />
        </div>
      )}

      </div>
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

  // Search + collapse state
  const [deckSearch, setDeckSearch] = useState('');
  const [collapsedOwners, setCollapsedOwners] = useState(new Set());

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

  // Changelog state
  const [changelog, setChangelog] = useState(null);
  const [changelogDeckId, setChangelogDeckId] = useState(null);
  const [compareMode, setCompareMode] = useState(false);
  const [compareA, setCompareA] = useState('');
  const [compareB, setCompareB] = useState('');

  // Group decks by owner
  const decksByOwner = useMemo(() => {
    const groups = new Map();
    for (const deck of trackedDecks) {
      const owner = deck.archidekt_username || 'Unknown';
      if (!groups.has(owner)) groups.set(owner, []);
      groups.get(owner).push(deck);
    }
    // Sort by owner name alphabetically
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [trackedDecks]);

  // Filter by search
  const filteredDecksByOwner = useMemo(() => {
    const term = deckSearch.trim().toLowerCase();
    if (!term) return decksByOwner;
    return decksByOwner
      .map(([owner, decks]) => {
        const filtered = decks.filter(d =>
          d.deck_name.toLowerCase().includes(term) ||
          owner.toLowerCase().includes(term)
        );
        return [owner, filtered];
      })
      .filter(([, decks]) => decks.length > 0);
  }, [decksByOwner, deckSearch]);

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

      // If no commanders were auto-detected, prompt user to set them
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
    try {
      const data = await getDeckChangelog(deckId);
      setChangelog(data);
      setChangelogDeckId(deckId);
      setCompareMode(false);
    } catch (err) {
      toast.error(err.message);
    }
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

  async function handleToggleLock(deckId, snapshotId, isLocked) {
    try {
      if (isLocked) {
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
                  <button className="btn btn-secondary btn-sm btn-danger" onClick={handleBulkUntrack} type="button">
                    Untrack ({selectedDecks.size})
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Search filter */}
          {trackedDecks.length > 3 && (
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
          )}

          {/* Owner groups */}
          {filteredDecksByOwner.length === 0 && deckSearch.trim() && (
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
                          changelog={changelog}
                          setChangelog={setChangelog}
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
  changelog, setChangelog,
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
}) {
  const [timelineData, setTimelineData] = useState(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [overlayEntry, setOverlayEntry] = useState(null);

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
    <div className={`settings-tracker-deck${isSelected ? ' settings-tracker-deck--selected' : ''}`}>
      <div className="settings-tracker-deck-header">
        {bulkMode && (
          <input
            type="checkbox"
            className="settings-tracker-bulk-checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
          />
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
              className="btn btn-secondary btn-sm btn-danger"
              onClick={() => handleUntrackDeck(deck.id)}
              type="button"
            >
              Untrack
            </button>
          </div>
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

      {expandedDeckId === deck.id && (
        <div className="settings-tracker-snapshots">
          <div className="settings-tracker-changelog-actions">
            <button className="btn btn-primary btn-sm" onClick={() => handleViewChangelog(deck.id)} type="button">
              View Latest Changelog
            </button>
            <button
              className={`btn btn-secondary btn-sm${showTimeline ? ' btn--active' : ''}`}
              onClick={handleShowTimeline}
              type="button"
            >
              {timelineLoading ? '...' : 'Timeline'}
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
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => deck.share_id ? handleUnshareDeck(deck.id) : handleShareDeck(deck.id)}
              type="button"
            >
              {deck.share_id ? 'Unshare' : 'Share'}
            </button>
          </div>

          {showTimeline && (
            <SnapshotTimeline entries={timelineData} loading={timelineLoading} onEntryClick={handleTimelineEntryClick} />
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
                <li key={snap.id} className={`settings-tracker-snap${snap.locked ? ' settings-tracker-snap--locked' : ''}`}>
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
                      className="settings-tracker-lock-btn"
                      onClick={() => handleToggleLock(deck.id, snap.id, !!snap.locked)}
                      type="button"
                      title={snap.locked ? 'Unlock snapshot (allow auto-pruning)' : 'Lock snapshot (prevent auto-pruning)'}
                    >
                      {snap.locked ? '\uD83D\uDD12' : '\uD83D\uDD13'}
                    </button>
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
                      disabled={!!snap.locked}
                      title={snap.locked ? 'Unlock to delete' : 'Delete snapshot'}
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
  );
}

// --- Invite Code Management ---

function InviteManagement() {
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [maxUses, setMaxUses] = useState(1);
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getMyInvites();
      setInvites(data.invites);
    } catch {
      toast.error('Failed to load invite codes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleCreate(e) {
    e.preventDefault();
    setCreating(true);
    try {
      await createInviteCode(maxUses);
      toast.success('Invite code created');
      await refresh();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id) {
    try {
      await deleteInviteCode(id);
      toast.success('Invite code deleted');
      await refresh();
    } catch (err) {
      toast.error(err.message);
    }
  }

  function handleCopy(code, id) {
    navigator.clipboard.writeText(code).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso + 'Z').toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  }

  return (
    <div className="settings-invites">
      <section className="user-settings-section" style={{ borderTop: 'none' }}>
        <h3>Invite Codes</h3>
        <p className="user-settings-desc">
          Create invite codes to share with others. Each code can be used a limited number of times.
        </p>

        <form className="settings-invite-create" onSubmit={handleCreate}>
          <label htmlFor="invite-max-uses">Max uses:</label>
          <select
            id="invite-max-uses"
            value={maxUses}
            onChange={e => setMaxUses(parseInt(e.target.value, 10))}
            disabled={creating}
          >
            <option value={1}>1</option>
            <option value={3}>3</option>
            <option value={5}>5</option>
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
          </select>
          <button className="btn btn-primary btn-sm" type="submit" disabled={creating}>
            {creating ? '...' : 'Create Code'}
          </button>
        </form>

        {loading ? (
          <p className="settings-tracker-empty">Loading...</p>
        ) : invites.length === 0 ? (
          <p className="settings-tracker-empty">No invite codes yet. Create one above.</p>
        ) : (
          <ul className="settings-invite-list">
            {invites.map(inv => (
              <li key={inv.id} className="settings-invite-item">
                <div className="settings-invite-info">
                  <code className="settings-invite-code">{inv.code}</code>
                  <button
                    className="settings-invite-copy"
                    onClick={() => handleCopy(inv.code, inv.id)}
                    type="button"
                    title="Copy code"
                  >
                    {copiedId === inv.id ? '\u2713' : 'Copy'}
                  </button>
                  <span className="settings-invite-usage">
                    {inv.use_count}/{inv.max_uses > 0 ? inv.max_uses : '\u221E'} used
                  </span>
                  <span className="settings-invite-date">{formatDate(inv.created_at)}</span>
                </div>
                <button
                  className="btn btn-secondary btn-sm btn-danger"
                  onClick={() => handleDelete(inv.id)}
                  type="button"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
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

// --- Snapshot Timeline ---

function SnapshotTimeline({ entries, loading, onEntryClick }) {
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
            <div className="settings-timeline-dot" />
            {i < displayed.length - 1 && <div className="settings-timeline-line" />}
          </div>
          <div className="settings-timeline-content">
            <div className="settings-timeline-info">
              <span className="settings-timeline-date">{formatTimelineDate(entry.date)}</span>
              {entry.nickname && <span className="settings-timeline-nick">{entry.nickname}</span>}
              {entry.locked && <span className="settings-timeline-lock" title="Locked">{'\uD83D\uDD12'}</span>}
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
