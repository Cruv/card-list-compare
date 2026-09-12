import { useState, useMemo, useCallback } from 'react';
import SectionChangelog from './SectionChangelog';
import CopyButton from './CopyButton';
import PrintComparisonButton from './PrintComparisonButton';
import Icon from './Icon';
import ActionMenu from './ActionMenu';
import { formatChangelog, formatMpcFill, formatReddit, formatJSON, formatForArchidekt, formatTTS } from '../lib/formatter';
import { DECKCHECK_POWER_URL } from '../lib/deckcheck';
import { toast } from './Toast';
import './ChangelogOutput.css';

/**
 * Filter a section's cards by search query (case-insensitive name match).
 */
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

export default function ChangelogOutput({ diffResult, cardMap, onShare, afterText, beforeText }) {
  const { mainboard, sideboard, hasSideboard, commanders } = diffResult;
  const [searchQuery, setSearchQuery] = useState('');

  const { totalIn, totalOut, totalChanged, totalPrinting, noChanges, hasAdditions, commanderLabel, unchangedPct } = useMemo(() => {
    const totalIn = mainboard.cardsIn.length + sideboard.cardsIn.length;
    const totalOut = mainboard.cardsOut.length + sideboard.cardsOut.length;
    const totalChanged = mainboard.quantityChanges.length + sideboard.quantityChanges.length;
    const totalPrinting = (mainboard.printingChanges || []).length + (sideboard.printingChanges || []).length;
    const noChanges = totalIn === 0 && totalOut === 0 && totalChanged === 0 && totalPrinting === 0;
    const hasAdditions = totalIn > 0 ||
      [...mainboard.quantityChanges, ...sideboard.quantityChanges].some((c) => c.delta > 0);
    const commanderLabel = commanders && commanders.length > 0
      ? commanders.join(' / ')
      : null;

    // Compute unchanged percentage
    const totalUnique = (mainboard.totalUniqueCards || 0) + (sideboard.totalUniqueCards || 0);
    const totalUnchanged = (mainboard.unchangedCount || 0) + (sideboard.unchangedCount || 0);
    const unchangedPct = totalUnique > 0 ? Math.round((totalUnchanged / totalUnique) * 100) : 0;

    return { totalIn, totalOut, totalChanged, totalPrinting, noChanges, hasAdditions, commanderLabel, unchangedPct };
  }, [mainboard, sideboard, commanders]);

  // Filtered sections for search
  const filteredMainboard = useMemo(() => filterSection(mainboard, searchQuery), [mainboard, searchQuery]);
  const filteredSideboard = useMemo(() => filterSection(sideboard, searchQuery), [sideboard, searchQuery]);

  const handleSearchChange = useCallback((e) => {
    setSearchQuery(e.target.value);
  }, []);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
  }, []);

  return (
    <div className="changelog-output" aria-label="Comparison results">
      <div className="changelog-output-header">
        <div className="changelog-output-heading">
        <h2 className="changelog-output-title">Changes</h2>
        {commanderLabel && (
          <p className="changelog-output-commander">{commanderLabel}</p>
        )}
        </div>
        <div className="changelog-output-buttons">
          <PrintComparisonButton beforeText={beforeText} afterText={afterText}
            listName={commanderLabel ? `${commanderLabel} comparison` : 'Compared lists'} />
          {!noChanges && <CopyButton getText={() => formatChangelog(diffResult, cardMap)} label="Copy changes" />}
          <ExportMenu
            diffResult={diffResult}
            cardMap={cardMap}
            afterText={afterText}
            beforeText={beforeText}
            hasAdditions={hasAdditions}
            noChanges={noChanges}
            onShare={onShare}
            commanders={commanders}
          />
        </div>
      </div>

      {!noChanges && <div className="changelog-output-summary" aria-label="Change summary">
        <div className="changelog-stat changelog-stat--in"><strong>{totalIn}</strong><span>Added</span></div>
        <div className="changelog-stat changelog-stat--out"><strong>{totalOut}</strong><span>Removed</span></div>
        <div className="changelog-stat changelog-stat--changed"><strong>{totalChanged}</strong><span>Quantity</span></div>
        <div className="changelog-stat changelog-stat--printing"><strong>{totalPrinting}</strong><span>Edition / finish</span></div>
      </div>}
      {!noChanges && <p className="changelog-output-export-note">{unchangedPct}% of unique cards unchanged</p>}

      {noChanges ? (
        <div className="changelog-output-identical"><Icon name="check" size={28} /><p>Lists are identical — no changes detected.</p><span>You can still print the complete After list.</span></div>
      ) : (
        <div className="changelog-output-body">
          <div className="changelog-search">
            <Icon name="search" size={18} />
            <input
              type="text"
              className="changelog-search-input"
              placeholder="Filter cards by name..."
              value={searchQuery}
              onChange={handleSearchChange}
              aria-label="Filter cards"
            />
            {searchQuery && (
              <button
                type="button"
                className="changelog-search-clear"
                onClick={clearSearch}
                aria-label="Clear search"
              >
                <Icon name="close" size={18} />
              </button>
            )}
          </div>
          {searchQuery && <p className="changelog-filter-note">Filtering the view only. Copies, exports, and printing use the full comparison.</p>}
          <SectionChangelog sectionName="Mainboard" changes={filteredMainboard} cardMap={cardMap} />
          {hasSideboard && <SectionChangelog sectionName="Sideboard" changes={filteredSideboard} cardMap={cardMap} />}
        </div>
      )}
    </div>
  );
}

function ExportMenu({ diffResult, cardMap, beforeText, afterText, noChanges, hasAdditions, onShare, commanders }) {
  function downloadTts() {
    const json = formatTTS(afterText, cardMap, commanders);
    if (!json) return;
    const name = (commanders.length > 0 ? commanders[0] : 'deck').replace(/[^a-zA-Z0-9]/g, '_');
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}_TTS.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
  return <ActionMenu label="Export">
    {!noChanges && <>
      <span className="action-menu-heading">Changes</span>
      {hasAdditions && <CopyButton getText={() => formatMpcFill(diffResult)} label="Copy for MPCFill" />}
      <CopyButton getText={() => formatReddit(diffResult, cardMap)} label="Copy for Reddit" />
      <CopyButton getText={() => formatJSON(diffResult)} label="Copy comparison JSON" />
    </>}
    {afterText && <>
      <span className="action-menu-heading">Updated deck</span>
      <CopyButton getText={() => formatForArchidekt(afterText, commanders, beforeText)} label="Copy for Archidekt" />
      {cardMap?.size > 0 && <button type="button" onClick={downloadTts}>Download TTS</button>}
      {commanders.length > 0 && <a href={DECKCHECK_POWER_URL} target="_blank" rel="noopener noreferrer">Open DeckCheck ↗</a>}
    </>}
    {onShare && <><span className="action-menu-heading">Share this comparison</span><ShareMenuItem onShare={onShare} /></>}
  </ActionMenu>;
}

function ShareMenuItem({ onShare }) {
  const [state, setState] = useState('idle');
  async function handleShare() {
    setState('loading');
    try {
      const url = await onShare();
      await navigator.clipboard.writeText(url);
      setState('done');
      setTimeout(() => setState('idle'), 1500);
    } catch {
      toast.error('Failed to create share link');
      setState('idle');
    }
  }

  return (
    <button
      type="button"
      className="more-menu-item"
      onClick={handleShare}
      disabled={state === 'loading' || state === 'done'}
    >
      {state === 'done' ? 'Link Copied!' : state === 'loading' ? 'Sharing...' : 'Create share link'}
    </button>
  );
}
