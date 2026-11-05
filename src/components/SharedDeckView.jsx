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
import ActionMenu from './ActionMenu';
import DeckListView from './DeckListView';
import { collectDeckIdentifiers, fetchCardData } from '../lib/scryfall';
import './SharedDeckView.css';

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export default function SharedDeckView({ shareId }) {
  const [deckData, setDeckData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('cards');
  const [changelog, setChangelog] = useState(null);
  const [changelogLoading, setChangelogLoading] = useState(false);
  const changelogSequence = useRef(0);
  const invalidateChangelog = useCallback(() => { ++changelogSequence.current; }, []);
  const [compareA, setCompareA] = useState('');
  const [compareB, setCompareB] = useState('');
  const [viewingSnapshot, setViewingSnapshot] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState(null);
  const [snapshotRetry, setSnapshotRetry] = useState(0);

  useEffect(() => {
    let active = true;
    invalidateChangelog();
    setChangelog(null);
    setChangelogLoading(false);
    setActiveTab('cards');
    setViewingSnapshot(null);
    setSnapshot(null);
    setDeckData(null);
    setLoading(true);
    setError(null);
    getSharedDeck(shareId)
      .then(data => {
        if (!active) return;
        setDeckData(data);
        setCompareA(String(data.snapshots[1]?.id || ''));
        setCompareB(String(data.snapshots[0]?.id || ''));
        setViewingSnapshot(data.snapshots[0]?.id || null);
      })
      .catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; invalidateChangelog(); };
  }, [shareId, invalidateChangelog]);

  // The selected saved text, card metadata, exports and print action move together.
  // An older request cannot replace the version selected while it was loading.
  useEffect(() => {
    if (!viewingSnapshot) return;
    let active = true;
    setSnapshotLoading(true);
    setSnapshotError(null);
    getSharedDeckSnapshot(shareId, viewingSnapshot).then(async data => {
      const text = data.snapshot.deck_text;
      const parsed = parse(text);
      let cardMap = new Map();
      try { cardMap = await fetchCardData(collectDeckIdentifiers(parsed)); } catch { /* Saved text remains usable without artwork. */ }
      if (active) setSnapshot({ id: viewingSnapshot, text, parsed, cardMap });
    }).catch(err => { if (active) setSnapshotError(err.message); })
      .finally(() => { if (active) setSnapshotLoading(false); });
    return () => { active = false; };
  }, [shareId, viewingSnapshot, snapshotRetry]);

  const loadChangelog = useCallback(async (a, b) => {
    const sequence = ++changelogSequence.current;
    setCompareA(String(a));
    setCompareB(String(b));
    setChangelogLoading(true);
    try {
      const data = await getSharedDeckChangelog(shareId, a, b);
      // Use the returned pair, never selectors that may have changed in flight.
      const [before, after] = await Promise.all([
        getSharedDeckSnapshot(shareId, data.before.id),
        getSharedDeckSnapshot(shareId, data.after.id),
      ]);
      const beforeText = before.snapshot.deck_text, afterText = after.snapshot.deck_text;
      if (sequence !== changelogSequence.current) return;
      setChangelog({ ...data, beforeText, afterText,
        diff: computeDiff(parse(beforeText), parse(afterText)) });
    } catch (err) {
      if (sequence === changelogSequence.current) toast.error(err.message);
    } finally {
      if (sequence === changelogSequence.current) setChangelogLoading(false);
    }
  }, [shareId]);

  function openChanges() {
    setActiveTab('changes');
    if (!changelog && !changelogLoading && deckData.snapshots.length > 1) {
      void loadChangelog(deckData.snapshots[1].id, deckData.snapshots[0].id);
    }
  }

  if (loading) return <div className="shared-deck-page"><Skeleton lines={8} /></div>;
  if (error) return <div className="shared-deck-page"><div className="shared-deck-error">
    <h2>Shared deck not found</h2><p>{error}</p><a href="#compare" className="btn btn-primary">Back to Compare</a>
  </div></div>;

  const { deckName, commanders, ownerUsername, sharedAt, snapshots } = deckData;
  const selectedVersion = snapshots.find(item => item.id === viewingSnapshot);
  const isLatest = viewingSnapshot === snapshots[0]?.id;
  const readySnapshot = !snapshotLoading && !snapshotError && snapshot?.id === viewingSnapshot;

  return <div className="shared-deck-page">
    <p className="eyebrow"><Icon name="connections" size={16} /> Shared with your pod</p>
    <div className="shared-deck-card">
      <header className="shared-deck-header">
        <h1 className="shared-deck-title">{deckName}</h1>
        <div className="shared-deck-meta">
          {commanders.length > 0 && <span className="shared-deck-commanders">{commanders.join(' / ')}</span>}
          <span className="shared-deck-owner">by {ownerUsername}</span>
          <span className="shared-deck-shared-date">Shared {formatDate(sharedAt)} · View only</span>
        </div>
      </header>
      <div className="shared-deck-actions">
        <CopyButton getText={() => `${window.location.origin}${window.location.pathname}#deck/${shareId}`} label="Copy share link" />
        {deckData.deckUrl && <a href={deckData.deckUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm">Open source</a>}
      </div>
      <nav className="shared-deck-tabs" aria-label="Shared deck sections">
        <button type="button" onClick={() => setActiveTab('cards')} aria-current={activeTab === 'cards' ? 'page' : undefined}>Cards</button>
        <button type="button" onClick={openChanges} aria-current={activeTab === 'changes' ? 'page' : undefined}>Changes</button>
      </nav>
      {activeTab === 'cards' && <section className="shared-deck-cards">
        <div className="shared-version-heading"><div><h2>{isLatest ? 'Latest saved version' : 'Saved version'}</h2>
          <p>{selectedVersion ? `${selectedVersion.nickname || formatDate(selectedVersion.created_at)} · Printings saved with this version` : 'No saved versions yet.'}</p></div>
          {!isLatest && snapshots[0] && <button type="button" className="btn btn-secondary" onClick={() => setViewingSnapshot(snapshots[0].id)}>Back to latest</button>}
        </div>
        {snapshotLoading && <Skeleton lines={8} />}
        {snapshotError && <div role="alert"><p>{snapshotError}</p><button className="btn btn-secondary" type="button" onClick={() => setSnapshotRetry(value => value + 1)}>Retry loading cards</button></div>}
        {readySnapshot && <>
          <div className="shared-deck-actions">
            <PrintComparisonButton beforeText="" afterText={snapshot.text} mode="full" listName={deckName} />
            <ActionMenu label="Export" ariaLabel="Export saved cards"><CopyButton getText={() => snapshot.text} label="Copy deck text" /></ActionMenu>
          </div>
          <DeckListView key={snapshot.id} parsedDeck={snapshot.parsed} cardMap={snapshot.cardMap} commanders={commanders} />
          <details className="shared-raw-text"><summary>Deck text</summary><pre>{snapshot.text}</pre></details>
        </>}
      </section>}
      {activeTab === 'changes' && <section>
        <div className="shared-version-heading"><div><h2>Compare saved versions</h2><p>Compare the cards and printings in any two versions.</p></div>
          {snapshots.length > 1 && <button className="btn btn-secondary" type="button" disabled={changelogLoading} onClick={() => loadChangelog(snapshots[1].id, snapshots[0].id)}>Latest update</button>}
        </div>
        {snapshots.length >= 2 ? <form className="shared-deck-compare" onSubmit={event => { event.preventDefault(); if (compareA && compareB) void loadChangelog(compareA, compareB); }}>
          <label>Before<select value={compareA} onChange={event => setCompareA(event.target.value)} aria-label="Select older version">
            {snapshots.map(version => <option key={version.id} value={version.id}>{version.nickname || formatDate(version.created_at)}</option>)}
          </select></label>
          <label>After<select value={compareB} onChange={event => setCompareB(event.target.value)} aria-label="Select newer version">
            {snapshots.map(version => <option key={version.id} value={version.id}>{version.nickname || formatDate(version.created_at)}</option>)}
          </select></label>
          <button className="btn btn-primary" disabled={!compareA || !compareB || changelogLoading} type="submit">{changelogLoading ? 'Comparing…' : 'Compare versions'}</button>
        </form> : <p className="shared-deck-empty">A second saved version is needed to compare changes.</p>}
        {changelogLoading && <p role="status">Loading the comparison…</p>}
        {changelog && <SharedChangelogDisplay changelog={changelog} deckName={deckName} />}
        <h2 className="shared-deck-section-title">Version history</h2>
        {snapshots.length === 0 ? <p className="shared-deck-empty">No saved versions yet.</p> : <ul className="shared-deck-snap-list">
          {snapshots.map(version => <li key={version.id} className="shared-deck-snap">
            <div className="shared-deck-snap-info"><span className="shared-deck-snap-date">{formatDate(version.created_at)}</span>
              {version.nickname && <strong className="shared-deck-snap-nick">{version.nickname}</strong>}
              <span className="shared-deck-snap-count">{version.cardCount} cards</span>
            </div>
            <button className="btn btn-secondary" type="button" onClick={() => { setViewingSnapshot(version.id); setActiveTab('cards'); }}>View version</button>
          </li>)}
        </ul>}
      </section>}
    </div>
  </div>;
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
    const d = snap.created_at ? new Date(snap.created_at + (snap.created_at.endsWith('Z') ? '' : 'Z')).toLocaleString() : '';
    return snap.nickname ? `${snap.nickname} (${d})` : d;
  }

  return (
    <div className="shared-deck-changelog">
      <div className="shared-deck-changelog-header">
        <strong>Changes:</strong> {formatSnapLabel(changelog.before)} &rarr; {formatSnapLabel(changelog.after)}
      </div>
      <div className="shared-deck-changelog-copy">
        <PrintComparisonButton beforeText={changelog.beforeText} afterText={changelog.afterText} listName={`${deckName} comparison`} />
        {!noChanges && <>
          <CopyButton getText={() => formatChangelog(diffResult)} label="Copy changes" />
          <ActionMenu label="Export" ariaLabel="Export comparison">
          <CopyButton getText={() => formatReddit(diffResult)} label="Copy for Reddit" className="copy-btn copy-btn--reddit" />
          <CopyButton getText={() => formatJSON(diffResult)} label="Copy JSON" className="copy-btn copy-btn--json" />
          </ActionMenu>
        </>}
      </div>
      {noChanges && <p className="shared-deck-empty">These versions have the same cards and printings.</p>}
      <div className="changelog-inline">
        {hasMainChanges && <SectionChangelog sectionName="Mainboard" changes={mainboard} />}
        {hasSideChanges && <SectionChangelog sectionName="Sideboard" changes={sideboard} />}
      </div>
    </div>
  );
}
