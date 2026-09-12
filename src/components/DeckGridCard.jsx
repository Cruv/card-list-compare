import { memo } from 'react';
import { useAppSettings } from '../context/AppSettingsContext';
import { deckCommanders } from '../hooks/useDeckArtwork';
import DeckArtwork from './DeckArtwork';
import { sourceStatusLabel } from '../lib/sourceSync';
import './DeckGridCard.css';
import './SourceSyncReview.css';

function formatDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default memo(function DeckGridCard({ deck, imageUri, bulkMode, isSelected, onToggleSelect }) {
  const { priceDisplayEnabled } = useAppSettings();
  const commanders = deckCommanders(deck);
  const tags = deck.tags || [];
  const hasBudgetPrice = priceDisplayEnabled && deck.last_known_budget_price > 0
    && deck.last_known_price > 0
    && Math.abs(deck.last_known_budget_price - deck.last_known_price) >= 0.01;
  const sourceName = { archidekt: 'Archidekt', moxfield: 'Moxfield', deckcheck: 'DeckCheck', manual: 'Manual deck' }[deck.source_type]
    || (deck.archidekt_username ? `@${deck.archidekt_username}` : 'Tracked deck');
  const updated = formatDate(deck.latest_snapshot_at);

  function handleClick() {
    if (bulkMode) onToggleSelect(deck.id);
    else window.location.hash = '#library/' + deck.id;
  }

  return (
    <article className={`deck-grid-card${deck.pinned ? ' deck-grid-card--pinned' : ''}${isSelected ? ' deck-grid-card--selected' : ''}`}>
      <button className="deck-grid-card-open" onClick={handleClick} type="button"
        aria-label={`${bulkMode ? 'Select' : 'Open'} ${deck.deck_name}`}
        aria-pressed={bulkMode ? !!isSelected : undefined}>
        <div className="deck-grid-card-cover">
          <DeckArtwork imageUri={imageUri} />
          <div className="deck-grid-card-cover-badges">
            {deck.pinned ? <span className="deck-grid-card-badge">Pinned</span> : null}
            {deck.paper_snapshot_id ? <span className="deck-grid-card-badge deck-grid-card-badge--paper">Paper</span> : null}
            {deck.share_id ? <span className="deck-grid-card-badge">Shared</span> : null}
          </div>
          {bulkMode && <span className={`deck-grid-card-selection${isSelected ? ' is-selected' : ''}`} aria-hidden="true">{isSelected ? '✓' : ''}</span>}
        </div>
        <div className="deck-grid-card-body">
          <div className="deck-grid-card-header"><h3 className="deck-grid-card-name">{deck.deck_name}</h3></div>
          <div className="deck-grid-card-commander">{commanders.length ? commanders.join(' / ') : sourceName}</div>
          <div className="deck-grid-card-meta">
            <span>{deck.snapshot_count || 0} snapshot{deck.snapshot_count === 1 ? '' : 's'}</span>
            {updated && <span title="Last updated">{updated}</span>}
          </div>
          {priceDisplayEnabled && deck.last_known_price > 0 && <div className="deck-grid-card-prices">
            <span className="deck-grid-card-price">${deck.last_known_price.toFixed(2)}</span>
            {hasBudgetPrice && <span className="deck-grid-card-budget">From ${deck.last_known_budget_price.toFixed(2)}</span>}
          </div>}
          {deck.source_type !== 'manual' && ['pending_review', 'local_changes'].includes(deck.source_sync?.status) &&
            <span className={`source-sync-badge${deck.source_sync.status === 'pending_review' ? ' source-sync-badge--pending' : ''}`}>{sourceStatusLabel(deck.source_sync.status)}</span>}
          {tags.length > 0 && <div className="deck-grid-card-tags">
            {tags.slice(0, 3).map(tag => <span key={tag} className="deck-grid-card-tag">{tag}</span>)}
            {tags.length > 3 && <span className="deck-grid-card-tag">+{tags.length - 3}</span>}
          </div>}
        </div>
      </button>
    </article>
  );
});
