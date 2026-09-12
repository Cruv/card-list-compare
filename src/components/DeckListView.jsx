import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useAppSettings } from '../context/AppSettingsContext';
import CardLine from './CardLine';
import Icon from './Icon';
import { useModalLayer } from '../lib/useModalLayer';
import { cardDataForEntry, groupByType, TYPE_ORDER } from '../lib/scryfall';
import { cardIdentityKey, normalizeCardName } from '../lib/cardIdentity';
import { symbolToSvgUrl } from './ManaCost';
import { parseCMC, extractColors, COLOR_LABELS, COLOR_CSS } from '../lib/analytics';
import './DeckListView.css';

/* ── Analytics helpers ────────────────────────── */

function computeSectionStats(section, cardMap) {
  const cards = [];
  for (const [, entry] of section) {
    const data = cardDataForEntry(cardMap, entry);
    if (data) {
      cards.push({ ...entry, type: data.type, isBackLand: data.isBackLand || false, manaCost: data.manaCost });
    }
  }

  const totalCards = cards.reduce((sum, c) => sum + c.quantity, 0);
  const uniqueCards = new Set(cards.map(card => normalizeCardName(card.displayName))).size;

  const typeCounts = {};
  for (const t of TYPE_ORDER) typeCounts[t] = 0;
  for (const card of cards) {
    const t = card.type || 'Other';
    typeCounts[t] = (typeCounts[t] || 0) + card.quantity;
  }

  const mdfcLandCount = cards
    .filter(c => c.type !== 'Land' && c.isBackLand)
    .reduce((sum, c) => sum + c.quantity, 0);
  const landCount = (typeCounts['Land'] || 0) + mdfcLandCount;
  const creatureCount = typeCounts['Creature'] || 0;

  const nonLandCards = cards.filter(c => c.type !== 'Land' && !c.isBackLand);

  const cmcCounts = {};
  let cmcSum = 0;
  let cmcCards = 0;
  for (const card of nonLandCards) {
    const cmc = parseCMC(card.manaCost);
    const key = cmc >= 7 ? '7+' : String(cmc);
    cmcCounts[key] = (cmcCounts[key] || 0) + card.quantity;
    cmcSum += cmc * card.quantity;
    cmcCards += card.quantity;
  }
  const avgCMC = cmcCards > 0 ? cmcSum / cmcCards : 0;

  const colorCounts = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  for (const card of nonLandCards) {
    const colors = extractColors(card.manaCost);
    if (colors.length === 0 && card.manaCost) {
      colorCounts.C += card.quantity;
    } else {
      for (const c of colors) {
        colorCounts[c] += card.quantity;
      }
    }
  }

  return { totalCards, uniqueCards, landCount, creatureCount, avgCMC, cmcCounts, typeCounts, colorCounts };
}

/* ── Analytics charts ────────────────────────── */

const CMC_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7+'];
const COLOR_KEYS = ['W', 'U', 'B', 'R', 'G', 'C'];

function AnalyticsCharts({ stats, label }) {
  const maxCmc = Math.max(...CMC_KEYS.map(k => stats.cmcCounts[k] || 0), 1);

  const typeEntries = TYPE_ORDER
    .map(t => ({ type: t, count: stats.typeCounts[t] || 0 }))
    .filter(e => e.count > 0);
  const maxType = Math.max(...typeEntries.map(e => e.count), 1);

  const colorEntries = COLOR_KEYS
    .map(c => ({ color: c, count: stats.colorCounts[c] || 0 }))
    .filter(e => e.count > 0);
  const maxColor = Math.max(...colorEntries.map(e => e.count), 1);

  return (
    <>
      {label && <h4 className="deck-analytics-section-label">{label}</h4>}

      {/* Stats summary */}
      <div className="deck-analytics-stats">
        <div className="analytics-stat">
          <span className="analytics-stat-value">{stats.totalCards}</span>
          <span className="analytics-stat-label">Cards</span>
        </div>
        <div className="analytics-stat">
          <span className="analytics-stat-value">{stats.uniqueCards}</span>
          <span className="analytics-stat-label">Unique</span>
        </div>
        <div className="analytics-stat">
          <span className="analytics-stat-value">{stats.avgCMC.toFixed(2)}</span>
          <span className="analytics-stat-label">Avg CMC</span>
        </div>
        <div className="analytics-stat">
          <span className="analytics-stat-value">{stats.landCount}</span>
          <span className="analytics-stat-label">Lands</span>
        </div>
        <div className="analytics-stat">
          <span className="analytics-stat-value">{stats.creatureCount}</span>
          <span className="analytics-stat-label">Creatures</span>
        </div>
      </div>

      {/* Mana Curve */}
      <div className="deck-analytics-chart">
        <h4 className="deck-analytics-chart-title">Mana Curve</h4>
        <div className="deck-analytics-bars">
          {CMC_KEYS.map(k => {
            const count = stats.cmcCounts[k] || 0;
            const pct = (count / maxCmc) * 100;
            return (
              <div key={k} className="analytics-bar-col">
                <span className="analytics-bar-value">{count || ''}</span>
                <div className="analytics-bar-track">
                  <div className="analytics-bar-fill analytics-bar-fill--cmc" style={{ height: `${pct}%` }} />
                </div>
                <span className="analytics-bar-label">{k}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Type Distribution */}
      <div className="deck-analytics-chart">
        <h4 className="deck-analytics-chart-title">Card Types</h4>
        <div className="deck-analytics-rows">
          {typeEntries.map(({ type, count }) => {
            const pct = (count / maxType) * 100;
            return (
              <div key={type} className="analytics-row">
                <span className="analytics-row-label">{type}</span>
                <div className="analytics-row-track">
                  <div className="analytics-row-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="analytics-row-value">{count}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Color Distribution */}
      {colorEntries.length > 0 && (
        <div className="deck-analytics-chart">
          <h4 className="deck-analytics-chart-title">Color Distribution</h4>
          <div className="deck-analytics-bars deck-analytics-bars--color">
            {colorEntries.map(({ color, count }) => {
              const pct = (count / maxColor) * 100;
              return (
                <div key={color} className="analytics-bar-col">
                  <span className="analytics-bar-value">{count || ''}</span>
                  <div className="analytics-bar-track">
                    <div
                      className="analytics-bar-fill"
                      style={{ height: `${pct}%`, background: COLOR_CSS[color] }}
                    />
                  </div>
                  <span className="analytics-bar-label analytics-color-pip">
                    <img
                      className="analytics-color-symbol"
                      src={symbolToSvgUrl(color)}
                      alt={COLOR_LABELS[color]}
                      title={COLOR_LABELS[color]}
                      width="20"
                      height="20"
                    />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

/* ── Analytics component ────────────────────────── */

function DeckAnalytics({ parsedDeck, cardMap }) {
  const { mainStats, sideStats } = useMemo(() => {
    if (!cardMap || cardMap.size === 0) return { mainStats: null, sideStats: null };

    const mainStats = computeSectionStats(parsedDeck.mainboard, cardMap);
    const hasSideboard = parsedDeck.sideboard && parsedDeck.sideboard.size > 0;
    const sideStats = hasSideboard ? computeSectionStats(parsedDeck.sideboard, cardMap) : null;

    return { mainStats, sideStats };
  }, [parsedDeck, cardMap]);

  if (!mainStats) return null;

  return (
    <div className="deck-analytics">
      <AnalyticsCharts stats={mainStats} label={sideStats ? 'Mainboard' : null} />
      {sideStats && sideStats.totalCards > 0 && (
        <AnalyticsCharts stats={sideStats} label="Sideboard" />
      )}
    </div>
  );
}

function DeckSection({ sectionName, cards, cardMap, layout, onInspect }) {
  const cardArray = useMemo(() => {
    const arr = [];
    for (const [, entry] of cards) {
      arr.push({
        name: entry.displayName,
        quantity: entry.quantity,
        setCode: entry.setCode || '',
        collectorNumber: entry.collectorNumber || '',
        isFoil: entry.isFoil || false,
      });
    }
    return arr.sort((a, b) => a.name.localeCompare(b.name));
  }, [cards]);

  const hasTypes = cardMap && cardMap.size > 0;
  const groups = useMemo(() => hasTypes ? groupByType(cardArray, cardMap) : null, [cardArray, cardMap, hasTypes]);

  const totalCards = useMemo(() => cardArray.reduce((sum, c) => sum + c.quantity, 0), [cardArray]);
  const uniqueCards = useMemo(() => new Set(cardArray.map(card => normalizeCardName(card.name))).size, [cardArray]);

  if (cardArray.length === 0) return null;

  function renderCard(card) {
    const nameLower = card.name.toLowerCase();
    const bareData = cardMap?.get(nameLower);
    const data = cardDataForEntry(cardMap, card);
    const cardLine = <CardLine
        key={cardIdentityKey(card)}
        name={card.name}
        quantity={card.quantity}
        changeType="list"
        manaCost={data?.manaCost}
        imageUri={data?.imageUri}
        setCode={card.setCode}
        collectorNumber={card.collectorNumber}
        isFoil={card.isFoil}
        priceUsd={data?.priceUsd}
        priceUsdFoil={data?.priceUsdFoil}
        cheapestPriceUsd={bareData?.priceUsd}
        cheapestPriceUsdFoil={bareData?.priceUsdFoil}
      />;
    if (layout !== 'gallery') return cardLine;
    return <DeckGalleryTile key={cardIdentityKey(card)} card={card} imageUri={data?.imageUri} onInspect={onInspect}>{cardLine}</DeckGalleryTile>;
  }

  return (
    <section className={`deck-list-section deck-list-section--${layout}`}>
      <h3 className="deck-list-section-title">
        {sectionName}
        <span className="deck-list-section-count">{totalCards} cards ({uniqueCards} unique)</span>
      </h3>
      {hasTypes ? (
        groups.map(({ type, cards: groupCards }) => (
          <div key={type} className="section-changelog-type-group">
            <span className="section-changelog-type-label">{type}</span>
            <div className={layout === 'gallery' ? 'deck-gallery-grid' : 'deck-list-rows'}>{groupCards.map(renderCard)}</div>
          </div>
        ))
      ) : (
        <div className={layout === 'gallery' ? 'deck-gallery-grid' : 'deck-list-rows'}>{cardArray.map(renderCard)}</div>
      )}
    </section>
  );
}

function DeckGalleryTile({ card, imageUri, onInspect, children }) {
  const [failedUri, setFailedUri] = useState(null);
  const available = imageUri && failedUri !== imageUri;
  return <article className="deck-gallery-card">
    <button className="deck-gallery-art" type="button" onClick={event => { event.currentTarget.focus(); onInspect({ name: card.name, imageUri }); }}
      aria-label={`View ${card.name} artwork`} disabled={!available}>
      {available ? <img src={imageUri} alt="" loading="lazy" onError={() => setFailedUri(imageUri)} /> : <span><Icon name="cards" size={32} />Artwork unavailable</span>}
      <span className="deck-gallery-quantity">{card.quantity}×</span>
    </button>
    <div className="deck-gallery-card-caption">{children}</div>
  </article>;
}

/** Compute total deck value from a parsed deck and card data map. */
function computeDeckPrice(parsedDeck, cardMap) {
  if (!cardMap || cardMap.size === 0) return null;
  let total = 0;
  let hasAnyPrice = false;

  for (const section of [parsedDeck.mainboard, parsedDeck.sideboard]) {
    for (const [, entry] of section) {
      const data = cardDataForEntry(cardMap, entry);
      if (data) {
        const isFoil = entry.isFoil || false;
        const unitPrice = isFoil && data.priceUsdFoil != null ? data.priceUsdFoil : data.priceUsd;
        if (unitPrice != null) {
          total += unitPrice * entry.quantity;
          hasAnyPrice = true;
        }
      }
    }
  }
  return hasAnyPrice ? total : null;
}

/** Compute budget deck value using cheapest/default printing prices (bare-name key only). */
function computeBudgetPrice(parsedDeck, cardMap) {
  if (!cardMap || cardMap.size === 0) return null;
  let total = 0;
  let hasAnyPrice = false;

  for (const section of [parsedDeck.mainboard, parsedDeck.sideboard]) {
    for (const [, entry] of section) {
      const nameLower = entry.displayName.toLowerCase();
      const data = cardMap.get(nameLower); // Always use bare-name key for cheapest
      if (data) {
        // Budget price = cheapest of foil and non-foil for this card name
        const nonFoil = data.priceUsd;
        const foil = data.priceUsdFoil;
        const unitPrice = (nonFoil != null && foil != null)
          ? Math.min(nonFoil, foil)
          : (nonFoil ?? foil);
        if (unitPrice != null) {
          total += unitPrice * entry.quantity;
          hasAnyPrice = true;
        }
      }
    }
  }
  return hasAnyPrice ? total : null;
}

export default memo(function DeckListView({ parsedDeck, cardMap, searchQuery }) {
  // Hooks must run unconditionally — see Rules of Hooks. Guard on the derived
  // values below, never with an early return before the hooks.
  const { priceDisplayEnabled } = useAppSettings();
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [localSearch, setLocalSearch] = useState('');
  const [layout, setLayout] = useState('gallery');
  const [inspectedCard, setInspectedCard] = useState(null);
  const query = (searchQuery ?? localSearch).trim();
  const { mainboard, sideboard, commanders } = parsedDeck || {};

  const deckPrice = useMemo(() => (priceDisplayEnabled && parsedDeck) ? computeDeckPrice(parsedDeck, cardMap) : null, [parsedDeck, cardMap, priceDisplayEnabled]);
  const budgetDeckPrice = useMemo(() => (priceDisplayEnabled && parsedDeck) ? computeBudgetPrice(parsedDeck, cardMap) : null, [parsedDeck, cardMap, priceDisplayEnabled]);

  // Filter cards by search query if provided
  const filteredMainboard = useMemo(() => {
    if (!mainboard) return new Map();
    if (!query) return mainboard;
    const lower = query.toLowerCase();
    const filtered = new Map();
    for (const [key, entry] of mainboard) {
      if (entry.displayName.toLowerCase().includes(lower)) {
        filtered.set(key, entry);
      }
    }
    return filtered;
  }, [mainboard, query]);

  const filteredSideboard = useMemo(() => {
    if (!sideboard) return new Map();
    if (!query) return sideboard;
    const lower = query.toLowerCase();
    const filtered = new Map();
    for (const [key, entry] of sideboard) {
      if (entry.displayName.toLowerCase().includes(lower)) {
        filtered.set(key, entry);
      }
    }
    return filtered;
  }, [sideboard, query]);

  if (!parsedDeck) return null;

  return (
    <div className="deck-list-view">
      <div className="deck-list-toolbar">
        {searchQuery === undefined && <label className="deck-list-search"><Icon name="search" size={18} />
          <input type="search" value={localSearch} onChange={event => setLocalSearch(event.target.value)} placeholder="Find a card in this deck…" aria-label="Search deck cards" />
        </label>}
        <div className="deck-list-layout" role="group" aria-label="Card display">
          <button className={layout === 'gallery' ? 'is-active' : ''} aria-pressed={layout === 'gallery'} onClick={() => setLayout('gallery')} type="button"><Icon name="cards" size={16} /> Gallery</button>
          <button className={layout === 'list' ? 'is-active' : ''} aria-pressed={layout === 'list'} onClick={() => setLayout('list')} type="button"><Icon name="library" size={16} /> List</button>
        </div>
      </div>
      {query && <p className="deck-list-search-summary" role="status">{filteredMainboard.size + filteredSideboard.size} matching printing{filteredMainboard.size + filteredSideboard.size === 1 ? '' : 's'} · filtering this view only</p>}
      {commanders && commanders.length > 0 && (
        <div className="deck-list-commanders">
          {commanders.join(' / ')}
        </div>
      )}
      {deckPrice != null && (
        <div className="deck-list-price-summary">
          Estimated Value: <strong>${deckPrice.toFixed(2)}</strong>
          {budgetDeckPrice != null && Math.abs(budgetDeckPrice - deckPrice) >= 0.01 && (
            <span className="deck-list-budget-price"> (Budget: ${budgetDeckPrice.toFixed(2)})</span>
          )}
        </div>
      )}
      {cardMap && cardMap.size > 0 && (
        <div className="deck-analytics-toggle">
          <button
            type="button"
            className="deck-analytics-toggle-btn"
            onClick={() => setShowAnalytics(v => !v)}
            aria-expanded={showAnalytics}
          >
            <span className={`deck-analytics-arrow${showAnalytics ? ' deck-analytics-arrow--open' : ''}`}>&#9654;</span>
            Deck Analytics
          </button>
        </div>
      )}
      {showAnalytics && cardMap && cardMap.size > 0 && (
        <DeckAnalytics parsedDeck={parsedDeck} cardMap={cardMap} />
      )}
      <DeckSection sectionName="Mainboard" cards={filteredMainboard} cardMap={cardMap} layout={layout} onInspect={setInspectedCard} />
      {filteredMainboard.size === 0 && filteredSideboard.size === 0 && <p className="deck-list-no-results">{query ? 'No cards match this search.' : 'This snapshot has no cards.'}</p>}
      {filteredSideboard.size > 0 && <DeckSection sectionName="Sideboard" cards={filteredSideboard} cardMap={cardMap} layout={layout} onInspect={setInspectedCard} />}
      {inspectedCard && <DeckCardDialog card={inspectedCard} onClose={() => setInspectedCard(null)} />}
    </div>
  );
});

function DeckCardDialog({ card, onClose }) {
  const dialogRef = useRef(null);
  useModalLayer(onClose, { containerRef: dialogRef, trapFocus: false });
  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);
  return <dialog ref={dialogRef} className="deck-card-dialog" aria-label={card.name}
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialogRef.current) onClose(); }}>
    <div className="deck-card-dialog-content">
      <div className="deck-card-dialog-heading"><strong>{card.name}</strong><button className="btn btn-secondary" aria-label="Close card artwork" onClick={onClose} type="button"><Icon name="close" /></button></div>
      <img src={card.imageUri} alt={card.name} />
    </div>
  </dialog>;
}
