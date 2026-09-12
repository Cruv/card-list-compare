import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { getSharedDeck, getSharedDeckChangelog, getSharedDeckSnapshot } from '../lib/api';
import { toast } from './Toast';
import Skeleton from './Skeleton';
import CopyButton from './CopyButton';
import PrintComparisonButton from './PrintComparisonButton';
import SectionChangelog from './SectionChangelog';
import { parse } from '../lib/parser';
import { computeDiff } from '../lib/differ';
import { formatChangelog, formatReddit, formatJSON } from '../lib/formatter';
import Icon from './Icon';
import './SharedDeckView.css';

export default function SharedDeckView({ shareId }) {
  const [deckData, setDeckData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Changelog state
  const [changelog, setChangelog] = useState(null);
  const [changelogLoading, setChangelogLoading] = useState(false);
  const changelogSequence = useRef(0);
  const invalidateChangelog = useCallback(() => { ++changelogSequence.current; }, []);
  const [compareA, setCompareA] = useState('');
  const [compareB, setCompareB] = useState('');

  // Snapshot text viewer
  const [viewingSnapshot, setViewingSnapshot] = useState(null);
  const [snapshotText, setSnapshotText] = useState('');
  const [snapshotLoading, setSnapshotLoading] = useState(false);

  useEffect(() => {
    let active = true;
    invalidateChangelog();
    setChangelog(null);
    setChangelogLoading(false);
    setCompareA('');
    setCompareB('');
    setViewingSnapshot(null);
    setSnapshotText('');
    setLoading(true);
    setError(null);
    getSharedDeck(shareId)
      .then(data => { if (active) setDeckData(data); })
      .catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; invalidateChangelog(); };
  }, [shareId, invalidateChangelog]);

  async function loadChangelog(a, b) {
    const sequence = ++changelogSequence.current;
    setChangelogLoading(true);
    try {
      const data = await getSharedDeckChangelog(shareId, a, b);
      // Public changelogs identify their exact snapshots but omit the raw text.
      // Capture that returned pair, never the potentially edited selectors.
      const [before, after] = await Promise.all([
        getSharedDeckSnapshot(shareId, data.before.id),
        getSharedDeckSnapshot(shareId, data.after.id),
      ]);
      const beforeText = before.snapshot.deck_text, afterText = after.snapshot.deck_text;
      if (sequence !== changelogSequence.current) return;
      // Display and print the same fetched text even if a snapshot changed
      // between the metadata response and these two snapshot reads.
      setChangelog({ ...data, beforeText, afterText,
        diff: computeDiff(parse(beforeText), parse(afterText)) });
    } catch (err) {
      if (sequence === changelogSequence.current) toast.error(err.message);
    } finally {
      if (sequence === changelogSequence.current) setChangelogLoading(false);
    }
  }

  function handleViewChangelog() {
    return loadChangelog();
  }

  async function handleCompare() {
    if (!compareA || !compareB) return;
    await loadChangelog(compareA, compareB);
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
      <p className="eyebrow"><Icon name="connections" size={16} /> Shared with your pod</p>

      <div className="shared-deck-card">
        <div className="shared-deck-header">
          <h1 className="shared-deck-title">{deckName}</h1>
          <div className="shared-deck-meta">
            {commanders.length > 0 && (
              <span className="shared-deck-commanders">{commanders.join(' / ')}</span>
            )}
            <span className="shared-deck-owner">by {ownerUsername}</span>
            <span className="shared-deck-shared-date">Shared {formatDate(sharedAt)}</span>
          </div>
        </div>

        <div className="shared-deck-actions">
          <button className="btn btn-primary btn-sm" onClick={handleViewChangelog} disabled={changelogLoading} type="button">
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
            <button className="btn btn-primary btn-sm" onClick={handleCompare} disabled={!compareA || !compareB || changelogLoading} type="button">
              Compare
            </button>
          </div>
        )}

        {/* Changelog display */}
        {changelogLoading && <p role="status">Loading comparison and print details…</p>}
        {changelog && <SharedChangelogDisplay changelog={changelog} deckName={deckName} />}

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

function SharedChangelogDisplay({ changelog, deckName }) {
  const { diff } = changelog;
  const { mainboard, sideboard, hasSideboard } = diff;

  const { hasMainChanges, hasSideChanges, noChanges } = useMemo(() => {
    const hasMain =
      mainboard.cardsIn.length > 0 ||
      mainboard.cardsOut.length > 0 ||
      mainboard.quantityChanges.length > 0 ||
      (mainboard.printingChanges || []).length > 0;

    const hasSide = hasSideboard && (
      sideboard.cardsIn.length > 0 ||
      sideboard.cardsOut.length > 0 ||
      sideboard.quantityChanges.length > 0 ||
      (sideboard.printingChanges || []).length > 0
    );

    return { hasMainChanges: hasMain, hasSideChanges: hasSide, noChanges: !hasMain && !hasSide };
  }, [mainboard, sideboard, hasSideboard]);

  const diffResult = { mainboard, sideboard, hasSideboard, commanders: diff.commanders || [] };

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
        <PrintComparisonButton beforeText={changelog.beforeText} afterText={changelog.afterText} listName={`${deckName} comparison`} />
        {!noChanges && <>
          <CopyButton getText={() => formatChangelog(diffResult)} />
          <CopyButton getText={() => formatReddit(diffResult)} label="Copy for Reddit" className="copy-btn copy-btn--reddit" />
          <CopyButton getText={() => formatJSON(diffResult)} label="Copy JSON" className="copy-btn copy-btn--json" />
        </>}
      </div>
      {noChanges && <p className="shared-deck-empty">No changes detected.</p>}
      <div className="changelog-inline">
        {hasMainChanges && <SectionChangelog sectionName="Mainboard" changes={mainboard} />}
        {hasSideChanges && <SectionChangelog sectionName="Sideboard" changes={sideboard} />}
      </div>
    </div>
  );
}
