import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import SectionChangelog from './SectionChangelog';
import CopyButton from './CopyButton';
import { formatChangelog, formatMpcFill, formatReddit, formatJSON, formatForArchidekt, formatArchidektCSV } from '../lib/formatter';
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
    totalUniqueCards: section.totalUniqueCards,
    unchangedCount: section.unchangedCount,
  };
}

export default function ChangelogOutput({ diffResult, cardMap, onShare, afterText }) {
  const { mainboard, sideboard, hasSideboard, commanders } = diffResult;
  const [searchQuery, setSearchQuery] = useState('');

  const { totalIn, totalOut, totalChanged, noChanges, hasAdditions, commanderLabel, unchangedPct } = useMemo(() => {
    const totalIn = mainboard.cardsIn.length + sideboard.cardsIn.length;
    const totalOut = mainboard.cardsOut.length + sideboard.cardsOut.length;
    const totalChanged = mainboard.quantityChanges.length + sideboard.quantityChanges.length;
    const noChanges = totalIn === 0 && totalOut === 0 && totalChanged === 0;
    const hasAdditions = totalIn > 0 ||
      [...mainboard.quantityChanges, ...sideboard.quantityChanges].some((c) => c.delta > 0);
    const commanderLabel = commanders && commanders.length > 0
      ? commanders.join(' / ')
      : null;

    // Compute unchanged percentage
    const totalUnique = (mainboard.totalUniqueCards || 0) + (sideboard.totalUniqueCards || 0);
    const totalUnchanged = (mainboard.unchangedCount || 0) + (sideboard.unchangedCount || 0);
    const unchangedPct = totalUnique > 0 ? Math.round((totalUnchanged / totalUnique) * 100) : 0;

    return { totalIn, totalOut, totalChanged, noChanges, hasAdditions, commanderLabel, unchangedPct };
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
    <div className="changelog-output">
      <div className="changelog-output-header">
        {commanderLabel && (
          <h2 className="changelog-output-commander">{commanderLabel}</h2>
        )}
        <h2 className="changelog-output-title">
          Changelog
          <span className="changelog-output-timestamp">
            {new Date().toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })}{' '}
            {new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
          </span>
        </h2>
        {!noChanges && (
          <div className="changelog-output-summary">
            {totalIn > 0 && <span className="summary-badge summary-badge--in">+{totalIn} in</span>}
            {totalOut > 0 && (
              <span className="summary-badge summary-badge--out">-{totalOut} out</span>
            )}
            {totalChanged > 0 && (
              <span className="summary-badge summary-badge--changed">
                ~{totalChanged} changed
              </span>
            )}
            {unchangedPct > 0 && (
              <span className="summary-badge summary-badge--unchanged">
                {unchangedPct}% unchanged
              </span>
            )}
          </div>
        )}
        <div className="changelog-output-buttons">
          {hasAdditions && (
            <CopyButton
              getText={() => formatMpcFill(diffResult)}
              label="Copy for MPCFill"
              className="copy-btn copy-btn--mpc"
            />
          )}
          {!noChanges && <CopyButton getText={() => formatChangelog(diffResult, cardMap)} />}
          {afterText && (
            <ArchidektSplitButton afterText={afterText} commanders={commanders} />
          )}
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

      {noChanges ? (
        <p className="changelog-output-identical">Lists are identical — no changes detected.</p>
      ) : (
        <div className="changelog-output-body">
          <div className="changelog-search">
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
                &times;
              </button>
            )}
          </div>
          <SectionChangelog sectionName="Mainboard" changes={filteredMainboard} cardMap={cardMap} />
          {hasSideboard && <SectionChangelog sectionName="Sideboard" changes={filteredSideboard} cardMap={cardMap} />}
        </div>
      )}
    </div>
  );
}

function ArchidektSplitButton({ afterText, commanders }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(formatForArchidekt(afterText, commanders));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = formatForArchidekt(afterText, commanders);
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className="split-btn" ref={ref}>
      <button
        type="button"
        className="copy-btn copy-btn--archidekt split-btn-main"
        onClick={handleCopy}
      >
        {copied ? 'Copied!' : 'Export for Archidekt'}
      </button>
      <button
        type="button"
        className="copy-btn copy-btn--archidekt split-btn-arrow"
        onClick={() => setOpen(prev => !prev)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="More export options"
      >
        &#9662;
      </button>
      {open && (
        <div className="more-menu-dropdown split-btn-dropdown">
          <button
            type="button"
            className="more-menu-item"
            onClick={() => { downloadArchidektCSV(afterText, commanders); setOpen(false); }}
          >
            Download as CSV
          </button>
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
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div className="more-menu" ref={menuRef}>
      <button
        type="button"
        className="copy-btn copy-btn--more"
        onClick={() => setOpen(prev => !prev)}
        aria-expanded={open}
        aria-haspopup="true"
      >
        More &#9662;
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

function downloadArchidektCSV(text, commanders = []) {
  const csv = formatArchidektCSV(text, commanders);
  if (!csv) return;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'deck-export.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
