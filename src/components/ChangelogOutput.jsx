import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import SectionChangelog from './SectionChangelog';
import CopyButton from './CopyButton';
import PrintComparisonButton from './PrintComparisonButton';
import Icon from './Icon';
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
        <p className="changelog-output-eyebrow">Your comparison</p>
        <h2 className="changelog-output-title">Changelog</h2>
        {commanderLabel && (
          <p className="changelog-output-commander">{commanderLabel}</p>
        )}
        <p className="changelog-output-caption">See what changed, then prepare your next print batch.</p>
        </div>
        <div className="changelog-output-buttons">
          <PrintComparisonButton beforeText={beforeText} afterText={afterText}
            listName={commanderLabel ? `${commanderLabel} comparison` : 'Compared lists'} />
          {!noChanges && <CopyButton getText={() => formatChangelog(diffResult, cardMap)} label="Copy Changelog" />}
          <MoreMenu
            diffResult={diffResult}
            cardMap={cardMap}
            afterText={afterText}
            noChanges={noChanges}
            onShare={onShare}
            commanders={commanders}
          />
        </div>
      </div>

      {!noChanges && <div className="changelog-output-summary" aria-label="Change summary">
        <div className="changelog-stat changelog-stat--in"><strong>{totalIn}</strong><span>Cards in</span></div>
        <div className="changelog-stat changelog-stat--out"><strong>{totalOut}</strong><span>Cards out</span></div>
        <div className="changelog-stat changelog-stat--changed"><strong>{totalChanged}</strong><span>Quantity changes</span></div>
        <div className="changelog-stat changelog-stat--printing"><strong>{totalPrinting}</strong><span>Printing changes</span></div>
      </div>}
      <div className="changelog-output-export-bar">
        <span className="changelog-output-export-note">{noChanges ? 'No changes in this comparison' : `${unchangedPct}% of unique cards unchanged`}</span>
        <div className="changelog-output-export-actions">
          {hasAdditions && (
            <CopyButton
              getText={() => formatMpcFill(diffResult)}
              label="Copy for MPCFill"
              className="copy-btn copy-btn--mpc"
            />
          )}
          {afterText && (
            <CopyButton
              getText={() => formatForArchidekt(afterText, commanders, beforeText)}
              label="Copy for Archidekt"
              className="copy-btn copy-btn--archidekt"
            />
          )}
        </div>
      </div>

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

function MoreMenu({ diffResult, cardMap, afterText, noChanges, onShare, commanders }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', handleClick);
    return () => document.removeEventListener('pointerdown', handleClick);
  }, [open]);

  return (
    <div className="more-menu" ref={menuRef} onKeyDown={e => {
      if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); menuRef.current?.querySelector('button')?.focus(); }
    }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
      <button
        type="button"
        className="copy-btn copy-btn--more"
        onClick={() => setOpen(prev => !prev)}
        aria-expanded={open}
      >
        <Icon name="more" size={18} /> More
      </button>
      {open && (
        <div className="more-menu-dropdown">
          {onShare && <ShareMenuItem onShare={onShare} onDone={() => setOpen(false)} />}
          {commanders.length > 0 && (
            <a
              className="more-menu-item"
              href={DECKCHECK_POWER_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Check Power &#8599;
            </a>
          )}
          {!noChanges && (
            <CopyButton
              getText={() => formatReddit(diffResult, cardMap)}
              label="Copy for Reddit"
              className="more-menu-item"
            />
          )}
          {!noChanges && (
            <CopyButton
              getText={() => formatJSON(diffResult)}
              label="Copy JSON"
              className="more-menu-item"
            />
          )}
          {afterText && cardMap && cardMap.size > 0 && (
            <button
              type="button"
              className="more-menu-item"
              onClick={() => {
                const json = formatTTS(afterText, cardMap, commanders);
                if (json) {
                  const name = (commanders.length > 0 ? commanders[0] : 'deck').replace(/[^a-zA-Z0-9]/g, '_');
                  const blob = new Blob([json], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${name}_TTS.json`;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  URL.revokeObjectURL(url);
                  setOpen(false);
                }
              }}
            >
              Download TTS
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ShareMenuItem({ onShare, onDone }) {
  const [state, setState] = useState('idle');
  async function handleShare() {
    setState('loading');
    try {
      const url = await onShare();
      await navigator.clipboard.writeText(url);
      setState('done');
      setTimeout(() => { setState('idle'); onDone(); }, 1500);
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
      {state === 'done' ? 'Link Copied!' : state === 'loading' ? 'Sharing...' : 'Share Link'}
    </button>
  );
}
