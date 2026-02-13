import { useState, useEffect, useMemo } from 'react';
import { getSharedDeck, getSharedDeckChangelog, getSharedDeckSnapshot } from '../lib/api';
import { toast } from './Toast';
import Skeleton from './Skeleton';
import CopyButton from './CopyButton';
import { formatChangelog, formatReddit, formatJSON } from '../lib/formatter';
import './SharedDeckView.css';

export default function SharedDeckView({ shareId }) {
  const [deckData, setDeckData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Changelog state
  const [changelog, setChangelog] = useState(null);
  const [compareA, setCompareA] = useState('');
  const [compareB, setCompareB] = useState('');

  // Snapshot text viewer
  const [viewingSnapshot, setViewingSnapshot] = useState(null);
  const [snapshotText, setSnapshotText] = useState('');
  const [snapshotLoading, setSnapshotLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getSharedDeck(shareId)
      .then(setDeckData)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [shareId]);

  async function handleViewChangelog() {
    try {
      const data = await getSharedDeckChangelog(shareId);
      setChangelog(data);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleCompare() {
    if (!compareA || !compareB) return;
    try {
      const data = await getSharedDeckChangelog(shareId, compareA, compareB);
      setChangelog(data);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleViewSnapshot(snapshotId) {
    if (viewingSnapshot === snapshotId) {
      setViewingSnapshot(null);
      setSnapshotText('');
      return;
    }
    setSnapshotLoading(true);
    setViewingSnapshot(snapshotId);
    try {
      const data = await getSharedDeckSnapshot(shareId, snapshotId);
      setSnapshotText(data.snapshot.deck_text);
    } catch {
      toast.error('Failed to load snapshot');
      setViewingSnapshot(null);
    } finally {
      setSnapshotLoading(false);
    }
  }

  function handleCopyLink() {
    const url = `${window.location.origin}${window.location.pathname}#deck/${shareId}`;
    navigator.clipboard.writeText(url).then(() => {
      toast.success('Link copied to clipboard');
    });
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso + 'Z').toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  }

  if (loading) {
    return (
      <div className="shared-deck-page">
        <Skeleton lines={8} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="shared-deck-page">
        <div className="shared-deck-error">
          <h2>Shared Deck Not Found</h2>
          <p>{error}</p>
          <button className="btn btn-primary btn-sm" onClick={() => { window.location.hash = ''; }} type="button">
            &larr; Back to Compare
          </button>
        </div>
      </div>
    );
  }

  const { deckName, commanders, ownerUsername, sharedAt, snapshots } = deckData;

  return (
    <div className="shared-deck-page">
      <button className="settings-back-link" onClick={() => { window.location.hash = ''; }} type="button">
        &larr; Back to Compare
      </button>

      <div className="shared-deck-card">
        <div className="shared-deck-header">
          <h2 className="shared-deck-title">{deckName}</h2>
          <div className="shared-deck-meta">
            {commanders.length > 0 && (
              <span className="shared-deck-commanders">{commanders.join(' / ')}</span>
            )}
            <span className="shared-deck-owner">by {ownerUsername}</span>
            <span className="shared-deck-shared-date">Shared {formatDate(sharedAt)}</span>
          </div>
        </div>

        <div className="shared-deck-actions">
          <button className="btn btn-primary btn-sm" onClick={handleViewChangelog} type="button">
            View Latest Changelog
          </button>
          <button className="btn btn-secondary btn-sm" onClick={handleCopyLink} type="button">
            Copy Link
          </button>
          {deckData.deckUrl && (
            <a href={deckData.deckUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm">
              Archidekt
            </a>
          )}
        </div>

        {/* Compare snapshots */}
        {snapshots.length >= 2 && (
          <div className="shared-deck-compare">
            <select value={compareA} onChange={e => setCompareA(e.target.value)} aria-label="Older snapshot">
              <option value="">Before (older)...</option>
              {snapshots.map(s => (
                <option key={s.id} value={s.id}>
                  {s.nickname ? `${s.nickname} (${formatDate(s.created_at)})` : formatDate(s.created_at)}
                </option>
              ))}
            </select>
            <select value={compareB} onChange={e => setCompareB(e.target.value)} aria-label="Newer snapshot">
              <option value="">After (newer)...</option>
              {snapshots.map(s => (
                <option key={s.id} value={s.id}>
                  {s.nickname ? `${s.nickname} (${formatDate(s.created_at)})` : formatDate(s.created_at)}
                </option>
              ))}
            </select>
            <button className="btn btn-primary btn-sm" onClick={handleCompare} disabled={!compareA || !compareB} type="button">
              Compare
            </button>
          </div>
        )}

        {/* Changelog display */}
        {changelog && <SharedChangelogDisplay changelog={changelog} />}

        {/* Snapshot list */}
        <h3 className="shared-deck-section-title">Snapshots ({snapshots.length})</h3>
        {snapshots.length === 0 ? (
          <p className="shared-deck-empty">No snapshots available.</p>
        ) : (
          <ul className="shared-deck-snap-list">
            {snapshots.map(s => (
              <li key={s.id} className={`shared-deck-snap${s.locked ? ' shared-deck-snap--locked' : ''}`}>
                <div className="shared-deck-snap-info">
                  <span className="shared-deck-snap-date">{formatDate(s.created_at)}</span>
                  {s.nickname && <span className="shared-deck-snap-nick">{s.nickname}</span>}
                  {s.locked && <span title="Locked">{'\uD83D\uDD12'}</span>}
                  <span className="shared-deck-snap-count">{s.cardCount} cards</span>
                </div>
                <button
                  className={`btn btn-secondary btn-sm${viewingSnapshot === s.id ? ' btn--active' : ''}`}
                  onClick={() => handleViewSnapshot(s.id)}
                  type="button"
                >
                  {viewingSnapshot === s.id ? 'Hide' : 'View'}
                </button>
                {viewingSnapshot === s.id && (
                  <div className="shared-deck-snap-text">
                    {snapshotLoading ? (
                      <Skeleton lines={5} />
                    ) : (
                      <>
                        <pre>{snapshotText}</pre>
                        <CopyButton getText={() => snapshotText} label="Copy Deck Text" className="copy-btn" />
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SharedChangelogDisplay({ changelog }) {
  const { diff } = changelog;
  const { mainboard, sideboard, hasSideboard } = diff;

  const { hasMainChanges, hasSideChanges, noChanges } = useMemo(() => {
    const hasMain =
      mainboard.cardsIn.length > 0 ||
      mainboard.cardsOut.length > 0 ||
      mainboard.quantityChanges.length > 0;

    const hasSide = hasSideboard && (
      sideboard.cardsIn.length > 0 ||
      sideboard.cardsOut.length > 0 ||
      sideboard.quantityChanges.length > 0
    );

    return { hasMainChanges: hasMain, hasSideChanges: hasSide, noChanges: !hasMain && !hasSide };
  }, [mainboard, sideboard, hasSideboard]);

  if (noChanges) {
    return <p className="shared-deck-empty">No changes detected.</p>;
  }

  const diffResult = { mainboard, sideboard, hasSideboard, commanders: [] };

  function formatSnapLabel(snap) {
    const d = snap.created_at ? new Date(snap.created_at + 'Z').toLocaleString() : '';
    return snap.nickname ? `${snap.nickname} (${d})` : d;
  }

  return (
    <div className="shared-deck-changelog">
      <div className="shared-deck-changelog-header">
        <strong>Changelog:</strong> {formatSnapLabel(changelog.before)} &rarr; {formatSnapLabel(changelog.after)}
      </div>
      <div className="shared-deck-changelog-copy">
        <CopyButton getText={() => formatChangelog(diffResult)} />
        <CopyButton getText={() => formatReddit(diffResult)} label="Copy for Reddit" className="copy-btn copy-btn--reddit" />
        <CopyButton getText={() => formatJSON(diffResult)} label="Copy JSON" className="copy-btn copy-btn--json" />
      </div>
      <div className="changelog-inline">
        {hasMainChanges && <SharedChangelogSection title="Mainboard" section={mainboard} />}
        {hasSideChanges && <SharedChangelogSection title="Sideboard" section={sideboard} />}
      </div>
    </div>
  );
}

function SharedChangelogSection({ title, section }) {
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
