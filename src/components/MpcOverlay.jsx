import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { mpcSearch, mpcDownloadXml, mpcDownloadZip, mpcGetSources, mpcGetLanguages, mpcGetTags, mpcGetAlternates } from '../lib/api';
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

const SETTINGS_KEY = 'clc-mpc-settings';
const OVERRIDES_KEY_PREFIX = 'clc-mpc-overrides-';

function loadOverrides(deckId) {
  if (!deckId) return new Map();
  try {
    const stored = localStorage.getItem(OVERRIDES_KEY_PREFIX + deckId);
    if (!stored) return new Map();
    const entries = JSON.parse(stored);
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function saveOverrides(deckId, overridesMap) {
  if (!deckId) return;
  try {
    if (overridesMap.size === 0) {
      localStorage.removeItem(OVERRIDES_KEY_PREFIX + deckId);
    } else {
      localStorage.setItem(OVERRIDES_KEY_PREFIX + deckId, JSON.stringify([...overridesMap]));
    }
  } catch { /* ignore quota errors */ }
}

function getDefaultSettings() {
  return {
    searchTypeSettings: {
      fuzzySearch: false,
      filterCardbacks: false,
    },
    filterSettings: {
      minimumDPI: 0,
      maximumDPI: 1500,
      maximumSize: 30,
      languages: [],
      includesTags: [],
      excludesTags: ['NSFW'],
    },
    sourceSettings: {
      sources: [], // empty = all sources, default order
    },
  };
}

function loadSettings() {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (!stored) return getDefaultSettings();
    const parsed = JSON.parse(stored);
    // Merge with defaults to handle schema changes
    const defaults = getDefaultSettings();
    return {
      searchTypeSettings: { ...defaults.searchTypeSettings, ...parsed.searchTypeSettings },
      filterSettings: { ...defaults.filterSettings, ...parsed.filterSettings },
      sourceSettings: { ...defaults.sourceSettings, ...parsed.sourceSettings },
    };
  } catch {
    return getDefaultSettings();
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* ignore quota errors */ }
}

function isNonDefault(settings) {
  const d = getDefaultSettings();
  if (settings.searchTypeSettings.fuzzySearch !== d.searchTypeSettings.fuzzySearch) return true;
  if (settings.filterSettings.minimumDPI !== d.filterSettings.minimumDPI) return true;
  if (settings.filterSettings.maximumDPI !== d.filterSettings.maximumDPI) return true;
  if (settings.filterSettings.maximumSize !== d.filterSettings.maximumSize) return true;
  if (settings.filterSettings.languages.length > 0) return true;
  if (settings.filterSettings.includesTags.length > 0) return true;
  if (JSON.stringify(settings.filterSettings.excludesTags) !== JSON.stringify(d.filterSettings.excludesTags)) return true;
  if (settings.sourceSettings.sources.length > 0) return true;
  return false;
}

/**
 * MpcOverlay — search MPC Autofill for proxy card images and download
 * XML project files or image ZIPs. Includes configurable search settings.
 */
export default function MpcOverlay({ cards, deckName, deckId, onClose }) {
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [downloading, setDownloading] = useState(null); // 'xml' | 'zip' | null
  const [cardstock, setCardstock] = useState('(S30) Standard Smooth');
  const [foil, setFoil] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Settings state
  const [searchSettings, setSearchSettings] = useState(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [draftSettings, setDraftSettings] = useState(null); // working copy while settings panel is open

  // Metadata for settings panel (lazy loaded)
  const [sources, setSources] = useState(null);
  const [languages, setLanguages] = useState(null);
  const [tags, setTags] = useState(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const metaLoaded = useRef(false);

  // DFC back-face state
  const [dfcPairs, setDfcPairs] = useState({});
  const [dfcBackResults, setDfcBackResults] = useState([]);

  // Alt art picker state
  const [altPickerCard, setAltPickerCard] = useState(null);
  const [altLoading, setAltLoading] = useState(false);
  const [alternates, setAlternates] = useState([]);
  const [overrides, setOverrides] = useState(() => loadOverrides(deckId));

  // Escape closes overlay (or settings/alt picker panel if open)
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        if (altPickerCard) { setAltPickerCard(null); setAlternates([]); }
        else if (showSettings) setShowSettings(false);
        else onClose();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, showSettings, altPickerCard]);

  // Search MPC Autofill
  const doSearch = useCallback(async (settings) => {
    if (!cards || cards.length === 0) {
      setLoading(false);
      setError('No cards to search for.');
      return;
    }
    setLoading(true);
    setError(null);
    setResults(null);
    // Don't clear overrides — prune after results arrive
    setAltPickerCard(null);
    setAlternates([]);
    setDfcPairs({});
    setDfcBackResults([]);
    try {
      // Only pass settings if non-default (saves bandwidth, uses server defaults)
      const settingsToSend = isNonDefault(settings) ? settings : null;
      const data = await mpcSearch(cards, settingsToSend);
      setResults(data);

      // Prune overrides: keep only cards still in results
      if (deckId && data.results) {
        const resultNames = new Set(data.results.map(r => r.name.toLowerCase()));
        setOverrides(prev => {
          const pruned = new Map();
          for (const [key, val] of prev) {
            if (resultNames.has(key)) pruned.set(key, val);
          }
          saveOverrides(deckId, pruned);
          return pruned;
        });
      }

      // Store DFC pairs and back-face results (server handles back-face search)
      setDfcPairs(data.dfcPairs || {});
      setDfcBackResults(data.dfcBackResults || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [cards]);

  // Initial search on mount
  useEffect(() => {
    let cancelled = false;
    doSearch(searchSettings).then(() => {
      if (cancelled) return;
    });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load metadata when settings panel opens
  useEffect(() => {
    if (!showSettings || metaLoaded.current) return;
    metaLoaded.current = true;
    setMetaLoading(true);
    Promise.all([mpcGetSources(), mpcGetLanguages(), mpcGetTags()])
      .then(([srcData, langData, tagData]) => {
        setSources(srcData.sources || []);
        setLanguages(langData.languages || []);
        setTags(tagData.tags || []);
      })
      .catch(() => {
        toast.error('Failed to load search settings metadata');
      })
      .finally(() => setMetaLoading(false));
  }, [showSettings]);

  // Filter results by search query (includes DFC back faces interleaved after their fronts)
  const filteredResults = useMemo(() => {
    if (!results?.results) return [];
    const q = searchQuery ? searchQuery.toLowerCase() : null;

    // Build combined list: front faces with DFC backs inserted after their fronts
    const combined = [];
    for (const r of results.results) {
      if (q && !r.name.toLowerCase().includes(q)) continue;
      combined.push(r);
      // Insert DFC back face after its front face
      if (dfcBackResults.length > 0) {
        const backFace = dfcBackResults.find(
          b => b.dfcFrontName && b.dfcFrontName.toLowerCase() === r.name.toLowerCase()
        );
        if (backFace && (!q || backFace.name.toLowerCase().includes(q))) {
          combined.push(backFace);
        }
      }
    }
    return combined;
  }, [results, searchQuery, dfcBackResults]);

  // Merge overrides into filtered results
  const effectiveResults = useMemo(() => {
    return filteredResults.map(r => {
      const override = overrides.get(r.name.toLowerCase());
      if (!override) return r;
      return {
        ...r,
        identifier: override.identifier,
        thumbnailUrl: override.thumbnailUrl,
        dpi: override.dpi,
        sourceName: override.sourceName,
        extension: override.extension,
      };
    });
  }, [filteredResults, overrides]);

  const matchedResults = useMemo(
    () => effectiveResults.filter(r => r.hasMatch),
    [effectiveResults]
  );
  const unmatchedResults = useMemo(
    () => effectiveResults.filter(r => !r.hasMatch),
    [effectiveResults]
  );

  // Cards with identifiers for download (merges overrides + DFC backs)
  const downloadableCards = useMemo(() => {
    if (!results?.results) return [];
    const cards = results.results
      .filter(r => r.hasMatch && r.identifier)
      .map(r => {
        const override = overrides.get(r.name.toLowerCase());
        return {
          name: r.name,
          quantity: r.quantity,
          identifier: override?.identifier || r.identifier,
          extension: override?.extension || r.extension || 'png',
        };
      });
    // Add DFC back faces (quantity matches their front face)
    for (const back of dfcBackResults) {
      if (!back.identifier) continue;
      const frontCard = results.results.find(
        r => r.hasMatch && back.dfcFrontName && r.name.toLowerCase() === back.dfcFrontName.toLowerCase()
      );
      const override = overrides.get(back.name.toLowerCase());
      cards.push({
        name: back.name,
        quantity: frontCard?.quantity || 1,
        identifier: override?.identifier || back.identifier,
        extension: override?.extension || back.extension || 'png',
      });
    }
    return cards;
  }, [results, overrides, dfcBackResults]);

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

  // Settings panel handlers
  function handleOpenSettings() {
    setDraftSettings(JSON.parse(JSON.stringify(searchSettings)));
    setShowSettings(true);
  }

  function handleSaveSettings() {
    setSearchSettings(draftSettings);
    saveSettings(draftSettings);
    setShowSettings(false);
    // Re-search with new settings
    doSearch(draftSettings);
  }

  function handleResetSettings() {
    const defaults = getDefaultSettings();
    setDraftSettings(defaults);
  }

  // Alt art picker handlers
  async function handleCardClick(card) {
    if (!card.hasMatch || card.alternateCount === 0) return;
    setAltPickerCard(card);
    setAltLoading(true);
    setAlternates([]);
    try {
      const settingsToSend = isNonDefault(searchSettings) ? searchSettings : null;
      const data = await mpcGetAlternates(card.name, settingsToSend);
      setAlternates(data.alternates || []);
    } catch {
      toast.error('Failed to load alternate arts.');
      setAltPickerCard(null);
    } finally {
      setAltLoading(false);
    }
  }

  function handleSelectAlternate(alt) {
    if (!altPickerCard) return;
    const nameLower = altPickerCard.name.toLowerCase();
    setOverrides(prev => {
      const next = new Map(prev);
      next.set(nameLower, {
        identifier: alt.identifier,
        thumbnailUrl: alt.thumbnailUrl,
        dpi: alt.dpi,
        sourceName: alt.sourceName,
        extension: alt.extension,
      });
      saveOverrides(deckId, next);
      return next;
    });
    setAltPickerCard(null);
    setAlternates([]);
  }

  function handleResetOverrides() {
    setOverrides(new Map());
    saveOverrides(deckId, new Map());
    toast.success('Art choices reset');
  }

  function updateDraft(path, value) {
    setDraftSettings(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const keys = path.split('.');
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
      obj[keys[keys.length - 1]] = value;
      return next;
    });
  }

  function toggleTagInList(listPath, tagName) {
    setDraftSettings(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const keys = listPath.split('.');
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
      const list = obj[keys[keys.length - 1]];
      const idx = list.indexOf(tagName);
      if (idx >= 0) list.splice(idx, 1);
      else list.push(tagName);
      return next;
    });
  }

  function toggleGroupTags(listPath, groupTagNames, oppositeListPath) {
    setDraftSettings(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const keys = listPath.split('.');
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
      const list = obj[keys[keys.length - 1]];

      // Get opposite list to filter out disabled tags
      const oppKeys = oppositeListPath.split('.');
      let oppObj = next;
      for (let i = 0; i < oppKeys.length - 1; i++) oppObj = oppObj[oppKeys[i]];
      const oppList = oppObj[oppKeys[oppKeys.length - 1]];

      // Only consider tags not in the opposite list
      const eligible = groupTagNames.filter(n => !oppList.includes(n));
      if (eligible.length === 0) return prev;

      const allSelected = eligible.every(n => list.includes(n));
      if (allSelected) {
        // Deselect all eligible
        for (const n of eligible) {
          const idx = list.indexOf(n);
          if (idx >= 0) list.splice(idx, 1);
        }
      } else {
        // Select all eligible that aren't already selected
        for (const n of eligible) {
          if (!list.includes(n)) list.push(n);
        }
      }
      return next;
    });
  }

  function moveSource(index, direction) {
    setDraftSettings(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const arr = next.sourceSettings.sources;
      const newIdx = index + direction;
      if (newIdx < 0 || newIdx >= arr.length) return prev;
      [arr[index], arr[newIdx]] = [arr[newIdx], arr[index]];
      return next;
    });
  }

  function toggleSource(index) {
    setDraftSettings(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      next.sourceSettings.sources[index][1] = !next.sourceSettings.sources[index][1];
      return next;
    });
  }

  // Initialize source list in draft when sources load and draft has empty sources
  useEffect(() => {
    if (draftSettings && sources && draftSettings.sourceSettings.sources.length === 0) {
      setDraftSettings(prev => {
        const next = JSON.parse(JSON.stringify(prev));
        next.sourceSettings.sources = sources.map(s => [s.pk, true]);
        return next;
      });
    }
  }, [sources, draftSettings]);

  // Build source name lookup
  const sourceNameMap = useMemo(() => {
    if (!sources) return new Map();
    return new Map(sources.map(s => [s.pk, s.name]));
  }, [sources]);

  // Group tags by parent for UI
  const tagsByParent = useMemo(() => {
    if (!tags) return new Map();
    const groups = new Map();
    for (const tag of tags) {
      if (tag.parent === null) continue; // skip top-level categories
      const parent = tag.parent || 'Other';
      if (!groups.has(parent)) groups.set(parent, []);
      // Only include leaf tags (no children)
      if (tag.children.length === 0) {
        groups.get(parent).push(tag.name);
      }
    }
    return groups;
  }, [tags]);

  const hasCustomSettings = isNonDefault(searchSettings);

  return createPortal(
    <div className="mpc-overlay" onClick={showSettings || altPickerCard ? undefined : onClose} role="dialog" aria-modal="true" aria-label="Print Proxies">
      <div className="mpc-overlay-panel" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="mpc-overlay-header">
          <div className="mpc-overlay-title-row">
            {(altPickerCard || showSettings) && (
              <button
                className="mpc-overlay-back mpc-overlay-back--visible"
                onClick={altPickerCard ? () => { setAltPickerCard(null); setAlternates([]); } : () => setShowSettings(false)}
                type="button"
                aria-label="Back"
              >&larr;</button>
            )}
            <div className="mpc-overlay-title-group">
              <h2 className="mpc-overlay-title">
                {altPickerCard ? 'Choose Art' : showSettings ? 'Search Settings' : 'Print Proxies'}
              </h2>
              {altPickerCard && <span className="mpc-overlay-deck-name">{altPickerCard.name}</span>}
              {!altPickerCard && !showSettings && deckName && <span className="mpc-overlay-deck-name">{deckName}</span>}
            </div>
            {!showSettings && !altPickerCard && (
              <button
                className={`mpc-overlay-settings-btn${hasCustomSettings ? ' mpc-overlay-settings-btn--active' : ''}`}
                onClick={handleOpenSettings}
                type="button"
                aria-label="Search settings"
                title="Search settings"
              >
                &#x2699;
                {hasCustomSettings && <span className="mpc-settings-dot" />}
              </button>
            )}
            <button className="mpc-overlay-close" onClick={onClose} type="button" aria-label="Close">&times;</button>
          </div>
          {!showSettings && !altPickerCard && !loading && results && (
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
              {dfcBackResults.length > 0 && (
                <span className="mpc-summary-badge mpc-summary-badge--dfc">
                  {dfcBackResults.length} back face{dfcBackResults.length !== 1 ? 's' : ''}
                </span>
              )}
              {overrides.size > 0 && (
                <span className="mpc-summary-badge mpc-summary-badge--overrides">
                  {overrides.size} customized
                </span>
              )}
            </div>
          )}
        </div>

        {/* Settings Panel */}
        {showSettings && (
          <>
            <div className="mpc-overlay-content mpc-settings-content">
              {metaLoading ? (
                <Skeleton lines={8} />
              ) : (
                <div className="mpc-settings-sections">
                  {/* Search Type */}
                  <div className="mpc-settings-section">
                    <h3 className="mpc-settings-section-title">Search Type</h3>
                    <div className="mpc-settings-toggle-group">
                      <button
                        className={`mpc-settings-toggle${!draftSettings?.searchTypeSettings.fuzzySearch ? ' mpc-settings-toggle--active' : ''}`}
                        onClick={() => updateDraft('searchTypeSettings.fuzzySearch', false)}
                        type="button"
                      >
                        Precise
                      </button>
                      <button
                        className={`mpc-settings-toggle${draftSettings?.searchTypeSettings.fuzzySearch ? ' mpc-settings-toggle--active' : ''}`}
                        onClick={() => updateDraft('searchTypeSettings.fuzzySearch', true)}
                        type="button"
                      >
                        Fuzzy
                      </button>
                    </div>
                    <p className="mpc-settings-hint">Fuzzy search is more forgiving of name variations</p>
                  </div>

                  {/* Filters */}
                  <div className="mpc-settings-section">
                    <h3 className="mpc-settings-section-title">Filters</h3>
                    <div className="mpc-settings-range-row">
                      <label className="mpc-settings-label">
                        Min DPI
                        <input
                          type="number"
                          className="mpc-settings-number"
                          value={draftSettings?.filterSettings.minimumDPI ?? 0}
                          onChange={e => updateDraft('filterSettings.minimumDPI', Math.max(0, parseInt(e.target.value) || 0))}
                          min={0}
                          max={1500}
                          step={50}
                        />
                      </label>
                      <label className="mpc-settings-label">
                        Max DPI
                        <input
                          type="number"
                          className="mpc-settings-number"
                          value={draftSettings?.filterSettings.maximumDPI ?? 1500}
                          onChange={e => updateDraft('filterSettings.maximumDPI', Math.max(0, parseInt(e.target.value) || 1500))}
                          min={0}
                          max={1500}
                          step={50}
                        />
                      </label>
                      <label className="mpc-settings-label">
                        Max Size (MB)
                        <input
                          type="number"
                          className="mpc-settings-number"
                          value={draftSettings?.filterSettings.maximumSize ?? 30}
                          onChange={e => updateDraft('filterSettings.maximumSize', Math.max(0, parseInt(e.target.value) || 30))}
                          min={0}
                          max={30}
                          step={1}
                        />
                      </label>
                    </div>
                  </div>

                  {/* Languages */}
                  {languages && languages.length > 0 && (
                    <div className="mpc-settings-section">
                      <h3 className="mpc-settings-section-title">Languages</h3>
                      <p className="mpc-settings-hint">No selection = all languages</p>
                      <div className="mpc-settings-chip-list">
                        {languages.map(lang => {
                          const selected = draftSettings?.filterSettings.languages.includes(lang.code);
                          return (
                            <button
                              key={lang.code}
                              className={`mpc-settings-chip${selected ? ' mpc-settings-chip--active' : ''}`}
                              onClick={() => {
                                const list = [...(draftSettings?.filterSettings.languages || [])];
                                const idx = list.indexOf(lang.code);
                                if (idx >= 0) list.splice(idx, 1);
                                else list.push(lang.code);
                                updateDraft('filterSettings.languages', list);
                              }}
                              type="button"
                            >
                              {lang.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Include Tags */}
                  {tagsByParent.size > 0 && (
                    <div className="mpc-settings-section">
                      <h3 className="mpc-settings-section-title">Include Tags</h3>
                      <p className="mpc-settings-hint">Cards must have at least one selected tag. Click a category name to toggle all.</p>
                      {[...tagsByParent.entries()].map(([parent, tagNames]) => {
                        const eligible = tagNames.filter(n => !draftSettings?.filterSettings.excludesTags.includes(n));
                        const allSelected = eligible.length > 0 && eligible.every(n => draftSettings?.filterSettings.includesTags.includes(n));
                        return (
                          <div key={parent} className="mpc-settings-tag-group">
                            <button
                              className={`mpc-settings-tag-group-label mpc-settings-tag-group-label--clickable${allSelected ? ' mpc-settings-tag-group-label--active' : ''}`}
                              onClick={() => toggleGroupTags('filterSettings.includesTags', tagNames, 'filterSettings.excludesTags')}
                              type="button"
                              title={allSelected ? `Deselect all ${parent} tags` : `Select all ${parent} tags`}
                            >
                              {parent}
                            </button>
                            <div className="mpc-settings-chip-list">
                              {tagNames.map(name => {
                                const selected = draftSettings?.filterSettings.includesTags.includes(name);
                                const excluded = draftSettings?.filterSettings.excludesTags.includes(name);
                                return (
                                  <button
                                    key={name}
                                    className={`mpc-settings-chip${selected ? ' mpc-settings-chip--active' : ''}${excluded ? ' mpc-settings-chip--disabled' : ''}`}
                                    onClick={() => {
                                      if (excluded) return;
                                      toggleTagInList('filterSettings.includesTags', name);
                                    }}
                                    type="button"
                                    disabled={excluded}
                                  >
                                    {name}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Exclude Tags */}
                  {tagsByParent.size > 0 && (
                    <div className="mpc-settings-section">
                      <h3 className="mpc-settings-section-title">Exclude Tags</h3>
                      <p className="mpc-settings-hint">Cards must not have any selected tag. Click a category name to toggle all.</p>
                      {[...tagsByParent.entries()].map(([parent, tagNames]) => {
                        const eligible = tagNames.filter(n => !draftSettings?.filterSettings.includesTags.includes(n));
                        const allSelected = eligible.length > 0 && eligible.every(n => draftSettings?.filterSettings.excludesTags.includes(n));
                        return (
                          <div key={parent} className="mpc-settings-tag-group">
                            <button
                              className={`mpc-settings-tag-group-label mpc-settings-tag-group-label--clickable${allSelected ? ' mpc-settings-tag-group-label--active' : ''}`}
                              onClick={() => toggleGroupTags('filterSettings.excludesTags', tagNames, 'filterSettings.includesTags')}
                              type="button"
                              title={allSelected ? `Deselect all ${parent} tags` : `Select all ${parent} tags`}
                            >
                              {parent}
                            </button>
                            <div className="mpc-settings-chip-list">
                              {tagNames.map(name => {
                                const selected = draftSettings?.filterSettings.excludesTags.includes(name);
                                const included = draftSettings?.filterSettings.includesTags.includes(name);
                                return (
                                  <button
                                    key={name}
                                    className={`mpc-settings-chip mpc-settings-chip--exclude${selected ? ' mpc-settings-chip--active' : ''}${included ? ' mpc-settings-chip--disabled' : ''}`}
                                    onClick={() => {
                                      if (included) return;
                                      toggleTagInList('filterSettings.excludesTags', name);
                                    }}
                                    type="button"
                                    disabled={included}
                                  >
                                    {name}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Sources */}
                  {draftSettings?.sourceSettings.sources.length > 0 && (
                    <div className="mpc-settings-section">
                      <h3 className="mpc-settings-section-title">Sources</h3>
                      <p className="mpc-settings-hint">Order = search priority. Toggle to enable/disable.</p>
                      <div className="mpc-settings-source-actions">
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setDraftSettings(prev => {
                              const next = JSON.parse(JSON.stringify(prev));
                              next.sourceSettings.sources = next.sourceSettings.sources.map(([pk]) => [pk, true]);
                              return next;
                            });
                          }}
                          type="button"
                        >
                          Enable all
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setDraftSettings(prev => {
                              const next = JSON.parse(JSON.stringify(prev));
                              next.sourceSettings.sources = next.sourceSettings.sources.map(([pk]) => [pk, false]);
                              return next;
                            });
                          }}
                          type="button"
                        >
                          Disable all
                        </button>
                      </div>
                      <div className="mpc-settings-source-list">
                        {draftSettings.sourceSettings.sources.map(([pk, enabled], i) => (
                          <div key={pk} className={`mpc-settings-source${enabled ? '' : ' mpc-settings-source--disabled'}`}>
                            <button
                              className={`mpc-settings-source-toggle${enabled ? ' mpc-settings-source-toggle--on' : ''}`}
                              onClick={() => toggleSource(i)}
                              type="button"
                              aria-label={enabled ? 'Disable source' : 'Enable source'}
                            >
                              {enabled ? 'On' : 'Off'}
                            </button>
                            <span className="mpc-settings-source-name">{sourceNameMap.get(pk) || `Source #${pk}`}</span>
                            <div className="mpc-settings-source-arrows">
                              <button
                                className="mpc-settings-arrow"
                                onClick={() => moveSource(i, -1)}
                                disabled={i === 0}
                                type="button"
                                aria-label="Move up"
                              >
                                &#x2227;
                              </button>
                              <button
                                className="mpc-settings-arrow"
                                onClick={() => moveSource(i, 1)}
                                disabled={i === draftSettings.sourceSettings.sources.length - 1}
                                type="button"
                                aria-label="Move down"
                              >
                                &#x2228;
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Settings action bar */}
            <div className="mpc-overlay-actions mpc-settings-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => setShowSettings(false)} type="button">
                Cancel
              </button>
              <button className="btn btn-secondary btn-sm" onClick={handleResetSettings} type="button">
                Reset to Defaults
              </button>
              <button className="btn btn-primary btn-sm" onClick={handleSaveSettings} type="button">
                Save &amp; Re-search
              </button>
            </div>
          </>
        )}

        {/* Alt Art Picker */}
        {altPickerCard && !showSettings && (
          <div className="mpc-overlay-content">
            {altLoading ? (
              <div className="mpc-loading">
                <Skeleton lines={4} />
                <p className="mpc-loading-text">Loading alternate arts...</p>
              </div>
            ) : (
              <>
                <p className="mpc-alt-picker-hint">
                  {alternates.length} version{alternates.length !== 1 ? 's' : ''} available &mdash; tap to select
                </p>
                <div className="mpc-alt-grid">
                  {alternates.map((alt, i) => {
                    const currentId = overrides.get(altPickerCard.name.toLowerCase())?.identifier || altPickerCard.identifier;
                    const isSelected = currentId === alt.identifier;
                    return (
                      <div
                        key={alt.identifier}
                        className={`mpc-alt-card${isSelected ? ' mpc-alt-card--selected' : ''}`}
                        onClick={() => handleSelectAlternate(alt)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelectAlternate(alt); } }}
                      >
                        <div className="mpc-alt-card-img-wrap">
                          <img
                            src={alt.thumbnailUrl}
                            alt={`${altPickerCard.name} version ${i + 1}`}
                            className="mpc-card-img"
                            loading="lazy"
                          />
                          {isSelected && <span className="mpc-alt-selected-badge">&#x2713;</span>}
                        </div>
                        <div className="mpc-card-info">
                          {alt.sourceName && <span className="mpc-alt-source">{alt.sourceName}</span>}
                          {alt.dpi > 0 && <span className="mpc-alt-dpi">{alt.dpi} DPI</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {/* Main content (hidden when settings or alt picker is open) */}
        {!showSettings && !altPickerCard && (
          <>
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
                      {matchedResults.map(card => {
                        const hasAlts = card.alternateCount > 0;
                        return (
                          <div
                            key={card.isDfcBack ? `dfc-back-${card.name}` : card.name}
                            className={`mpc-card${hasAlts ? ' mpc-card--has-alts' : ''}${overrides.has(card.name.toLowerCase()) ? ' mpc-card--overridden' : ''}${card.isDfcBack ? ' mpc-card--dfc-back' : ''}`}
                            onClick={() => handleCardClick(card)}
                            role={hasAlts ? 'button' : undefined}
                            tabIndex={hasAlts ? 0 : undefined}
                            onKeyDown={hasAlts ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCardClick(card); } } : undefined}
                          >
                            <div className="mpc-card-img-wrap">
                              <img
                                src={card.thumbnailUrl}
                                alt={card.name}
                                className="mpc-card-img"
                                loading="lazy"
                              />
                              {card.isDfcBack && (
                                <span className="mpc-card-dfc-badge">Back</span>
                              )}
                              {!card.isDfcBack && card.quantity > 1 && (
                                <span className="mpc-card-qty">&times;{card.quantity}</span>
                              )}
                            </div>
                            <div className="mpc-card-info">
                              <span className="mpc-card-name">{card.name}</span>
                              <span className="mpc-card-meta">
                                {card.sourceName && <span>{card.sourceName}</span>}
                                {card.dpi > 0 && <span>{card.dpi} DPI</span>}
                                {card.alternateCount > 0 && (
                                  <span className="mpc-card-alts">+{card.alternateCount} alt{card.alternateCount !== 1 ? 's' : ''}</span>
                                )}
                              </span>
                            </div>
                          </div>
                        );
                      })}
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
                  {overrides.size > 0 && (
                    <button
                      className="btn btn-ghost-danger btn-sm"
                      onClick={handleResetOverrides}
                      type="button"
                      title="Reset all custom art selections back to defaults"
                    >
                      Reset Art ({overrides.size})
                    </button>
                  )}
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
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
