import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useAppSettings } from '../context/AppSettingsContext';
import { getDeckChangelog, getSnapshot } from '../lib/api';
import { parse } from '../lib/parser';
import { fetchCardData, collectCardIdentifiers } from '../lib/scryfall';
import { formatChangelog, formatMpcFill, formatReddit, formatJSON, formatForArchidekt, formatTTS } from '../lib/formatter';
import { estimatePowerLevel } from '../lib/powerLevel';
import SectionChangelog from './SectionChangelog';
import DeckListView from './DeckListView';
import CopyButton from './CopyButton';
import Skeleton from './Skeleton';
import { toast } from './Toast';
import './TimelineOverlay.css';

/** Trigger a file download in the browser. */
function downloadFile(content, filename, mimeType = 'application/json') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

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

export default function TimelineOverlay({ deckId, entry, prevSnapshotId, deckName, commanders, onClose }) {
  const { priceDisplayEnabled } = useAppSettings();
  const isBaseline = !prevSnapshotId;
  const [activeTab, setActiveTab] = useState(isBaseline ? 'deck' : 'changes');
  const [searchQuery, setSearchQuery] = useState('');

  // Changes tab state
  const [diffResult, setDiffResult] = useState(null);
  const [diffCardMap, setDiffCardMap] = useState(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [changelogTexts, setChangelogTexts] = useState(null); // { beforeText, afterText }

  // Full Deck tab state
  const [parsedDeck, setParsedDeck] = useState(null);
  const [deckCardMap, setDeckCardMap] = useState(null);
  const [deckLoading, setDeckLoading] = useState(false);
  const [deckText, setDeckText] = useState(null); // raw deck_text for export

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
      setChangelogTexts({ beforeText: data.before.deck_text, afterText: data.after.deck_text });
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
      const rawText = data.snapshot.deck_text;
      setDeckText(rawText);
      const parsed = parse(rawText);
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
  const { totalIn, totalOut, totalChanged, noChanges, hasAdditions } = useMemo(() => {
    if (!diffResult) return { totalIn: 0, totalOut: 0, totalChanged: 0, noChanges: true, hasAdditions: false };
    const mb = diffResult.mainboard;
    const sb = diffResult.sideboard;
    const totalIn = mb.cardsIn.length + sb.cardsIn.length;
    const totalOut = mb.cardsOut.length + sb.cardsOut.length;
    const totalChanged = mb.quantityChanges.length + sb.quantityChanges.length;
    const hasAdditions = totalIn > 0 ||
      [...mb.quantityChanges, ...sb.quantityChanges].some(c => c.delta > 0);
    return { totalIn, totalOut, totalChanged, noChanges: totalIn === 0 && totalOut === 0 && totalChanged === 0, hasAdditions };
  }, [diffResult]);

  // Price impact of changes
  const priceImpact = useMemo(() => {
    if (!priceDisplayEnabled || !diffResult || !diffCardMap || diffCardMap.size === 0) return null;
    let costIn = 0, costOut = 0, hasAny = false;

    function getCardPrice(card) {
      const nameLower = card.name.toLowerCase();
      const compositeKey = card.collectorNumber ? `${nameLower}|${card.collectorNumber}` : null;
      const data = (compositeKey && diffCardMap.get(compositeKey)) || diffCardMap.get(nameLower);
      if (!data) return null;
      const isFoil = card.isFoil || false;
      return isFoil && data.priceUsdFoil != null ? data.priceUsdFoil : data.priceUsd;
    }

    for (const section of [diffResult.mainboard, diffResult.sideboard]) {
      for (const card of section.cardsIn) {
        const p = getCardPrice(card);
        if (p != null) { costIn += p * card.quantity; hasAny = true; }
      }
      for (const card of section.cardsOut) {
        const p = getCardPrice(card);
        if (p != null) { costOut += p * card.quantity; hasAny = true; }
      }
      for (const card of section.quantityChanges) {
        const p = getCardPrice(card);
        if (p != null) {
          if (card.delta > 0) costIn += p * card.delta;
          else costOut += p * Math.abs(card.delta);
          hasAny = true;
        }
      }
    }

    if (!hasAny) return null;
    return { costIn, costOut, net: costIn - costOut };
  }, [diffResult, diffCardMap]);

  // Build diffResult wrapper for formatter functions
  const diffForExport = useMemo(() => {
    if (!diffResult) return null;
    return { mainboard: diffResult.mainboard, sideboard: diffResult.sideboard, hasSideboard: diffResult.hasSideboard, commanders: commanders || [] };
  }, [diffResult, commanders]);

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
            <button className="timeline-overlay-mobile-back" onClick={onClose} type="button" aria-label="Back">&larr;</button>
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

        {/* Search + Copy Buttons */}
        <div className="timeline-overlay-toolbar">
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

          {/* Copy buttons for Changes tab */}
          {activeTab === 'changes' && diffForExport && !noChanges && (
            <div className="timeline-overlay-buttons">
              {hasAdditions && (
                <CopyButton getText={() => formatMpcFill(diffForExport)} label="Copy for MPCFill" className="copy-btn copy-btn--mpc" />
              )}
              <CopyButton getText={() => formatChangelog(diffForExport, diffCardMap)} label="Copy Changelog" />
              {changelogTexts && (
                <CopyButton
                  getText={() => formatForArchidekt(changelogTexts.afterText, commanders || [], changelogTexts.beforeText)}
                  label="Copy for Archidekt"
                  className="copy-btn copy-btn--archidekt"
                />
              )}
              <CopyButton getText={() => formatReddit(diffForExport, diffCardMap)} label="Copy for Reddit" className="copy-btn copy-btn--reddit" />
              <CopyButton getText={() => formatJSON(diffForExport)} label="Copy JSON" className="copy-btn copy-btn--json" />
            </div>
          )}

          {/* Copy buttons for Full Deck tab */}
          {activeTab === 'deck' && deckText && (
            <div className="timeline-overlay-buttons">
              <CopyButton
                getText={() => formatForArchidekt(deckText, commanders || [])}
                label="Copy for Archidekt"
                className="copy-btn copy-btn--archidekt"
              />
              <CopyButton getText={() => deckText} label="Copy Deck Text" />
              {deckCardMap && deckCardMap.size > 0 && (
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  onClick={() => {
                    const json = formatTTS(deckText, deckCardMap, commanders || []);
                    if (json) {
                      const name = (commanders && commanders.length > 0 ? commanders[0] : 'deck').replace(/[^a-zA-Z0-9]/g, '_');
                      downloadFile(json, `${name}_TTS.json`);
                      toast.success('TTS deck file downloaded');
                    }
                  }}
                >
                  Download TTS
                </button>
              )}
            </div>
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
                    {priceImpact && (
                      <span className={`summary-badge summary-badge--price${priceImpact.net > 0 ? ' summary-badge--price-up' : priceImpact.net < 0 ? ' summary-badge--price-down' : ''}`}>
                        {priceImpact.net >= 0 ? '+' : ''}{priceImpact.net < 0 ? '\u2212' : ''}${Math.abs(priceImpact.net).toFixed(2)}
                      </span>
                    )}
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
              <>
                {deckCardMap && deckCardMap.size > 0 && (() => {
                  const pl = estimatePowerLevel(parsedDeck, deckCardMap);
                  if (pl.level === 0) return null;
                  return (
                    <div className="timeline-overlay-power-level">
                      <div className="power-level-header">
                        <span className={`power-level-badge power-level-badge--${pl.level}`}>{pl.level}</span>
                        <span className="power-level-label">{pl.label}</span>
                        <span className="power-level-scale">/ 10</span>
                      </div>
                      <div className="power-level-bar">
                        <div className="power-level-bar-fill" style={{ width: `${pl.level * 10}%` }} />
                      </div>
                      <div className="power-level-signals">
                        {pl.signals.map((s, i) => <span key={i} className="power-level-signal">{s}</span>)}
                      </div>
                    </div>
                  );
                })()}
                <DeckListView parsedDeck={parsedDeck} cardMap={deckCardMap} searchQuery={searchQuery} />
              </>
            ) : null
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
