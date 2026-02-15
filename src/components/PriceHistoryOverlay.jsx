import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { getDeckPriceHistory } from '../lib/api';
import PriceHistoryChart from './PriceHistoryChart';
import Skeleton from './Skeleton';
import { toast } from './Toast';
import './PriceHistoryOverlay.css';

/**
 * PriceHistoryOverlay — standalone overlay showing deck price history as a smooth SVG chart.
 *
 * Props:
 *   deckId — tracked deck ID
 *   deckName — display title
 *   onClose — callback
 */
export default function PriceHistoryOverlay({ deckId, deckName, onClose }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);

  // Escape to close
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Prevent body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Load price history data
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result = await getDeckPriceHistory(deckId);
        if (!cancelled) setData(result);
      } catch (err) {
        if (!cancelled) toast.error(err.message || 'Failed to load price history');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [deckId]);

  // Stats
  const stats = useMemo(() => {
    if (!data?.dataPoints?.length) return null;
    const pts = data.dataPoints;
    const prices = pts.map(p => p.price);
    const current = prices[prices.length - 1];
    const first = prices[0];
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const change = current - first;
    const changePct = first > 0 ? ((change / first) * 100) : 0;
    return { current, first, high, low, change, changePct, count: pts.length };
  }, [data]);

  return createPortal(
    <div className="price-history-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Price history">
      <div className="price-history-overlay-panel" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="price-history-overlay-header">
          <div className="price-history-overlay-title-row">
            <button className="price-history-overlay-mobile-back" onClick={onClose} type="button" aria-label="Back">&larr;</button>
            <h2 className="price-history-overlay-title">{deckName || 'Price History'}</h2>
            <button className="price-history-overlay-close" onClick={onClose} type="button" aria-label="Close">&times;</button>
          </div>
          {stats && (
            <div className="price-history-overlay-current">
              <span className="price-history-current-value">${stats.current.toFixed(2)}</span>
              <span className={`price-history-current-change${stats.change >= 0 ? ' price-history-change--up' : ' price-history-change--down'}`}>
                {stats.change >= 0 ? '+' : ''}{stats.change < 0 ? '\u2212' : ''}${Math.abs(stats.change).toFixed(2)}
                {' '}({stats.changePct >= 0 ? '+' : ''}{stats.changePct.toFixed(1)}%)
              </span>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="price-history-overlay-content">
          {loading ? (
            <Skeleton lines={6} />
          ) : !data ? (
            <p className="price-history-overlay-empty">Failed to load price history.</p>
          ) : (
            <>
              <PriceHistoryChart dataPoints={data.dataPoints} />

              {stats && stats.count >= 2 && (
                <div className="price-history-stats">
                  <div className="price-history-stat">
                    <span className="price-history-stat-label">All-Time High</span>
                    <span className="price-history-stat-value price-history-stat--high">${stats.high.toFixed(2)}</span>
                  </div>
                  <div className="price-history-stat">
                    <span className="price-history-stat-label">All-Time Low</span>
                    <span className="price-history-stat-value price-history-stat--low">${stats.low.toFixed(2)}</span>
                  </div>
                  <div className="price-history-stat">
                    <span className="price-history-stat-label">First Recorded</span>
                    <span className="price-history-stat-value">${stats.first.toFixed(2)}</span>
                  </div>
                  <div className="price-history-stat">
                    <span className="price-history-stat-label">Data Points</span>
                    <span className="price-history-stat-value">{stats.count}</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
