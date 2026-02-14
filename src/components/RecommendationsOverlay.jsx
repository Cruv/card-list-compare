import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { getDeckRecommendations, getDeckSnapshots, getSnapshot } from '../lib/api';
import { parse } from '../lib/parser';
import { fetchCardData } from '../lib/scryfall';
import { generateRecommendations, getStapleCardNames } from '../lib/recommendations';
import CardLine from './CardLine';
import Skeleton from './Skeleton';
import { toast } from './Toast';
import './RecommendationsOverlay.css';

const CATEGORIES = ['All', 'Ramp', 'Card Draw', 'Removal', 'Board Wipe', 'Protection', 'Lands', 'Recursion'];

export default function RecommendationsOverlay({ deckId, deckName, onClose }) {
  const [loading, setLoading] = useState(true);
  const [recommendations, setRecommendations] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [cardMap, setCardMap] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // Fetch deck recommendations + snapshot list in parallel (independent calls)
        const [data, snapshotsData] = await Promise.all([
          getDeckRecommendations(deckId),
          getDeckSnapshots(deckId),
        ]);

        if (cancelled) return;

        // Build a cardMap from server data
        const serverCardMap = new Map();
        if (data.cardData) {
          for (const [key, val] of Object.entries(data.cardData)) {
            serverCardMap.set(key, val);
          }
        }

        // Also fetch staple card data from Scryfall (client-side) for images + metadata
        const stapleNames = getStapleCardNames();
        const allNames = [...new Set([...stapleNames, ...Object.keys(data.cardData || {})])].filter(Boolean);
        const fullCardMap = await fetchCardData(allNames);

        if (cancelled) return;

        // Merge server card data (has colorIdentity) into fullCardMap
        for (const [key, val] of serverCardMap) {
          const existing = fullCardMap.get(key);
          if (existing) {
            existing.colorIdentity = val.colorIdentity || existing.colorIdentity || [];
            if (!existing.priceUsd && val.priceUsd) existing.priceUsd = val.priceUsd;
          } else {
            fullCardMap.set(key, {
              type: val.type || 'Other',
              manaCost: val.manaCost || '',
              imageUri: '',
              priceUsd: val.priceUsd || null,
              priceUsdFoil: val.priceUsdFoil || null,
              colorIdentity: val.colorIdentity || [],
            });
          }
        }

        setCardMap(fullCardMap);

        // Fetch snapshot detail (depends on snapshotsData result)
        if (snapshotsData.snapshots && snapshotsData.snapshots.length > 0) {
          const latestSnapshot = snapshotsData.snapshots[0];
          const snapDetail = await getSnapshot(deckId, latestSnapshot.id);

          if (cancelled) return;

          const parsed = parse(snapDetail.snapshot.deck_text);
          const result = generateRecommendations(parsed, fullCardMap, data.commanders || []);
          setRecommendations(result.recommendations);
          setAnalysis(result.analysis);
        }
      } catch (err) {
        if (!cancelled) {
          toast.error('Failed to load recommendations');
          console.error('Recommendations error:', err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [deckId]);

  // Escape to close
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const filtered = useMemo(() => {
    let list = recommendations;
    if (categoryFilter !== 'All') {
      list = list.filter(r => r.category === categoryFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(r => (r.name || '').toLowerCase().includes(q) || (r.reason || '').toLowerCase().includes(q));
    }
    return list;
  }, [recommendations, categoryFilter, searchQuery]);

  const categoryCounts = useMemo(() => {
    const counts = {};
    for (const r of recommendations) {
      counts[r.category] = (counts[r.category] || 0) + 1;
    }
    return counts;
  }, [recommendations]);

  return createPortal(
    <div className="recs-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="recs-overlay-panel">
        {/* Header */}
        <div className="recs-overlay-header">
          <div className="recs-overlay-title-row">
            <h2 className="recs-overlay-title">Suggestions for {deckName}</h2>
            <button className="recs-overlay-close" onClick={onClose} type="button" aria-label="Close">&times;</button>
          </div>
          {analysis && (
            <div className="recs-overlay-analysis">
              <span className="recs-analysis-identity">
                Colors: {analysis.colorIdentity.length > 0 ? analysis.colorIdentity.join('') : 'Colorless'}
              </span>
              {analysis.needs && Object.entries(analysis.needs).map(([cat, data]) => (
                <span
                  key={cat}
                  className={`recs-analysis-need${data.deficit > 0 ? ' recs-analysis-need--deficit' : ''}`}
                  title={`${data.current} / ${data.target} recommended`}
                >
                  {cat}: {data.current}/{data.target}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Filters */}
        <div className="recs-overlay-filters">
          <div className="recs-overlay-categories">
            {CATEGORIES.map(cat => {
              const count = cat === 'All' ? recommendations.length : (categoryCounts[cat] || 0);
              if (cat !== 'All' && count === 0) return null;
              return (
                <button
                  key={cat}
                  className={`recs-category-btn${categoryFilter === cat ? ' recs-category-btn--active' : ''}`}
                  onClick={() => setCategoryFilter(cat)}
                  type="button"
                >
                  {cat} <span className="recs-category-count">{count}</span>
                </button>
              );
            })}
          </div>
          <input
            className="recs-overlay-search"
            type="text"
            placeholder="Search suggestions..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Content */}
        <div className="recs-overlay-content">
          {loading ? (
            <div className="recs-overlay-loading">
              <Skeleton lines={8} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="recs-overlay-empty">
              {recommendations.length === 0
                ? 'No suggestions available for this deck.'
                : 'No suggestions match your filter.'
              }
            </div>
          ) : (
            <div className="recs-card-list">
              {filtered.map(rec => (
                <div key={rec.name} className={`recs-card-item${rec.isBannedInCommander ? ' recs-card-item--banned' : ''}`}>
                  <CardLine
                    name={rec.name}
                    quantity={1}
                    changeType="list"
                    manaCost={rec.manaCost || (rec.name && cardMap?.get(rec.name.toLowerCase())?.manaCost)}
                    imageUri={rec.name && cardMap?.get(rec.name.toLowerCase())?.imageUri}
                  />
                  <div className="recs-card-meta">
                    <span className="recs-card-category">{rec.category}</span>
                    {rec.isBannedInCommander && (
                      <span className="recs-card-badge recs-card-badge--banned" title="Banned in Commander">BANNED</span>
                    )}
                    {rec.isGameChanger && (
                      <span className="recs-card-badge recs-card-badge--game-changer" title="EDHREC Game Changer">&#9889; Game Changer</span>
                    )}
                    <span className="recs-card-reason">{rec.reason}</span>
                    {rec.priceUsd != null && (
                      <span className="recs-card-price">${rec.priceUsd.toFixed(2)}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
