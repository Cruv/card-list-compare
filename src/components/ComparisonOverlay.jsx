import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useAppSettings } from '../context/AppSettingsContext';
import { getDeckChangelog, getSnapshot, getDeckSnapshots } from '../lib/api';
import { parse } from '../lib/parser';
import { computeDiff } from '../lib/differ';
import { fetchCardData, collectCardIdentifiers } from '../lib/scryfall';
import { formatChangelog, formatMpcFill, formatReddit, formatJSON, formatForArchidekt } from '../lib/formatter';
import SectionChangelog from './SectionChangelog';
import ManaCurveDelta from './ManaCurveDelta';
import ColorDistributionDelta from './ColorDistributionDelta';
import CopyButton from './CopyButton';
import Skeleton from './Skeleton';
import { toast } from './Toast';
import './ComparisonOverlay.css';

function filterSection(section, query) {
  if (!query) return section;
  const lower = query.toLowerCase();
  return {
    cardsIn: section.cardsIn.filter(c => c.name.toLowerCase().includes(lower)),
    cardsOut: section.cardsOut.filter(c => c.name.toLowerCase().includes(lower)),
    quantityChanges: section.quantityChanges.filter(c => c.name.toLowerCase().includes(lower)),
    printingChanges: (section.printingChanges || []).filter(c => c.name.toLowerCase().includes(lower)),
    totalUniqueCards: section.totalUniqueCards,
    unchangedCount: section.unchangedCount,
  };
}

/**
 * ComparisonOverlay — inline diff overlay for comparing two snapshots.
 *
 * Two modes:
 * 1. Same-deck: pass beforeSnapshotId + afterSnapshotId (uses getDeckChangelog)
 * 2. Cross-deck: pass beforeDeckId + afterDeckId (fetches latest snapshots, parses + diffs client-side)
 *
 * Props:
 *   beforeDeckId, afterDeckId — required (may be the same deck)
 *   beforeSnapshotId, afterSnapshotId — optional (when comparing specific snapshots of the same deck)
 *   deckName — display title
 *   commanders — array of commander names (for Archidekt export)
 *   onClose — callback
 */
export default function ComparisonOverlay({
  beforeDeckId,
  afterDeckId,
  beforeSnapshotId,
  afterSnapshotId,
  deckName,
  commanders,
  onClose,
}) {
  const { priceDisplayEnabled } = useAppSettings();
  const [loading, setLoading] = useState(true);
  const [diffResult, setDiffResult] = useState(null);
  const [cardMap, setCardMap] = useState(null);
  const [changelogTexts, setChangelogTexts] = useState(null); // { beforeText, afterText }
  const [searchQuery, setSearchQuery] = useState('');

  const isSameDeck = beforeDeckId === afterDeckId;

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

  // Load comparison data
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        let diff, beforeText, afterText;

        if (isSameDeck && beforeSnapshotId && afterSnapshotId) {
          // Same-deck comparison via server changelog endpoint
          const data = await getDeckChangelog(beforeDeckId, beforeSnapshotId, afterSnapshotId);
          diff = data.diff;
          beforeText = data.before.deck_text;
          afterText = data.after.deck_text;
        } else if (isSameDeck && !beforeSnapshotId && !afterSnapshotId) {
          // Same-deck, no specific snapshots — get latest changelog
          const data = await getDeckChangelog(beforeDeckId);
          diff = data.diff;
          beforeText = data.before.deck_text;
          afterText = data.after.deck_text;
        } else {
          // Cross-deck comparison — fetch both decks' latest snapshots and diff client-side
          const [snapA, snapB] = await Promise.all([
            beforeSnapshotId
              ? getSnapshot(beforeDeckId, beforeSnapshotId).then(d => d.snapshot)
              : getDeckSnapshots(beforeDeckId).then(async d => {
                  if (!d.snapshots.length) throw new Error('No snapshots for first deck');
                  return (await getSnapshot(beforeDeckId, d.snapshots[0].id)).snapshot;
                }),
            afterSnapshotId
              ? getSnapshot(afterDeckId, afterSnapshotId).then(d => d.snapshot)
              : getDeckSnapshots(afterDeckId).then(async d => {
                  if (!d.snapshots.length) throw new Error('No snapshots for second deck');
                  return (await getSnapshot(afterDeckId, d.snapshots[0].id)).snapshot;
                }),
          ]);

          beforeText = snapA.deck_text;
          afterText = snapB.deck_text;

          const parsedBefore = parse(beforeText);
          const parsedAfter = parse(afterText);
          diff = computeDiff(parsedBefore, parsedAfter);
        }

        if (cancelled) return;

        setDiffResult(diff);
        setChangelogTexts({ beforeText, afterText });

        // Fetch card data for images and mana costs
        const identifiers = collectCardIdentifiers(diff);
        if (identifiers.size > 0) {
          const cm = await fetchCardData(identifiers);
          if (!cancelled) setCardMap(cm);
        }
      } catch (err) {
        if (!cancelled) {
          toast.error(err.message || 'Failed to load comparison');
          console.error('ComparisonOverlay error:', err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [beforeDeckId, afterDeckId, beforeSnapshotId, afterSnapshotId, isSameDeck]);

  // Filtered sections
  const filteredMainboard = useMemo(
    () => diffResult ? filterSection(diffResult.mainboard, searchQuery) : null,
    [diffResult, searchQuery]
  );
  const filteredSideboard = useMemo(
    () => diffResult ? filterSection(diffResult.sideboard, searchQuery) : null,
    [diffResult, searchQuery]
  );

  // Summary stats
  const { totalIn, totalOut, totalChanged, totalPrinting, noChanges, hasAdditions } = useMemo(() => {
    if (!diffResult) return { totalIn: 0, totalOut: 0, totalChanged: 0, totalPrinting: 0, noChanges: true, hasAdditions: false };
    const mb = diffResult.mainboard;
    const sb = diffResult.sideboard;
    const tIn = mb.cardsIn.length + sb.cardsIn.length;
    const tOut = mb.cardsOut.length + sb.cardsOut.length;
    const tChanged = mb.quantityChanges.length + sb.quantityChanges.length;
    const tPrinting = (mb.printingChanges || []).length + (sb.printingChanges || []).length;
    const additions = tIn > 0 ||
      [...mb.quantityChanges, ...sb.quantityChanges].some(c => c.delta > 0);
    return { totalIn: tIn, totalOut: tOut, totalChanged: tChanged, totalPrinting: tPrinting, noChanges: tIn === 0 && tOut === 0 && tChanged === 0 && tPrinting === 0, hasAdditions: additions };
  }, [diffResult]);

  // Price impact
  const priceImpact = useMemo(() => {
    if (!priceDisplayEnabled || !diffResult || !cardMap || cardMap.size === 0) return null;
    let costIn = 0, costOut = 0, budgetCostIn = 0, budgetCostOut = 0, hasAny = false;

    function getCardPrice(card) {
      const nameLower = card.name.toLowerCase();
      const compositeKey = card.collectorNumber ? `${nameLower}|${card.collectorNumber}` : null;
      const data = (compositeKey && cardMap.get(compositeKey)) || cardMap.get(nameLower);
      if (!data) return null;
      const isFoil = card.isFoil || false;
      return isFoil && data.priceUsdFoil != null ? data.priceUsdFoil : data.priceUsd;
    }

    function getCheapestPrice(card) {
      const bareData = cardMap.get(card.name.toLowerCase());
      if (!bareData) return null;
      const isFoil = card.isFoil || false;
      return isFoil && bareData.priceUsdFoil != null ? bareData.priceUsdFoil : bareData.priceUsd;
    }

    for (const section of [diffResult.mainboard, diffResult.sideboard]) {
      for (const card of section.cardsIn) {
        const p = getCardPrice(card);
        const cp = getCheapestPrice(card);
        if (p != null) { costIn += p * card.quantity; hasAny = true; }
        if (cp != null) { budgetCostIn += cp * card.quantity; }
      }
      for (const card of section.cardsOut) {
        const p = getCardPrice(card);
        const cp = getCheapestPrice(card);
        if (p != null) { costOut += p * card.quantity; hasAny = true; }
        if (cp != null) { budgetCostOut += cp * card.quantity; }
      }
      for (const card of section.quantityChanges) {
        const p = getCardPrice(card);
        const cp = getCheapestPrice(card);
        if (p != null) {
          if (card.delta > 0) costIn += p * card.delta;
          else costOut += p * Math.abs(card.delta);
          hasAny = true;
        }
        if (cp != null) {
          if (card.delta > 0) budgetCostIn += cp * card.delta;
          else budgetCostOut += cp * Math.abs(card.delta);
        }
      }
    }

    if (!hasAny) return null;
    const net = costIn - costOut;
    const budgetNet = budgetCostIn - budgetCostOut;
    return { costIn, costOut, net, budgetNet, hasBudgetDiff: Math.abs(budgetNet - net) >= 0.01 };
  }, [diffResult, cardMap]);

  // Export wrapper
  const diffForExport = useMemo(() => {
    if (!diffResult) return null;
    return { mainboard: diffResult.mainboard, sideboard: diffResult.sideboard, hasSideboard: diffResult.hasSideboard, commanders: commanders || [] };
  }, [diffResult, commanders]);

  return createPortal(
    <div className="comparison-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Deck comparison">
      <div className="comparison-overlay-panel" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="comparison-overlay-header">
          <div className="comparison-overlay-title-row">
            <button className="comparison-overlay-mobile-back" onClick={onClose} type="button" aria-label="Back">&larr;</button>
            <h2 className="comparison-overlay-title">{deckName || 'Deck Comparison'}</h2>
            <button className="comparison-overlay-close" onClick={onClose} type="button" aria-label="Close">&times;</button>
          </div>
        </div>

        {/* Toolbar: search + copy buttons */}
        {!loading && diffResult && !noChanges && (
          <div className="comparison-overlay-toolbar">
            <div className="comparison-overlay-search">
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
            <div className="comparison-overlay-buttons">
              {hasAdditions && (
                <CopyButton getText={() => formatMpcFill(diffForExport)} label="Copy for MPCFill" className="copy-btn copy-btn--mpc" />
              )}
              <CopyButton getText={() => formatChangelog(diffForExport, cardMap)} label="Copy Changelog" />
              {changelogTexts && (
                <CopyButton
                  getText={() => formatForArchidekt(changelogTexts.afterText, commanders || [], changelogTexts.beforeText)}
                  label="Copy for Archidekt"
                  className="copy-btn copy-btn--archidekt"
                />
              )}
              <CopyButton getText={() => formatReddit(diffForExport, cardMap)} label="Copy for Reddit" className="copy-btn copy-btn--reddit" />
              <CopyButton getText={() => formatJSON(diffForExport)} label="Copy JSON" className="copy-btn copy-btn--json" />
            </div>
          </div>
        )}

        {/* Content */}
        <div className="comparison-overlay-content">
          {loading ? (
            <Skeleton lines={8} />
          ) : !diffResult ? (
            <p className="comparison-overlay-empty">Failed to load comparison data.</p>
          ) : noChanges ? (
            <p className="comparison-overlay-empty">No changes detected between these snapshots.</p>
          ) : (
            <>
              <div className="comparison-overlay-summary">
                {totalIn > 0 && <span className="summary-badge summary-badge--in">+{totalIn} in</span>}
                {totalOut > 0 && <span className="summary-badge summary-badge--out">-{totalOut} out</span>}
                {totalChanged > 0 && <span className="summary-badge summary-badge--changed">~{totalChanged} changed</span>}
                {totalPrinting > 0 && <span className="summary-badge summary-badge--printing">&#8635;{totalPrinting} reprinted</span>}
                {priceImpact && (
                  <span className={`summary-badge summary-badge--price${priceImpact.net > 0 ? ' summary-badge--price-up' : priceImpact.net < 0 ? ' summary-badge--price-down' : ''}`}>
                    {priceImpact.net >= 0 ? '+' : ''}{priceImpact.net < 0 ? '\u2212' : ''}${Math.abs(priceImpact.net).toFixed(2)}
                    {priceImpact.hasBudgetDiff && (
                      <span className="summary-badge-budget"> ({priceImpact.budgetNet >= 0 ? '+' : ''}{priceImpact.budgetNet < 0 ? '\u2212' : ''}${Math.abs(priceImpact.budgetNet).toFixed(2)})</span>
                    )}
                  </span>
                )}
              </div>
              {priceImpact && (
                <div className="comparison-price-detail">
                  <span className="comparison-price-in">+${priceImpact.costIn.toFixed(2)} added</span>
                  <span className="comparison-price-divider">/</span>
                  <span className="comparison-price-out">&minus;${priceImpact.costOut.toFixed(2)} removed</span>
                </div>
              )}
              <ManaCurveDelta diffResult={diffResult} cardMap={cardMap} />
              <ColorDistributionDelta diffResult={diffResult} cardMap={cardMap} />
              <SectionChangelog sectionName="Mainboard" changes={filteredMainboard} cardMap={cardMap} />
              {diffResult.hasSideboard && (
                <SectionChangelog sectionName="Sideboard" changes={filteredSideboard} cardMap={cardMap} />
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
