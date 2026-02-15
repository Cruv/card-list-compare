import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { mpcSearch, mpcDownloadXml, mpcDownloadZip } from '../lib/api';
import { toast } from './Toast';
import Skeleton from './Skeleton';
import './MpcOverlay.css';

const CARDSTOCK_OPTIONS = [
  { value: '(S30) Standard Smooth', label: 'Standard Smooth' },
  { value: '(S33) Superior Smooth', label: 'Superior Smooth' },
  { value: '(S27) Smooth', label: 'Smooth' },
  { value: '(M31) Linen', label: 'Linen' },
  { value: '(P10) Plastic', label: 'Plastic' },
];

/**
 * MpcOverlay — search MPC Autofill for proxy card images and download
 * XML project files or image ZIPs.
 *
 * Props:
 *   cards — array of { name, quantity } (from formatDeckForMpc)
 *   deckName — display title
 *   onClose — callback
 */
export default function MpcOverlay({ cards, deckName, onClose }) {
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [downloading, setDownloading] = useState(null); // 'xml' | 'zip' | null
  const [cardstock, setCardstock] = useState('(S30) Standard Smooth');
  const [foil, setFoil] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Escape closes overlay
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Search MPC Autofill on mount
  useEffect(() => {
    let cancelled = false;
    async function doSearch() {
      setLoading(true);
      setError(null);
      try {
        const data = await mpcSearch(cards);
        if (!cancelled) setResults(data);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (cards && cards.length > 0) {
      doSearch();
    } else {
      setLoading(false);
      setError('No cards to search for.');
    }
    return () => { cancelled = true; };
  }, [cards]);

  // Filter results by search query
  const filteredResults = useMemo(() => {
    if (!results?.results) return [];
    if (!searchQuery) return results.results;
    const q = searchQuery.toLowerCase();
    return results.results.filter(r => r.name.toLowerCase().includes(q));
  }, [results, searchQuery]);

  const matchedResults = useMemo(
    () => filteredResults.filter(r => r.hasMatch),
    [filteredResults]
  );
  const unmatchedResults = useMemo(
    () => filteredResults.filter(r => !r.hasMatch),
    [filteredResults]
  );

  // Cards with identifiers for download
  const downloadableCards = useMemo(() => {
    if (!results?.results) return [];
    return results.results
      .filter(r => r.hasMatch && r.identifier)
      .map(r => ({
        name: r.name,
        quantity: r.quantity,
        identifier: r.identifier,
        extension: r.extension || 'png',
      }));
  }, [results]);

  const handleDownloadXml = useCallback(async () => {
    if (downloadableCards.length === 0) return;
    setDownloading('xml');
    try {
      await mpcDownloadXml(downloadableCards, cardstock, foil);
      toast.success('XML project file downloaded!');
    } catch (err) {
      toast.error(err.message || 'Failed to download XML.');
    } finally {
      setDownloading(null);
    }
  }, [downloadableCards, cardstock, foil]);

  const handleDownloadZip = useCallback(async () => {
    if (downloadableCards.length === 0) return;
    setDownloading('zip');
    try {
      await mpcDownloadZip(downloadableCards);
      toast.success('Card images downloaded!');
    } catch (err) {
      toast.error(err.message || 'Failed to download images.');
    } finally {
      setDownloading(null);
    }
  }, [downloadableCards]);

  return createPortal(
    <div className="mpc-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Print Proxies">
      <div className="mpc-overlay-panel" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="mpc-overlay-header">
          <div className="mpc-overlay-title-row">
            <button className="mpc-overlay-back" onClick={onClose} type="button" aria-label="Back">&larr;</button>
            <div className="mpc-overlay-title-group">
              <h2 className="mpc-overlay-title">Print Proxies</h2>
              {deckName && <span className="mpc-overlay-deck-name">{deckName}</span>}
            </div>
            <button className="mpc-overlay-close" onClick={onClose} type="button" aria-label="Close">&times;</button>
          </div>
          {!loading && results && (
            <div className="mpc-overlay-summary">
              <span className="mpc-summary-badge mpc-summary-badge--matched">
                {results.matchedCards} matched
              </span>
              {results.unmatchedCount > 0 && (
                <span className="mpc-summary-badge mpc-summary-badge--unmatched">
                  {results.unmatchedCount} not found
                </span>
              )}
              <span className="mpc-summary-badge mpc-summary-badge--total">
                {results.totalCards} total
              </span>
            </div>
          )}
        </div>

        {/* Search filter */}
        {!loading && results && results.results.length > 0 && (
          <div className="mpc-overlay-toolbar">
            <div className="mpc-overlay-search">
              <input
                type="text"
                className="mpc-search-input"
                placeholder="Filter cards..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                aria-label="Filter cards"
              />
              {searchQuery && (
                <button
                  type="button"
                  className="mpc-search-clear"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear"
                >
                  &times;
                </button>
              )}
            </div>
          </div>
        )}

        {/* Content */}
        <div className="mpc-overlay-content">
          {loading ? (
            <div className="mpc-loading">
              <Skeleton lines={6} />
              <p className="mpc-loading-text">Searching MPC Autofill for card images...</p>
            </div>
          ) : error ? (
            <p className="mpc-overlay-error">{error}</p>
          ) : !results ? (
            <p className="mpc-overlay-empty">No results.</p>
          ) : (
            <>
              {/* Matched cards grid */}
              {matchedResults.length > 0 && (
                <div className="mpc-card-grid">
                  {matchedResults.map(card => (
                    <div key={card.name} className="mpc-card">
                      <div className="mpc-card-img-wrap">
                        <img
                          src={card.thumbnailUrl}
                          alt={card.name}
                          className="mpc-card-img"
                          loading="lazy"
                          crossOrigin="anonymous"
                          referrerPolicy="no-referrer"
                        />
                        {card.quantity > 1 && (
                          <span className="mpc-card-qty">&times;{card.quantity}</span>
                        )}
                      </div>
                      <div className="mpc-card-info">
                        <span className="mpc-card-name">{card.name}</span>
                        <span className="mpc-card-meta">
                          {card.sourceName && <span>{card.sourceName}</span>}
                          {card.dpi && <span>{card.dpi} DPI</span>}
                          {card.alternateCount > 0 && (
                            <span className="mpc-card-alts">+{card.alternateCount} alt{card.alternateCount !== 1 ? 's' : ''}</span>
                          )}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Unmatched cards */}
              {unmatchedResults.length > 0 && (
                <div className="mpc-unmatched">
                  <h3 className="mpc-unmatched-title">Not Found ({unmatchedResults.length})</h3>
                  <div className="mpc-unmatched-list">
                    {unmatchedResults.map(card => (
                      <span key={card.name} className="mpc-unmatched-card">
                        {card.quantity > 1 && `${card.quantity}x `}{card.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Action bar */}
        {!loading && downloadableCards.length > 0 && (
          <div className="mpc-overlay-actions">
            <div className="mpc-actions-options">
              <label className="mpc-actions-option">
                <span className="mpc-actions-label">Cardstock</span>
                <select
                  value={cardstock}
                  onChange={e => setCardstock(e.target.value)}
                  className="mpc-actions-select"
                >
                  {CARDSTOCK_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label className="mpc-actions-option mpc-actions-checkbox">
                <input
                  type="checkbox"
                  checked={foil}
                  onChange={e => setFoil(e.target.checked)}
                />
                <span>Foil</span>
              </label>
            </div>
            <div className="mpc-actions-buttons">
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleDownloadXml}
                disabled={!!downloading}
                type="button"
                title="Download XML project file for the MPC Autofill desktop tool"
              >
                {downloading === 'xml' ? 'Generating...' : 'Download XML'}
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleDownloadZip}
                disabled={!!downloading}
                type="button"
                title="Download all card images as a ZIP file"
              >
                {downloading === 'zip' ? 'Downloading...' : 'Download Images (ZIP)'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
