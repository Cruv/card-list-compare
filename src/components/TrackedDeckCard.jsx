import { useState, useCallback, useMemo } from 'react';
import {
  getDeckSnapshots,
  deleteSnapshot,
  renameSnapshot,
  getDeckChangelog,
} from '../lib/api';
import { useConfirm } from './ConfirmModal';
import { toast } from './Toast';
import CopyButton from './CopyButton';
import { formatChangelog, formatMpcFill, formatReddit, formatJSON } from '../lib/formatter';
import './TrackedDeckCard.css';

export default function TrackedDeckCard({ deck, onRefresh, onUntrack, onLoadToCompare, onUpdate }) {
  const [expanded, setExpanded] = useState(false);
  const [snapshots, setSnapshots] = useState([]);
  const [changelog, setChangelog] = useState(null);
  const [compareMode, setCompareMode] = useState(false);
  const [compareA, setCompareA] = useState('');
  const [compareB, setCompareB] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState(null);
  const [editingNickname, setEditingNickname] = useState(null);
  const [nicknameValue, setNicknameValue] = useState('');
  const [error, setError] = useState(null);
  const [confirm, ConfirmDialog] = useConfirm();

  const loadSnapshots = useCallback(async () => {
    try {
      const data = await getDeckSnapshots(deck.id);
      setSnapshots(data.snapshots);
    } catch (err) {
      setError(err.message);
    }
  }, [deck.id]);

  async function handleToggle() {
    if (!expanded) {
      await loadSnapshots();
    }
    setExpanded(!expanded);
    setChangelog(null);
    setCompareMode(false);
  }

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshMsg(null);
    setError(null);
    try {
      const result = await onRefresh();
      const msg = result.changed ? 'New snapshot saved!' : 'No changes detected.';
      setRefreshMsg(msg);
      toast(msg, result.changed ? 'success' : 'info');
      if (expanded) await loadSnapshots();
      setTimeout(() => setRefreshMsg(null), 3000);
    } catch {
      // Error handled by parent
    } finally {
      setRefreshing(false);
    }
  }

  async function handleDeleteSnapshot(snapshotId) {
    const confirmed = await confirm({
      title: 'Delete snapshot?',
      message: 'This snapshot will be permanently deleted.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await deleteSnapshot(deck.id, snapshotId);
      toast.success('Snapshot deleted');
      await loadSnapshots();
      onUpdate();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleStartRename(snapshot) {
    setEditingNickname(snapshot.id);
    setNicknameValue(snapshot.nickname || '');
  }

  async function handleSaveNickname(snapshotId) {
    try {
      await renameSnapshot(deck.id, snapshotId, nicknameValue || null);
      setEditingNickname(null);
      await loadSnapshots();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleViewChangelog() {
    setError(null);
    try {
      const data = await getDeckChangelog(deck.id);
      setChangelog(data);
      setCompareMode(false);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleCompareSnapshots() {
    if (!compareA || !compareB) return;
    setError(null);
    try {
      const data = await getDeckChangelog(deck.id, compareA, compareB);
      setChangelog(data);
    } catch (err) {
      setError(err.message);
    }
  }

  function formatDate(iso) {
    return new Date(iso + 'Z').toLocaleString();
  }

  function snapshotLabel(snap) {
    const date = formatDate(snap.created_at);
    return snap.nickname ? `${snap.nickname} (${date})` : date;
  }

  return (
    <div className="tracked-deck">
      {ConfirmDialog}
      <div className="tracked-deck-header">
        <div className="tracked-deck-info">
          <button
            className="tracked-deck-name"
            onClick={handleToggle}
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${deck.deck_name}`}
          >
            {expanded ? '\u25BC' : '\u25B6'} {deck.deck_name}
          </button>
          <span className="tracked-deck-meta">
            {deck.archidekt_username}
            {deck.snapshot_count > 0 && ` \u00B7 ${deck.snapshot_count} snapshot${deck.snapshot_count !== 1 ? 's' : ''}`}
            {deck.last_refreshed_at && ` \u00B7 Last refreshed ${formatDate(deck.last_refreshed_at)}`}
          </span>
        </div>
        <div className="tracked-deck-actions">
          <button
            className="btn btn-secondary btn-sm"
            onClick={handleRefresh}
            disabled={refreshing}
            type="button"
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          <button className="btn btn-secondary btn-sm btn-danger" onClick={onUntrack} type="button">
            Untrack
          </button>
        </div>
      </div>

      {refreshMsg && <div className="tracked-deck-msg" role="status">{refreshMsg}</div>}
      {error && <div className="tracked-deck-error" role="alert">{error}</div>}

      {expanded && (
        <div className="tracked-deck-body">
          <div className="tracked-deck-changelog-actions">
            <button className="btn btn-primary btn-sm" onClick={handleViewChangelog} type="button">
              View Latest Changelog
            </button>
            <button
              className={`btn btn-secondary btn-sm${compareMode ? ' btn--active' : ''}`}
              onClick={() => { setCompareMode(!compareMode); setChangelog(null); }}
              type="button"
            >
              Compare Snapshots...
            </button>
            {deck.deck_url && (
              <a
                href={deck.deck_url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-secondary btn-sm"
              >
                View on Archidekt
              </a>
            )}
          </div>

          {compareMode && (
            <div className="tracked-deck-compare">
              <select
                value={compareA}
                onChange={e => setCompareA(e.target.value)}
                aria-label="Select older snapshot"
              >
                <option value="">Before (older)...</option>
                {snapshots.map(s => (
                  <option key={s.id} value={s.id}>{snapshotLabel(s)}</option>
                ))}
              </select>
              <select
                value={compareB}
                onChange={e => setCompareB(e.target.value)}
                aria-label="Select newer snapshot"
              >
                <option value="">After (newer)...</option>
                {snapshots.map(s => (
                  <option key={s.id} value={s.id}>{snapshotLabel(s)}</option>
                ))}
              </select>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleCompareSnapshots}
                disabled={!compareA || !compareB}
                type="button"
              >
                Compare
              </button>
            </div>
          )}

          {changelog && (
            <div className="tracked-deck-changelog">
              <div className="tracked-deck-changelog-header">
                <strong>Changelog:</strong> {snapshotLabel(changelog.before)} &rarr; {snapshotLabel(changelog.after)}
                <div className="tracked-deck-changelog-load">
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => onLoadToCompare(changelog.before.deck_text || '', 'before')}
                    type="button"
                    disabled={!changelog.before.deck_text}
                  >
                    Load Before
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => onLoadToCompare(changelog.after.deck_text || '', 'after')}
                    type="button"
                    disabled={!changelog.after.deck_text}
                  >
                    Load After
                  </button>
                </div>
              </div>
              <ChangelogDisplay diff={changelog.diff} />
            </div>
          )}

          {snapshots.length > 0 && (
            <div className="tracked-deck-snapshots">
              <h4 className="tracked-deck-snapshots-title">Snapshots</h4>
              <ul className="tracked-deck-snapshots-list">
                {snapshots.map(snap => (
                  <li key={snap.id} className="tracked-deck-snapshot">
                    <div className="tracked-deck-snapshot-info">
                      {editingNickname === snap.id ? (
                        <span className="tracked-deck-snapshot-edit">
                          <input
                            type="text"
                            value={nicknameValue}
                            onChange={e => setNicknameValue(e.target.value)}
                            placeholder="Nickname (optional)"
                            aria-label="Snapshot nickname"
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleSaveNickname(snap.id);
                              if (e.key === 'Escape') setEditingNickname(null);
                            }}
                            autoFocus
                          />
                          <button className="btn btn-primary btn-sm" onClick={() => handleSaveNickname(snap.id)} type="button">
                            Save
                          </button>
                          <button className="btn btn-secondary btn-sm" onClick={() => setEditingNickname(null)} type="button">
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <>
                          <span className="tracked-deck-snapshot-date">{formatDate(snap.created_at)}</span>
                          {snap.nickname && <span className="tracked-deck-snapshot-nick">{snap.nickname}</span>}
                        </>
                      )}
                    </div>
                    <div className="tracked-deck-snapshot-actions">
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleStartRename(snap)}
                        type="button"
                      >
                        {snap.nickname ? 'Rename' : 'Nickname'}
                      </button>
                      <button
                        className="btn btn-secondary btn-sm btn-danger"
                        onClick={() => handleDeleteSnapshot(snap.id)}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChangelogDisplay({ diff }) {
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
    return <p className="tracked-deck-changelog-empty">No changes detected.</p>;
  }

  // Build a diffResult-like object for the formatters
  const diffResult = { mainboard, sideboard, hasSideboard, commanders: [] };

  return (
    <div>
      <div className="tracked-deck-changelog-copy">
        {hasAdditions && (
          <CopyButton
            getText={() => formatMpcFill(diffResult)}
            label="Copy for MPCFill"
            className="copy-btn copy-btn--mpc"
          />
        )}
        <CopyButton getText={() => formatChangelog(diffResult)} />
        <CopyButton
          getText={() => formatReddit(diffResult)}
          label="Copy for Reddit"
          className="copy-btn copy-btn--reddit"
        />
        <CopyButton
          getText={() => formatJSON(diffResult)}
          label="Copy JSON"
          className="copy-btn copy-btn--json"
        />
      </div>
      <div className="changelog-inline">
        {hasMainChanges && <SectionDisplay title="Mainboard" section={mainboard} />}
        {hasSideChanges && <SectionDisplay title="Sideboard" section={sideboard} />}
      </div>
    </div>
  );
}

function SectionDisplay({ title, section }) {
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
