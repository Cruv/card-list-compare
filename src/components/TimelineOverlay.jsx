import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { getDeckChangelog, getSnapshot } from '../lib/api';
import { parse } from '../lib/parser';
import { fetchCardData, collectCardIdentifiers } from '../lib/scryfall';
import SectionChangelog from './SectionChangelog';
import DeckListView from './DeckListView';
import Skeleton from './Skeleton';
import { toast } from './Toast';
import './TimelineOverlay.css';

/** Build Scryfall identifier map from a parsed deck (same pattern as collectCardIdentifiers but for Map entries). */
function collectDeckIdentifiers(parsedDeck) {
  const identifiers = new Map();
  for (const section of [parsedDeck.mainboard, parsedDeck.sideboard]) {
    for (const [, entry] of section) {
      const nameLower = entry.displayName.toLowerCase();
      if (entry.setCode && entry.collectorNumber) {
        const compositeKey = `${nameLower}|${entry.collectorNumber}`;
        if (!identifiers.has(compositeKey)) {
          identifiers.set(compositeKey, {
            name: entry.displayName,
            set: entry.setCode.toLowerCase(),
            collector_number: entry.collectorNumber,
          });
        }
      }
      if (!identifiers.has(nameLower)) {
        identifiers.set(nameLower, { name: entry.displayName });
      }
    }
  }
  return identifiers;
}

function filterSection(section, query) {
  if (!query) return section;
  const lower = query.toLowerCase();
  return {
    cardsIn: section.cardsIn.filter(c => c.name.toLowerCase().includes(lower)),
    cardsOut: section.cardsOut.filter(c => c.name.toLowerCase().includes(lower)),
    quantityChanges: section.quantityChanges.filter(c => c.name.toLowerCase().includes(lower)),
    totalUniqueCards: section.totalUniqueCards,
    unchangedCount: section.unchangedCount,
  };
}

export default function TimelineOverlay({ deckId, entry, prevSnapshotId, deckName, onClose }) {
  const isBaseline = !prevSnapshotId;
  const [activeTab, setActiveTab] = useState(isBaseline ? 'deck' : 'changes');
  const [searchQuery, setSearchQuery] = useState('');

  // Changes tab state
  const [diffResult, setDiffResult] = useState(null);
  const [diffCardMap, setDiffCardMap] = useState(null);
  const [diffLoading, setDiffLoading] = useState(false);

  // Full Deck tab state
  const [parsedDeck, setParsedDeck] = useState(null);
  const [deckCardMap, setDeckCardMap] = useState(null);
  const [deckLoading, setDeckLoading] = useState(false);

  // Escape to close
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Prevent body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Load changes data
  const loadChanges = useCallback(async () => {
    if (isBaseline || diffResult) return;
    setDiffLoading(true);
    try {
      const data = await getDeckChangelog(deckId, prevSnapshotId, entry.snapshotId);
      setDiffResult(data.diff);
      const identifiers = collectCardIdentifiers(data.diff);
      if (identifiers.size > 0) {
        const cardMap = await fetchCardData(identifiers);
        setDiffCardMap(cardMap);
      }
    } catch (err) {
      toast.error('Failed to load changelog');
    } finally {
      setDiffLoading(false);
    }
  }, [deckId, entry.snapshotId, prevSnapshotId, isBaseline, diffResult]);

  // Load full deck data
  const loadDeck = useCallback(async () => {
    if (parsedDeck) return;
    setDeckLoading(true);
    try {
      const data = await getSnapshot(deckId, entry.snapshotId);
      const parsed = parse(data.snapshot.deck_text);
      setParsedDeck(parsed);
      const identifiers = collectDeckIdentifiers(parsed);
      if (identifiers.size > 0) {
        const cardMap = await fetchCardData(identifiers);
        setDeckCardMap(cardMap);
      }
    } catch (err) {
      toast.error('Failed to load deck');
    } finally {
      setDeckLoading(false);
    }
  }, [deckId, entry.snapshotId, parsedDeck]);

  // Trigger data loading when tab changes
  useEffect(() => {
    if (activeTab === 'changes' && !isBaseline) {
      loadChanges();
    } else if (activeTab === 'deck') {
      loadDeck();
    }
  }, [activeTab, loadChanges, loadDeck, isBaseline]);

  // Filtered sections for search (changes tab)
  const filteredMainboard = useMemo(
    () => diffResult ? filterSection(diffResult.mainboard, searchQuery) : null,
    [diffResult, searchQuery]
  );
  const filteredSideboard = useMemo(
    () => diffResult ? filterSection(diffResult.sideboard, searchQuery) : null,
    [diffResult, searchQuery]
  );

  // Summary stats
  const { totalIn, totalOut, totalChanged, noChanges } = useMemo(() => {
    if (!diffResult) return { totalIn: 0, totalOut: 0, totalChanged: 0, noChanges: true };
    const mb = diffResult.mainboard;
    const sb = diffResult.sideboard;
    const totalIn = mb.cardsIn.length + sb.cardsIn.length;
    const totalOut = mb.cardsOut.length + sb.cardsOut.length;
    const totalChanged = mb.quantityChanges.length + sb.quantityChanges.length;
    return { totalIn, totalOut, totalChanged, noChanges: totalIn === 0 && totalOut === 0 && totalChanged === 0 };
  }, [diffResult]);

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso + 'Z').toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  }

  return createPortal(
    <div className="timeline-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Snapshot details">
      <div className="timeline-overlay-panel" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="timeline-overlay-header">
          <div className="timeline-overlay-title-row">
            <h2 className="timeline-overlay-title">{deckName}</h2>
            <button className="timeline-overlay-close" onClick={onClose} type="button" aria-label="Close">&times;</button>
          </div>
          <div className="timeline-overlay-meta">
            <span className="timeline-overlay-date">{formatDate(entry.date)}</span>
            {entry.nickname && <span className="timeline-overlay-nick">{entry.nickname}</span>}
            {entry.locked && <span title="Locked">{'\uD83D\uDD12'}</span>}
            <span className="timeline-overlay-count">{entry.cardCount} cards</span>
            {entry.delta && (
              <span className="timeline-overlay-delta">
                {entry.delta.added > 0 && <span className="delta-add">+{entry.delta.added}</span>}
                {entry.delta.removed > 0 && <span className="delta-remove">-{entry.delta.removed}</span>}
                {entry.delta.changed > 0 && <span className="delta-change">~{entry.delta.changed}</span>}
              </span>
            )}
            {isBaseline && <span className="timeline-overlay-baseline">Baseline</span>}
          </div>
        </div>

        {/* Tabs */}
        <div className="timeline-overlay-tabs">
          <button
            className={`timeline-overlay-tab${activeTab === 'changes' ? ' timeline-overlay-tab--active' : ''}`}
            onClick={() => setActiveTab('changes')}
            type="button"
          >
            Changes
            {!isBaseline && diffResult && !noChanges && (
              <span className="timeline-overlay-tab-badge">
                {totalIn + totalOut + totalChanged}
              </span>
            )}
          </button>
          <button
            className={`timeline-overlay-tab${activeTab === 'deck' ? ' timeline-overlay-tab--active' : ''}`}
            onClick={() => setActiveTab('deck')}
            type="button"
          >
            Full Deck
            <span className="timeline-overlay-tab-badge">{entry.cardCount}</span>
          </button>
        </div>

        {/* Search */}
        <div className="timeline-overlay-search">
          <input
            type="text"
            className="changelog-search-input"
            placeholder="Filter cards by name..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            aria-label="Filter cards"
          />
          {searchQuery && (
            <button
              type="button"
              className="changelog-search-clear"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
            >
              &times;
            </button>
          )}
        </div>

        {/* Content */}
        <div className="timeline-overlay-content">
          {activeTab === 'changes' && (
            isBaseline ? (
              <p className="timeline-overlay-empty">Baseline snapshot — no previous version to compare.</p>
            ) : diffLoading ? (
              <Skeleton lines={8} />
            ) : diffResult ? (
              noChanges ? (
                <p className="timeline-overlay-empty">No changes detected from previous snapshot.</p>
              ) : (
                <>
                  <div className="timeline-overlay-summary">
                    {totalIn > 0 && <span className="summary-badge summary-badge--in">+{totalIn} in</span>}
                    {totalOut > 0 && <span className="summary-badge summary-badge--out">-{totalOut} out</span>}
                    {totalChanged > 0 && <span className="summary-badge summary-badge--changed">~{totalChanged} changed</span>}
                  </div>
                  <SectionChangelog sectionName="Mainboard" changes={filteredMainboard} cardMap={diffCardMap} />
                  {diffResult.hasSideboard && (
                    <SectionChangelog sectionName="Sideboard" changes={filteredSideboard} cardMap={diffCardMap} />
                  )}
                </>
              )
            ) : null
          )}

          {activeTab === 'deck' && (
            deckLoading ? (
              <Skeleton lines={12} />
            ) : parsedDeck ? (
              <DeckListView parsedDeck={parsedDeck} cardMap={deckCardMap} searchQuery={searchQuery} />
            ) : null
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
