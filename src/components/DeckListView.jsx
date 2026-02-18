import { memo, useMemo, useState } from 'react';
import { useAppSettings } from '../context/AppSettingsContext';
import CardLine from './CardLine';
import { groupByType, TYPE_ORDER } from '../lib/scryfall';
import { symbolToSvgUrl } from './ManaCost';
import { parseCMC, extractColors, COLOR_LABELS, COLOR_CSS } from '../lib/analytics';
import './DeckListView.css';

/* ── Analytics helpers ────────────────────────── */

function computeSectionStats(section, cardMap) {
  const cards = [];
  for (const [, entry] of section) {
    const nameLower = entry.displayName.toLowerCase();
    const compositeKey = entry.collectorNumber ? `${nameLower}|${entry.collectorNumber}` : null;
    const data = (compositeKey && cardMap.get(compositeKey)) || cardMap.get(nameLower);
    if (data) {
      cards.push({ ...entry, type: data.type, isBackLand: data.isBackLand || false, manaCost: data.manaCost });
    }
  }

  const totalCards = cards.reduce((sum, c) => sum + c.quantity, 0);
  const uniqueCards = cards.length;

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

function DeckSection({ sectionName, cards, cardMap }) {
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

  if (cardArray.length === 0) return null;

  function renderCard(card) {
    const nameLower = card.name.toLowerCase();
    const compositeKey = card.collectorNumber
      ? `${nameLower}|${card.collectorNumber}`
      : null;
    const compositeData = compositeKey ? cardMap?.get(compositeKey) : null;
    const bareData = cardMap?.get(nameLower);
    const data = compositeData || bareData;
    return (
      <CardLine
        key={card.collectorNumber ? `${card.name}|${card.collectorNumber}` : card.name}
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
      />
    );
  }

  return (
    <section className="deck-list-section">
      <h3 className="deck-list-section-title">
        {sectionName}
        <span className="deck-list-section-count">{totalCards} cards ({cardArray.length} unique)</span>
      </h3>
      {hasTypes ? (
        groups.map(({ type, cards: groupCards }) => (
          <div key={type} className="section-changelog-type-group">
            <span className="section-changelog-type-label">{type}</span>
            {groupCards.map(renderCard)}
          </div>
        ))
      ) : (
        cardArray.map(renderCard)
      )}
    </section>
  );
}

/** Compute total deck value from a parsed deck and card data map. */
function computeDeckPrice(parsedDeck, cardMap) {
  if (!cardMap || cardMap.size === 0) return null;
  let total = 0;
  let hasAnyPrice = false;

  for (const section of [parsedDeck.mainboard, parsedDeck.sideboard]) {
    for (const [, entry] of section) {
      const nameLower = entry.displayName.toLowerCase();
      const compositeKey = entry.collectorNumber ? `${nameLower}|${entry.collectorNumber}` : null;
      const data = (compositeKey && cardMap.get(compositeKey)) || cardMap.get(nameLower);
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
  if (!parsedDeck) return null;

  const { priceDisplayEnabled } = useAppSettings();
  const { mainboard, sideboard, commanders } = parsedDeck;
  const [showAnalytics, setShowAnalytics] = useState(true);

  const deckPrice = useMemo(() => priceDisplayEnabled ? computeDeckPrice(parsedDeck, cardMap) : null, [parsedDeck, cardMap, priceDisplayEnabled]);
  const budgetDeckPrice = useMemo(() => priceDisplayEnabled ? computeBudgetPrice(parsedDeck, cardMap) : null, [parsedDeck, cardMap, priceDisplayEnabled]);

  // Filter cards by search query if provided
  const filteredMainboard = useMemo(() => {
    if (!searchQuery) return mainboard;
    const lower = searchQuery.toLowerCase();
    const filtered = new Map();
    for (const [key, entry] of mainboard) {
      if (entry.displayName.toLowerCase().includes(lower)) {
        filtered.set(key, entry);
      }
    }
    return filtered;
  }, [mainboard, searchQuery]);

  const filteredSideboard = useMemo(() => {
    if (!searchQuery) return sideboard;
    const lower = searchQuery.toLowerCase();
    const filtered = new Map();
    for (const [key, entry] of sideboard) {
      if (entry.displayName.toLowerCase().includes(lower)) {
        filtered.set(key, entry);
      }
    }
    return filtered;
  }, [sideboard, searchQuery]);

  return (
    <div className="deck-list-view">
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
          >
            <span className={`deck-analytics-arrow${showAnalytics ? ' deck-analytics-arrow--open' : ''}`}>&#9654;</span>
            Deck Analytics
          </button>
        </div>
      )}
      {showAnalytics && cardMap && cardMap.size > 0 && (
        <DeckAnalytics parsedDeck={parsedDeck} cardMap={cardMap} />
      )}
      <DeckSection sectionName="Mainboard" cards={filteredMainboard} cardMap={cardMap} />
      {filteredSideboard.size > 0 && <DeckSection sectionName="Sideboard" cards={filteredSideboard} cardMap={cardMap} />}
    </div>
  );
});
