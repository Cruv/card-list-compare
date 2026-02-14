import { memo, useMemo, useState } from 'react';
import { useAppSettings } from '../context/AppSettingsContext';
import CardLine from './CardLine';
import { groupByType, TYPE_ORDER } from '../lib/scryfall';
import { symbolToSvgUrl } from './ManaCost';
import './DeckListView.css';

/* ── Mana cost parsing ──────────────────────────── */

/** Parse a mana cost string like "{2}{U}{B}" into CMC (number). */
function parseCMC(manaCost) {
  if (!manaCost) return 0;
  let cmc = 0;
  const symbols = manaCost.match(/\{([^}]+)\}/g) || [];
  for (const sym of symbols) {
    const inner = sym.slice(1, -1); // strip { }
    if (inner === 'X' || inner === 'Y' || inner === 'Z') continue;
    const num = parseInt(inner, 10);
    if (!isNaN(num)) {
      cmc += num;
    } else {
      // Each colored/hybrid symbol counts as 1
      cmc += 1;
    }
  }
  return cmc;
}

/** Extract color symbols from a mana cost string. */
function extractColors(manaCost) {
  if (!manaCost) return [];
  const colors = new Set();
  const symbols = manaCost.match(/\{([^}]+)\}/g) || [];
  for (const sym of symbols) {
    const inner = sym.slice(1, -1);
    // Check for each color letter in the symbol (handles hybrids like W/U)
    if (inner.includes('W')) colors.add('W');
    if (inner.includes('U')) colors.add('U');
    if (inner.includes('B')) colors.add('B');
    if (inner.includes('R')) colors.add('R');
    if (inner.includes('G')) colors.add('G');
  }
  return [...colors];
}

const COLOR_LABELS = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };
const COLOR_CSS = { W: '#f9faf4', U: '#0e68ab', B: '#150b00', R: '#d3202a', G: '#00733e', C: '#ccc2c0' };

/* ── Analytics component ────────────────────────── */

function DeckAnalytics({ parsedDeck, cardMap }) {
  const analytics = useMemo(() => {
    if (!cardMap || cardMap.size === 0) return null;

    const allCards = [];
    for (const section of [parsedDeck.mainboard, parsedDeck.sideboard]) {
      for (const [, entry] of section) {
        const nameLower = entry.displayName.toLowerCase();
        const compositeKey = entry.collectorNumber ? `${nameLower}|${entry.collectorNumber}` : null;
        const data = (compositeKey && cardMap.get(compositeKey)) || cardMap.get(nameLower);
        if (data) {
          allCards.push({ ...entry, type: data.type, isBackLand: data.isBackLand || false, manaCost: data.manaCost });
        }
      }
    }

    // Total & unique
    const totalCards = allCards.reduce((sum, c) => sum + c.quantity, 0);
    const uniqueCards = allCards.length;

    // By type (front face classification for the chart)
    const typeCounts = {};
    for (const t of TYPE_ORDER) typeCounts[t] = 0;
    for (const card of allCards) {
      const t = card.type || 'Other';
      typeCounts[t] = (typeCounts[t] || 0) + card.quantity;
    }

    // Land count includes MDFCs with land on back face (matches Archidekt behavior)
    const mdfcLandCount = allCards
      .filter(c => c.type !== 'Land' && c.isBackLand)
      .reduce((sum, c) => sum + c.quantity, 0);
    const landCount = (typeCounts['Land'] || 0) + mdfcLandCount;
    const creatureCount = typeCounts['Creature'] || 0;

    // Non-land cards for mana curve (exclude both lands and MDFC-lands)
    const nonLandCards = allCards.filter(c => c.type !== 'Land' && !c.isBackLand);

    // CMC distribution
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

    // Color distribution (by card count, not mana symbols)
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

    return {
      totalCards, uniqueCards, landCount, creatureCount,
      avgCMC, cmcCounts, typeCounts, colorCounts,
    };
  }, [parsedDeck, cardMap]);

  if (!analytics) return null;

  const cmcKeys = ['0', '1', '2', '3', '4', '5', '6', '7+'];
  const maxCmc = Math.max(...cmcKeys.map(k => analytics.cmcCounts[k] || 0), 1);

  const typeEntries = TYPE_ORDER
    .map(t => ({ type: t, count: analytics.typeCounts[t] || 0 }))
    .filter(e => e.count > 0);
  const maxType = Math.max(...typeEntries.map(e => e.count), 1);

  const colorKeys = ['W', 'U', 'B', 'R', 'G', 'C'];
  const colorEntries = colorKeys
    .map(c => ({ color: c, count: analytics.colorCounts[c] || 0 }))
    .filter(e => e.count > 0);
  const maxColor = Math.max(...colorEntries.map(e => e.count), 1);

  return (
    <div className="deck-analytics">
      {/* Stats summary */}
      <div className="deck-analytics-stats">
        <div className="analytics-stat">
          <span className="analytics-stat-value">{analytics.totalCards}</span>
          <span className="analytics-stat-label">Cards</span>
        </div>
        <div className="analytics-stat">
          <span className="analytics-stat-value">{analytics.uniqueCards}</span>
          <span className="analytics-stat-label">Unique</span>
        </div>
        <div className="analytics-stat">
          <span className="analytics-stat-value">{analytics.avgCMC.toFixed(2)}</span>
          <span className="analytics-stat-label">Avg CMC</span>
        </div>
        <div className="analytics-stat">
          <span className="analytics-stat-value">{analytics.landCount}</span>
          <span className="analytics-stat-label">Lands</span>
        </div>
        <div className="analytics-stat">
          <span className="analytics-stat-value">{analytics.creatureCount}</span>
          <span className="analytics-stat-label">Creatures</span>
        </div>
      </div>

      {/* Mana Curve */}
      <div className="deck-analytics-chart">
        <h4 className="deck-analytics-chart-title">Mana Curve</h4>
        <div className="deck-analytics-bars">
          {cmcKeys.map(k => {
            const count = analytics.cmcCounts[k] || 0;
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
