import { useAppSettings } from '../context/AppSettingsContext';
import './DeckGridCard.css';

export default function DeckGridCard({ deck, bulkMode, isSelected, onToggleSelect }) {
  const { priceDisplayEnabled } = useAppSettings();

  let commanders = [];
  try { commanders = JSON.parse(deck.commanders || '[]'); } catch { /* ignore */ }

  const tags = deck.tags || [];

  function handleClick(e) {
    if (bulkMode) {
      onToggleSelect();
      return;
    }
    window.location.hash = '#library/' + deck.id;
  }

  return (
    <div
      className={`deck-grid-card${deck.pinned ? ' deck-grid-card--pinned' : ''}${isSelected ? ' deck-grid-card--selected' : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(e); } }}
    >
      {bulkMode && (
        <input
          type="checkbox"
          className="deck-grid-card-checkbox"
          checked={isSelected}
          onChange={onToggleSelect}
          onClick={e => e.stopPropagation()}
        />
      )}

      <div className="deck-grid-card-header">
        <span className="deck-grid-card-name">{deck.deck_name}</span>
        {priceDisplayEnabled && deck.last_known_price > 0 && (
          <span className="deck-grid-card-price">${deck.last_known_price.toFixed(2)}</span>
        )}
      </div>

      {commanders.length > 0 && (
        <div className="deck-grid-card-commander">
          {commanders.join(' / ')}
        </div>
      )}

      <div className="deck-grid-card-meta">
        <span className="deck-grid-card-owner">@{deck.archidekt_username}</span>
        <span className="deck-grid-card-snapshots">{deck.snapshot_count} snap{deck.snapshot_count !== 1 ? 's' : ''}</span>
        {deck.share_id && <span className="deck-grid-card-badge deck-grid-card-badge--shared">Shared</span>}
        {deck.paper_snapshot_id && <span className="deck-grid-card-badge deck-grid-card-badge--paper">Paper</span>}
      </div>

      {tags.length > 0 && (
        <div className="deck-grid-card-tags">
          {tags.slice(0, 3).map(tag => (
            <span key={tag} className="deck-grid-card-tag">{tag}</span>
          ))}
          {tags.length > 3 && (
            <span className="deck-grid-card-tag deck-grid-card-tag--more">+{tags.length - 3}</span>
          )}
        </div>
      )}
    </div>
  );
}
