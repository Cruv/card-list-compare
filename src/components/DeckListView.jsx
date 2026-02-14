import { memo, useMemo } from 'react';
import { useAppSettings } from '../context/AppSettingsContext';
import CardLine from './CardLine';
import { groupByType } from '../lib/scryfall';
import './DeckListView.css';

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
    const compositeKey = card.collectorNumber
      ? `${card.name.toLowerCase()}|${card.collectorNumber}`
      : null;
    const data = (compositeKey && cardMap?.get(compositeKey)) || cardMap?.get(card.name.toLowerCase());
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

export default memo(function DeckListView({ parsedDeck, cardMap, searchQuery }) {
  if (!parsedDeck) return null;

  const { priceDisplayEnabled } = useAppSettings();
  const { mainboard, sideboard, commanders } = parsedDeck;

  const deckPrice = useMemo(() => priceDisplayEnabled ? computeDeckPrice(parsedDeck, cardMap) : null, [parsedDeck, cardMap, priceDisplayEnabled]);

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
        </div>
      )}
      <DeckSection sectionName="Mainboard" cards={filteredMainboard} cardMap={cardMap} />
      {filteredSideboard.size > 0 && <DeckSection sectionName="Sideboard" cards={filteredSideboard} cardMap={cardMap} />}
    </div>
  );
});
