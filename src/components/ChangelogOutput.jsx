import SectionChangelog from './SectionChangelog';
import CopyButton from './CopyButton';
import { formatChangelog, formatMpcFill } from '../lib/formatter';
import './ChangelogOutput.css';

export default function ChangelogOutput({ diffResult }) {
  const { mainboard, sideboard, hasSideboard, commanders } = diffResult;

  const totalIn = mainboard.cardsIn.length + sideboard.cardsIn.length;
  const totalOut = mainboard.cardsOut.length + sideboard.cardsOut.length;
  const totalChanged = mainboard.quantityChanges.length + sideboard.quantityChanges.length;
  const noChanges = totalIn === 0 && totalOut === 0 && totalChanged === 0;

  // Check if there are any additions (new cards or quantity increases) for MPCFill
  const hasAdditions = totalIn > 0 ||
    [...mainboard.quantityChanges, ...sideboard.quantityChanges].some((c) => c.delta > 0);

  const commanderLabel = commanders && commanders.length > 0
    ? commanders.join(' / ')
    : null;

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
          {!noChanges && <CopyButton getText={() => formatChangelog(diffResult)} />}
        </div>
      </div>

      {noChanges ? (
        <p className="changelog-output-identical">Lists are identical — no changes detected.</p>
      ) : (
        <div className="changelog-output-body">
          <SectionChangelog sectionName="Mainboard" changes={mainboard} />
          {hasSideboard && <SectionChangelog sectionName="Sideboard" changes={sideboard} />}
        </div>
      )}
    </div>
  );
}
