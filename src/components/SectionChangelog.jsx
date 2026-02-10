import { memo, useMemo } from 'react';
import CardLine from './CardLine';
import { groupByType } from '../lib/scryfall';
import './SectionChangelog.css';

function CardGroup({ cards, changeType }) {
  return cards.map((card) => (
    <CardLine
      key={card.name}
      name={card.name}
      quantity={card.quantity}
      changeType={changeType}
      oldQty={card.oldQty}
      newQty={card.newQty}
      delta={card.delta}
    />
  ));
}

function TypeGroupedCards({ cards, changeType, typeMap }) {
  const groups = useMemo(() => groupByType(cards, typeMap), [cards, typeMap]);

  return groups.map(({ type, cards: groupCards }) => (
    <div key={type} className="section-changelog-type-group">
      <span className="section-changelog-type-label">{type}</span>
      <CardGroup cards={groupCards} changeType={changeType} />
    </div>
  ));
}

export default memo(function SectionChangelog({ sectionName, changes, typeMap }) {
  const { cardsIn, cardsOut, quantityChanges } = changes;
  const isEmpty = cardsIn.length === 0 && cardsOut.length === 0 && quantityChanges.length === 0;
  const hasTypes = typeMap && typeMap.size > 0;

  return (
    <div className="section-changelog">
      <h3 className="section-changelog-title">{sectionName}</h3>

      {isEmpty && <p className="section-changelog-empty">No changes</p>}

      {cardsIn.length > 0 && (
        <div className="section-changelog-group">
          <h4 className="section-changelog-group-title section-changelog-group-title--in">
            Cards In
            <span className="section-changelog-count">{cardsIn.length}</span>
          </h4>
          {hasTypes ? (
            <TypeGroupedCards cards={cardsIn} changeType="in" typeMap={typeMap} />
          ) : (
            <CardGroup cards={cardsIn} changeType="in" />
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
            <TypeGroupedCards cards={cardsOut} changeType="out" typeMap={typeMap} />
          ) : (
            <CardGroup cards={cardsOut} changeType="out" />
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
            <TypeGroupedCards cards={quantityChanges} changeType="changed" typeMap={typeMap} />
          ) : (
            <CardGroup cards={quantityChanges} changeType="changed" />
          )}
        </div>
      )}
    </div>
  );
});
