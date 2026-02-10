import { useState, useMemo } from 'react';
import SectionChangelog from './SectionChangelog';
import CopyButton from './CopyButton';
import { formatChangelog, formatMpcFill, formatReddit, formatJSON } from '../lib/formatter';
import { toast } from './Toast';
import './ChangelogOutput.css';

export default function ChangelogOutput({ diffResult, typeMap, onShare }) {
  const { mainboard, sideboard, hasSideboard, commanders } = diffResult;

  const { totalIn, totalOut, totalChanged, noChanges, hasAdditions, commanderLabel } = useMemo(() => {
    const totalIn = mainboard.cardsIn.length + sideboard.cardsIn.length;
    const totalOut = mainboard.cardsOut.length + sideboard.cardsOut.length;
    const totalChanged = mainboard.quantityChanges.length + sideboard.quantityChanges.length;
    const noChanges = totalIn === 0 && totalOut === 0 && totalChanged === 0;
    const hasAdditions = totalIn > 0 ||
      [...mainboard.quantityChanges, ...sideboard.quantityChanges].some((c) => c.delta > 0);
    const commanderLabel = commanders && commanders.length > 0
      ? commanders.join(' / ')
      : null;
    return { totalIn, totalOut, totalChanged, noChanges, hasAdditions, commanderLabel };
  }, [mainboard, sideboard, commanders]);

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
          {!noChanges && <CopyButton getText={() => formatChangelog(diffResult, typeMap)} />}
          {!noChanges && (
            <CopyButton
              getText={() => formatReddit(diffResult, typeMap)}
              label="Copy for Reddit"
              className="copy-btn copy-btn--reddit"
            />
          )}
          {!noChanges && (
            <CopyButton
              getText={() => formatJSON(diffResult)}
              label="Copy JSON"
              className="copy-btn copy-btn--json"
            />
          )}
          {onShare && <ShareButton onShare={onShare} />}
        </div>
      </div>

      {noChanges ? (
        <p className="changelog-output-identical">Lists are identical — no changes detected.</p>
      ) : (
        <div className="changelog-output-body">
          <SectionChangelog sectionName="Mainboard" changes={mainboard} typeMap={typeMap} />
          {hasSideboard && <SectionChangelog sectionName="Sideboard" changes={sideboard} typeMap={typeMap} />}
        </div>
      )}
    </div>
  );
}

function ShareButton({ onShare }) {
  const [state, setState] = useState('idle'); // idle | loading | done
  const [shareUrl, setShareUrl] = useState(null);

  async function handleShare() {
    setState('loading');
    try {
      const url = await onShare();
      setShareUrl(url);
      await navigator.clipboard.writeText(url);
      setState('done');
      setTimeout(() => setState('idle'), 3000);
    } catch (err) {
      toast.error('Failed to create share link');
      setState('idle');
    }
  }

  if (state === 'done') {
    return (
      <button className="copy-btn copy-btn--share" type="button" disabled>
        Link Copied!
      </button>
    );
  }

  return (
    <button
      className="copy-btn copy-btn--share"
      onClick={handleShare}
      disabled={state === 'loading'}
      type="button"
    >
      {state === 'loading' ? 'Sharing...' : 'Share Link'}
    </button>
  );
}
