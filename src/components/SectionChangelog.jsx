import { memo, useMemo } from 'react';
import CardLine from './CardLine';
import { groupByType } from '../lib/scryfall';
import './SectionChangelog.css';

function CardGroup({ cards, changeType, cardMap }) {
  return cards.map((card) => {
    // Try composite key first (name|collectorNumber) for per-printing data, fall back to bare name
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
        changeType={changeType}
        oldQty={card.oldQty}
        newQty={card.newQty}
        delta={card.delta}
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
  });
}

function TypeGroupedCards({ cards, changeType, cardMap }) {
  const groups = useMemo(() => groupByType(cards, cardMap), [cards, cardMap]);

  return groups.map(({ type, cards: groupCards }) => (
    <div key={type} className="section-changelog-type-group">
      <span className="section-changelog-type-label">{type}</span>
      <CardGroup cards={groupCards} changeType={changeType} cardMap={cardMap} />
    </div>
  ));
}

export default memo(function SectionChangelog({ sectionName, changes, cardMap }) {
  const { cardsIn, cardsOut, quantityChanges } = changes;
  const isEmpty = cardsIn.length === 0 && cardsOut.length === 0 && quantityChanges.length === 0;
  const hasTypes = cardMap && cardMap.size > 0;

  return (
    <section className="section-changelog" aria-label={`${sectionName} changes`}>
      <h3 className="section-changelog-title">{sectionName}</h3>

      {isEmpty && <p className="section-changelog-empty">No changes</p>}

      {cardsIn.length > 0 && (
        <div className="section-changelog-group">
          <h4 className="section-changelog-group-title section-changelog-group-title--in">
            Cards In
            <span className="section-changelog-count">{cardsIn.length}</span>
          </h4>
          {hasTypes ? (
            <TypeGroupedCards cards={cardsIn} changeType="in" cardMap={cardMap} />
          ) : (
            <CardGroup cards={cardsIn} changeType="in" cardMap={cardMap} />
          )}
        </div>
      )}

      {cardsOut.length > 0 && (
        <div className="section-changelog-group">
          <h4 className="section-changelog-group-title section-changelog-group-title--out">
            Cards Out
            <span className="section-changelog-count">{cardsOut.length}</span>
          </h4>
          {hasTypes ? (
            <TypeGroupedCards cards={cardsOut} changeType="out" cardMap={cardMap} />
          ) : (
            <CardGroup cards={cardsOut} changeType="out" cardMap={cardMap} />
          )}
        </div>
      )}

      {quantityChanges.length > 0 && (
        <div className="section-changelog-group">
          <h4 className="section-changelog-group-title section-changelog-group-title--changed">
            Quantity Changes
            <span className="section-changelog-count">{quantityChanges.length}</span>
          </h4>
          {hasTypes ? (
            <TypeGroupedCards cards={quantityChanges} changeType="changed" cardMap={cardMap} />
          ) : (
            <CardGroup cards={quantityChanges} changeType="changed" cardMap={cardMap} />
          )}
        </div>
      )}
    </section>
  );
});
