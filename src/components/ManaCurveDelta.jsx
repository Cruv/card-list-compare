import { useMemo } from 'react';
import { parseCMC } from '../lib/analytics';
import './ManaCurveDelta.css';

const CMC_LABELS = ['0', '1', '2', '3', '4', '5', '6', '7+'];

/**
 * ManaCurveDelta — bidirectional bar chart showing mana curve changes.
 * Green bars grow up (cards added at that CMC).
 * Red bars grow down (cards removed at that CMC).
 *
 * Props:
 *   diffResult — { mainboard, sideboard } with cardsIn, cardsOut, quantityChanges
 *   cardMap — Scryfall data Map for mana cost lookups
 */
export default function ManaCurveDelta({ diffResult, cardMap }) {
  const curveDelta = useMemo(() => {
    if (!diffResult || !cardMap || cardMap.size === 0) return null;

    const added = new Array(8).fill(0);   // CMC 0-6, 7+
    const removed = new Array(8).fill(0);

    function getManaCost(card) {
      const nameLower = (card.name || card.displayName || '').toLowerCase();
      const compositeKey = card.collectorNumber ? `${nameLower}|${card.collectorNumber}` : null;
      const data = (compositeKey && cardMap.get(compositeKey)) || cardMap.get(nameLower);
      return data?.manaCost || null;
    }

    function isLand(card) {
      const nameLower = (card.name || card.displayName || '').toLowerCase();
      const compositeKey = card.collectorNumber ? `${nameLower}|${card.collectorNumber}` : null;
      const data = (compositeKey && cardMap.get(compositeKey)) || cardMap.get(nameLower);
      if (!data) return false;
      const typeLine = (data.typeLine || data.type || '').toLowerCase();
      return typeLine.includes('land');
    }

    function cmcBucket(cmc) {
      return Math.min(cmc, 7);
    }

    for (const section of [diffResult.mainboard, diffResult.sideboard]) {
      for (const card of section.cardsIn) {
        if (isLand(card)) continue;
        const mc = getManaCost(card);
        if (mc === null) continue;
        const cmc = cmcBucket(parseCMC(mc));
        added[cmc] += card.quantity;
      }
      for (const card of section.cardsOut) {
        if (isLand(card)) continue;
        const mc = getManaCost(card);
        if (mc === null) continue;
        const cmc = cmcBucket(parseCMC(mc));
        removed[cmc] += card.quantity;
      }
      for (const card of section.quantityChanges) {
        if (isLand(card)) continue;
        const mc = getManaCost(card);
        if (mc === null) continue;
        const cmc = cmcBucket(parseCMC(mc));
        if (card.delta > 0) {
          added[cmc] += card.delta;
        } else {
          removed[cmc] += Math.abs(card.delta);
        }
      }
    }

    const maxVal = Math.max(...added, ...removed, 1);
    const hasData = added.some(v => v > 0) || removed.some(v => v > 0);
    if (!hasData) return null;

    return { added, removed, maxVal };
  }, [diffResult, cardMap]);

  if (!curveDelta) return null;

  const { added, removed, maxVal } = curveDelta;

  return (
    <div className="mana-curve-delta">
      <div className="mana-curve-delta-label">Mana Curve Changes</div>
      <div className="mana-curve-delta-chart">
        {CMC_LABELS.map((label, i) => {
          const addedPct = (added[i] / maxVal) * 100;
          const removedPct = (removed[i] / maxVal) * 100;
          return (
            <div className="mana-curve-delta-col" key={i}>
              {/* Added (up) */}
              <div className="mana-curve-delta-bar-up">
                {added[i] > 0 && (
                  <div
                    className="mana-curve-delta-bar mana-curve-delta-bar--added"
                    style={{ height: `${addedPct}%` }}
                    title={`+${added[i]} at CMC ${label}`}
                  >
                    {added[i] > 0 && <span className="mana-curve-delta-count">+{added[i]}</span>}
                  </div>
                )}
              </div>
              {/* Removed (down) */}
              <div className="mana-curve-delta-bar-down">
                {removed[i] > 0 && (
                  <div
                    className="mana-curve-delta-bar mana-curve-delta-bar--removed"
                    style={{ height: `${removedPct}%` }}
                    title={`-${removed[i]} at CMC ${label}`}
                  >
                    {removed[i] > 0 && <span className="mana-curve-delta-count">-{removed[i]}</span>}
                  </div>
                )}
              </div>
              {/* CMC label */}
              <div className="mana-curve-delta-cmc">{label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
