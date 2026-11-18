import { useState, useMemo, useCallback, useLayoutEffect, useRef } from 'react';
import SectionChangelog from './SectionChangelog';
import CopyButton from './CopyButton';
import PrintComparisonButton from './PrintComparisonButton';
import Icon from './Icon';
import ActionMenu from './ActionMenu';
import { formatChangelog, formatMpcFill, formatReddit, formatJSON, formatForArchidekt, formatTTS } from '../lib/formatter';
import { DECKCHECK_POWER_URL } from '../lib/deckcheck';
import { comparisonShareExpiry, shareExpiryOptions } from '../lib/comparisonSharing';
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

export default function ChangelogOutput({ diffResult, cardMap, onShare, shareOwnerId, afterText, beforeText }) {
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
            shareOwnerId={shareOwnerId}
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

function ExportMenu({ diffResult, cardMap, beforeText, afterText, noChanges, hasAdditions, onShare, shareOwnerId, commanders }) {
  const shareScope = useMemo(() => ({ beforeText, afterText, shareOwnerId }), [beforeText, afterText, shareOwnerId]);
  const currentScope = useRef(null);
  const [share, setShare] = useState(null);
  const { expiry = '0', sharing = false, shareUrl = null } = share?.scope === shareScope ? share : {};

  // The disclosure can unmount its contents without discarding this comparison's link.
  useLayoutEffect(() => {
    currentScope.current = shareScope;
    return () => { currentScope.current = null; };
  }, [shareScope]);

  async function handleShare() {
    if (!onShare || sharing) return;
    const isCurrent = () => currentScope.current === shareScope;
    setShare({ scope: shareScope, expiry, sharing: true });
    try {
      const url = await onShare(comparisonShareExpiry(expiry));
      if (!isCurrent() || !url) return;
      setShare({ scope: shareScope, expiry, sharing: true, shareUrl: url });
      try {
        await navigator.clipboard.writeText(url);
        if (isCurrent()) toast.success('Share link copied');
      } catch {
        if (isCurrent()) toast.info('Share link created. Select the address in Export to copy it.');
      }
    } catch (error) {
      if (isCurrent()) toast.error(error.message || 'Failed to create share link');
    } finally {
      if (isCurrent()) setShare(current => current?.scope === shareScope ? { ...current, sharing: false } : current);
    }
  }

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
    {onShare && <>
      <span className="action-menu-heading">Share this comparison</span>
      <label className="comparison-share-expiry">
        Link expires
        <select value={expiry} onChange={event => setShare({ scope: shareScope, expiry: event.target.value })} disabled={sharing}>
          {shareExpiryOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      {shareUrl ? <>
        <label className="comparison-share-expiry">Share link
          <input readOnly value={shareUrl} onFocus={event => event.currentTarget.select()} />
        </label>
        <CopyButton key={shareUrl} getText={() => shareUrl} label="Copy share link" />
        <a href={shareUrl} target="_blank" rel="noreferrer">Open share link</a>
      </> : <button type="button" onClick={handleShare} disabled={sharing}>{sharing ? 'Creating…' : 'Create share link'}</button>}
      {shareOwnerId ? <a href="#settings">Manage my share links</a>
        : <p className="comparison-share-guest">Sign in to manage links you create.</p>}
    </>}
  </ActionMenu>;
}
