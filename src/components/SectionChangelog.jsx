import CardLine from './CardLine';
import './SectionChangelog.css';

export default function SectionChangelog({ sectionName, changes }) {
  const { cardsIn, cardsOut, quantityChanges } = changes;
  const isEmpty = cardsIn.length === 0 && cardsOut.length === 0 && quantityChanges.length === 0;

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
          {cardsIn.map((card) => (
            <CardLine
              key={card.name}
              name={card.name}
              quantity={card.quantity}
              changeType="in"
            />
          ))}
        </div>
      )}

      {cardsOut.length > 0 && (
        <div className="section-changelog-group">
          <h4 className="section-changelog-group-title section-changelog-group-title--out">
            Cards Out
            <span className="section-changelog-count">{cardsOut.length}</span>
          </h4>
          {cardsOut.map((card) => (
            <CardLine
              key={card.name}
              name={card.name}
              quantity={card.quantity}
              changeType="out"
            />
          ))}
        </div>
      )}

      {quantityChanges.length > 0 && (
        <div className="section-changelog-group">
          <h4 className="section-changelog-group-title section-changelog-group-title--changed">
            Quantity Changes
            <span className="section-changelog-count">{quantityChanges.length}</span>
          </h4>
          {quantityChanges.map((card) => (
            <CardLine
              key={card.name}
              name={card.name}
              changeType="changed"
              oldQty={card.oldQty}
              newQty={card.newQty}
              delta={card.delta}
            />
          ))}
        </div>
      )}
    </div>
  );
}
