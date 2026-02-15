import { useMemo } from 'react';
import { extractColors, COLOR_CSS, COLOR_LABELS } from '../lib/analytics';
import './ColorDistributionDelta.css';

const COLORS = ['W', 'U', 'B', 'R', 'G', 'C'];

/**
 * ColorDistributionDelta — horizontal bidirectional bars showing color identity changes.
 * Green bars grow right (more pips of that color added).
 * Red bars grow left (pips of that color removed).
 *
 * Props:
 *   diffResult — { mainboard, sideboard } with cardsIn, cardsOut, quantityChanges
 *   cardMap — Scryfall data Map for mana cost lookups
 */
export default function ColorDistributionDelta({ diffResult, cardMap }) {
  const colorDelta = useMemo(() => {
    if (!diffResult || !cardMap || cardMap.size === 0) return null;

    const added = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    const removed = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

    function getCardData(card) {
      const nameLower = (card.name || card.displayName || '').toLowerCase();
      const compositeKey = card.collectorNumber ? `${nameLower}|${card.collectorNumber}` : null;
      return (compositeKey && cardMap.get(compositeKey)) || cardMap.get(nameLower) || null;
    }

    function isLand(data) {
      if (!data) return false;
      const typeLine = (data.typeLine || data.type || '').toLowerCase();
      return typeLine.includes('land');
    }

    function addColors(manaCost, qty, target) {
      const colors = extractColors(manaCost);
      if (colors.length === 0 && manaCost) {
        // Colorless spell (has mana cost but no color symbols)
        target.C += qty;
      } else {
        for (const c of colors) {
          target[c] += qty;
        }
      }
    }

    for (const section of [diffResult.mainboard, diffResult.sideboard]) {
      for (const card of section.cardsIn) {
        const data = getCardData(card);
        if (!data || isLand(data) || !data.manaCost) continue;
        addColors(data.manaCost, card.quantity, added);
      }
      for (const card of section.cardsOut) {
        const data = getCardData(card);
        if (!data || isLand(data) || !data.manaCost) continue;
        addColors(data.manaCost, card.quantity, removed);
      }
      for (const card of section.quantityChanges) {
        const data = getCardData(card);
        if (!data || isLand(data) || !data.manaCost) continue;
        if (card.delta > 0) {
          addColors(data.manaCost, card.delta, added);
        } else {
          addColors(data.manaCost, Math.abs(card.delta), removed);
        }
      }
    }

    const maxVal = Math.max(
      ...COLORS.map(c => added[c]),
      ...COLORS.map(c => removed[c]),
      1
    );
    const hasData = COLORS.some(c => added[c] > 0 || removed[c] > 0);
    if (!hasData) return null;

    return { added, removed, maxVal };
  }, [diffResult, cardMap]);

  if (!colorDelta) return null;

  const { added, removed, maxVal } = colorDelta;

  return (
    <div className="color-delta">
      <div className="color-delta-label">Color Changes</div>
      <div className="color-delta-chart">
        {COLORS.map(color => {
          const addedPct = (added[color] / maxVal) * 100;
          const removedPct = (removed[color] / maxVal) * 100;
          if (added[color] === 0 && removed[color] === 0) return null;

          return (
            <div className="color-delta-row" key={color}>
              <div className="color-delta-pip" style={{ background: COLOR_CSS[color], borderColor: color === 'W' ? '#ddd' : COLOR_CSS[color] }} title={COLOR_LABELS[color]} />
              <div className="color-delta-bars">
                <div className="color-delta-bar-left">
                  {removed[color] > 0 && (
                    <div
                      className="color-delta-bar color-delta-bar--removed"
                      style={{ width: `${removedPct}%` }}
                      title={`-${removed[color]} ${COLOR_LABELS[color]} pips`}
                    >
                      <span className="color-delta-count">-{removed[color]}</span>
                    </div>
                  )}
                </div>
                <div className="color-delta-bar-right">
                  {added[color] > 0 && (
                    <div
                      className="color-delta-bar color-delta-bar--added"
                      style={{ width: `${addedPct}%` }}
                      title={`+${added[color]} ${COLOR_LABELS[color]} pips`}
                    >
                      <span className="color-delta-count">+{added[color]}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
