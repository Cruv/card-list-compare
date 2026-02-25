import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useAppSettings } from '../context/AppSettingsContext';
import { useConfirm } from './ConfirmModal';
import { toast } from './Toast';
import {
  getTrackedDecks, untrackDeck, refreshDeck,
  getDeckSnapshots, deleteSnapshot as apiDeleteSnapshot, renameSnapshot,
  getDeckChangelog, updateDeckCommanders, updateDeckNotify,
  lockSnapshot, unlockSnapshot, setPaperSnapshot, clearPaperSnapshot,
  getDeckTimeline, getSnapshot,
  shareDeck, unshareDeck,
  updateDeckNotes, updateDeckPinned, updateDeckTags,
  updateDeckDiscordWebhook,
  getDeckPrices, updateDeckPriceAlert, updateDeckAutoRefresh,
  submitImageDownload, getDownloadJobStatus, downloadJobFile,
} from '../lib/api';
import { parse } from '../lib/parser';
import { formatChangelog, formatMpcFill, formatReddit, formatJSON, formatForArchidekt, formatTTS, formatDeckForMpc } from '../lib/formatter';
import { fetchCardData, collectCardIdentifiers } from '../lib/scryfall';
import { estimatePowerLevel } from '../lib/powerLevel';
import SectionChangelog from './SectionChangelog';
import ManaCurveDelta from './ManaCurveDelta';
import ColorDistributionDelta from './ColorDistributionDelta';
import DeckListView from './DeckListView';
import CopyButton from './CopyButton';
import Skeleton from './Skeleton';
import TimelineOverlay from './TimelineOverlay';
import RecommendationsOverlay from './RecommendationsOverlay';
import MpcOverlay from './MpcOverlay';
import PriceHistoryOverlay from './PriceHistoryOverlay';
import './DeckPage.css';

function formatDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z'));
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z')).toLocaleString();
}

function filterSection(section, query) {
  if (!query) return section;
  const lower = query.toLowerCase();
  return {
    cardsIn: section.cardsIn.filter(c => c.name.toLowerCase().includes(lower)),
    cardsOut: section.cardsOut.filter(c => c.name.toLowerCase().includes(lower)),
    quantityChanges: section.quantityChanges.filter(c => c.name.toLowerCase().includes(lower)),
    printingChanges: (section.printingChanges || []).filter(c => c.name.toLowerCase().includes(lower)),
    totalUniqueCards: section.totalUniqueCards,
    unchangedCount: section.unchangedCount,
  };
}

function collectDeckIdentifiers(parsedDeck) {
  const identifiers = new Map();
  for (const section of [parsedDeck.mainboard, parsedDeck.sideboard]) {
    for (const [, entry] of section) {
      const nameLower = entry.displayName.toLowerCase();
      if (entry.setCode && entry.collectorNumber) {
        const compositeKey = `${nameLower}|${entry.collectorNumber}`;
        if (!identifiers.has(compositeKey)) {
          identifiers.set(compositeKey, {
            name: entry.displayName,
            set: entry.setCode.toLowerCase(),
            collector_number: entry.collectorNumber,
          });
        }
      }
      if (!identifiers.has(nameLower)) {
        identifiers.set(nameLower, { name: entry.displayName });
      }
    }
  }
  return identifiers;
}

export default function DeckPage({ deckId }) {
  const { user } = useAuth();
  const { priceDisplayEnabled } = useAppSettings();
  const [confirm, ConfirmDialog] = useConfirm();

  // Core data
  const [deck, setDeck] = useState(null);
  const [loading, setLoading] = useState(true);
  const [snapshots, setSnapshots] = useState([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Tabs
  const [activeTab, setActiveTab] = useState('snapshots');

  // Commander editing
  const [editingCommander, setEditingCommander] = useState(false);
  const [commanderValue, setCommanderValue] = useState('');
  const [savingCommander, setSavingCommander] = useState(false);

  // Notes editing
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);

  // Tags editing
  const [editingTags, setEditingTags] = useState(false);
  const [tagInput, setTagInput] = useState('');

  // Snapshot editing
  const [editingNickname, setEditingNickname] = useState(null);
  const [nicknameValue, setNicknameValue] = useState('');

  // Compare mode
  const [compareMode, setCompareMode] = useState(false);
  const [compareA, setCompareA] = useState('');
  const [compareB, setCompareB] = useState('');

  // Changelog tab state (lazy loaded)
  const [changelogData, setChangelogData] = useState(null);
  const [changelogCardMap, setChangelogCardMap] = useState(null);
  const [changelogTexts, setChangelogTexts] = useState(null);
  const [changelogLoading, setChangelogLoading] = useState(false);
  const [changelogSearch, setChangelogSearch] = useState('');

  // Comparison overlay (for snapshot comparison)
  const [comparisonDiff, setComparisonDiff] = useState(null);
  const [comparisonCardMap, setComparisonCardMap] = useState(null);
  const [comparisonTexts, setComparisonTexts] = useState(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonSearch, setComparisonSearch] = useState('');

  // Timeline tab state
  const [timelineData, setTimelineData] = useState(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [overlayEntry, setOverlayEntry] = useState(null);

  // Full deck tab state
  const [parsedDeck, setParsedDeck] = useState(null);
  const [deckCardMap, setDeckCardMap] = useState(null);
  const [deckText, setDeckText] = useState(null);
  const [deckLoading, setDeckLoading] = useState(false);

  // Analytics tab state
  const [priceData, setPriceData] = useState(null);
  const [loadingPrices, setLoadingPrices] = useState(false);
  const [showRecommendations, setShowRecommendations] = useState(false);
  const [showMpc, setShowMpc] = useState(false);
  const [mpcCards, setMpcCards] = useState(null);
  const [showPriceHistory, setShowPriceHistory] = useState(false);

  // Settings tab
  const [editingWebhook, setEditingWebhook] = useState(false);
  const [webhookValue, setWebhookValue] = useState('');
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [editingPriceAlert, setEditingPriceAlert] = useState(false);
  const [priceAlertValue, setPriceAlertValue] = useState('');
  const [priceAlertMode, setPriceAlertMode] = useState('specific');
  const [savingPriceAlert, setSavingPriceAlert] = useState(false);

  // Download state
  const [downloadJob, setDownloadJob] = useState(null);
  const downloadPollRef = useRef(null);

  // Parse commanders from deck
  const commanders = useMemo(() => {
    if (!deck) return [];
    try { return JSON.parse(deck.commanders || '[]'); } catch { return []; }
  }, [deck]);

  // --- Data loading ---

  const loadDeck = useCallback(async () => {
    try {
      const data = await getTrackedDecks();
      const found = data.decks.find(d => d.id === deckId);
      if (!found) {
        toast.error('Deck not found');
        window.location.hash = '#library';
        return;
      }
      setDeck(found);
    } catch (err) {
      toast.error('Failed to load deck');
    }
  }, [deckId]);

  const loadSnapshots = useCallback(async () => {
    setSnapshotsLoading(true);
    try {
      const data = await getDeckSnapshots(deckId);
      setSnapshots(data.snapshots);
    } catch {
      toast.error('Failed to load snapshots');
    } finally {
      setSnapshotsLoading(false);
    }
  }, [deckId]);

  useEffect(() => {
    async function init() {
      setLoading(true);
      await Promise.all([loadDeck(), loadSnapshots()]);
      setLoading(false);
    }
    init();
  }, [loadDeck, loadSnapshots]);

  // Sync settings tab defaults when deck loads
  useEffect(() => {
    if (deck) {
      setWebhookValue(deck.discord_webhook_url || '');
      setPriceAlertValue(deck.price_alert_threshold ?? '');
      setPriceAlertMode(deck.price_alert_mode || 'specific');
      setNotesValue(deck.notes || '');
    }
  }, [deck]);

  // Cleanup download polling
  useEffect(() => {
    return () => {
      if (downloadPollRef.current) {
        clearInterval(downloadPollRef.current);
        downloadPollRef.current = null;
      }
    };
  }, []);

  // --- Tab data loading ---

  useEffect(() => {
    if (activeTab === 'changelog' && !changelogData && !changelogLoading) {
      loadChangelog();
    } else if (activeTab === 'timeline' && !timelineData && !timelineLoading) {
      loadTimeline();
    } else if (activeTab === 'fulldeck' && !parsedDeck && !deckLoading) {
      loadFullDeck();
    }
  }, [activeTab]);

  async function loadChangelog() {
    setChangelogLoading(true);
    try {
      const data = await getDeckChangelog(deckId);
      setChangelogData(data.diff);
      setChangelogTexts({ beforeText: data.before.deck_text, afterText: data.after.deck_text });
      const identifiers = collectCardIdentifiers(data.diff);
      if (identifiers.size > 0) {
        const cm = await fetchCardData(identifiers);
        setChangelogCardMap(cm);
      }
    } catch (err) {
      toast.error(err.message || 'Failed to load changelog');
    } finally {
      setChangelogLoading(false);
    }
  }

  async function loadTimeline() {
    setTimelineLoading(true);
    try {
      const data = await getDeckTimeline(deckId);
      setTimelineData(data.entries);
    } catch {
      toast.error('Failed to load timeline');
    } finally {
      setTimelineLoading(false);
    }
  }

  async function loadFullDeck() {
    if (snapshots.length === 0) return;
    setDeckLoading(true);
    try {
      const data = await getSnapshot(deckId, snapshots[0].id);
      const rawText = data.snapshot.deck_text;
      setDeckText(rawText);
      const parsed = parse(rawText);
      setParsedDeck(parsed);
      const identifiers = collectDeckIdentifiers(parsed);
      if (identifiers.size > 0) {
        const cm = await fetchCardData(identifiers);
        setDeckCardMap(cm);
      }
    } catch {
      toast.error('Failed to load deck list');
    } finally {
      setDeckLoading(false);
    }
  }

  // --- Actions ---

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const result = await refreshDeck(deckId);
      toast(result.changed ? 'New snapshot saved!' : 'No changes detected.', result.changed ? 'success' : 'info');
      await Promise.all([loadDeck(), loadSnapshots()]);
      // Reset cached tab data so it reloads
      setChangelogData(null); setChangelogCardMap(null); setChangelogTexts(null);
      setParsedDeck(null); setDeckCardMap(null); setDeckText(null);
      setTimelineData(null);
    } catch (err) {
      toast.error(err.message || 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleUntrack() {
    const confirmed = await confirm({
      title: 'Untrack this deck?',
      message: `All snapshots for "${deck?.deck_name || 'this deck'}" will be permanently deleted.`,
      confirmLabel: 'Untrack',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await untrackDeck(deckId);
      toast.success('Deck untracked');
      window.location.hash = '#library';
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleTogglePin() {
    try {
      await updateDeckPinned(deckId, !deck.pinned);
      toast.success(deck.pinned ? 'Unpinned' : 'Pinned to top');
      await loadDeck();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleSaveCommanders() {
    setSavingCommander(true);
    try {
      const cmds = commanderValue.split(',').map(c => c.trim()).filter(Boolean);
      await updateDeckCommanders(deckId, cmds);
      toast.success(cmds.length > 0 ? 'Commanders updated' : 'Commanders cleared');
      setEditingCommander(false);
      await loadDeck();
    } catch (err) {
      toast.error(err.message || 'Failed to update commanders');
    } finally {
      setSavingCommander(false);
    }
  }

  async function handleSaveNotes() {
    setSavingNotes(true);
    try {
      await updateDeckNotes(deckId, notesValue.trim() || null);
      toast.success('Notes saved');
      setEditingNotes(false);
      await loadDeck();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingNotes(false);
    }
  }

  async function handleAddTag(tag) {
    const trimmed = tag.trim().toLowerCase();
    if (!trimmed) return;
    const currentTags = deck.tags || [];
    if (currentTags.includes(trimmed)) return;
    try {
      await updateDeckTags(deckId, [...currentTags, trimmed]);
      setTagInput('');
      await loadDeck();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleRemoveTag(tag) {
    const currentTags = deck.tags || [];
    try {
      await updateDeckTags(deckId, currentTags.filter(t => t !== tag));
      await loadDeck();
    } catch (err) {
      toast.error(err.message);
    }
  }

  // Snapshot actions
  async function handleDeleteSnapshot(snapshotId) {
    const confirmed = await confirm({
      title: 'Delete snapshot?',
      message: 'This snapshot will be permanently deleted.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await apiDeleteSnapshot(deckId, snapshotId);
      toast.success('Snapshot deleted');
      await Promise.all([loadSnapshots(), loadDeck()]);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleToggleLock(snapshotId, isLocked) {
    try {
      if (isLocked) {
        if (deck?.paper_snapshot_id === snapshotId) {
          toast('Warning: unlocking your paper snapshot may allow it to be auto-pruned', 'info', 5000);
        }
        await unlockSnapshot(deckId, snapshotId);
        toast.success('Snapshot unlocked');
      } else {
        await lockSnapshot(deckId, snapshotId);
        toast.success('Snapshot locked');
      }
      await loadSnapshots();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleTogglePaper(snapshotId, isPaper) {
    try {
      if (isPaper) {
        await clearPaperSnapshot(deckId);
        toast.success('Paper marker removed');
      } else {
        const result = await setPaperSnapshot(deckId, snapshotId);
        toast.success(result.autoLocked ? 'Marked as paper deck (auto-locked)' : 'Marked as paper deck');
      }
      await Promise.all([loadDeck(), loadSnapshots()]);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleSaveNickname(snapshotId) {
    try {
      await renameSnapshot(deckId, snapshotId, nicknameValue || null);
      setEditingNickname(null);
      await loadSnapshots();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleCompareSnapshots() {
    if (!compareA || !compareB) return;
    setComparisonLoading(true);
    setComparisonSearch('');
    try {
      const data = await getDeckChangelog(deckId, compareA, compareB);
      setComparisonDiff(data.diff);
      setComparisonTexts({ beforeText: data.before.deck_text, afterText: data.after.deck_text });
      const identifiers = collectCardIdentifiers(data.diff);
      if (identifiers.size > 0) {
        const cm = await fetchCardData(identifiers);
        setComparisonCardMap(cm);
      }
    } catch (err) {
      toast.error(err.message || 'Failed to load comparison');
    } finally {
      setComparisonLoading(false);
    }
  }

  async function handleCompareToPaper() {
    if (!deck?.paper_snapshot_id || snapshots.length === 0) return;
    const latestId = snapshots[0].id;
    if (latestId === deck.paper_snapshot_id) {
      toast('Paper version is already the latest snapshot', 'info');
      return;
    }
    setCompareA(String(deck.paper_snapshot_id));
    setCompareB(String(latestId));
    setCompareMode(true);
    // Auto-trigger comparison
    setComparisonLoading(true);
    setComparisonSearch('');
    try {
      const data = await getDeckChangelog(deckId, deck.paper_snapshot_id, latestId);
      setComparisonDiff(data.diff);
      setComparisonTexts({ beforeText: data.before.deck_text, afterText: data.after.deck_text });
      const identifiers = collectCardIdentifiers(data.diff);
      if (identifiers.size > 0) {
        const cm = await fetchCardData(identifiers);
        setComparisonCardMap(cm);
      }
    } catch (err) {
      toast.error(err.message || 'Failed to load comparison');
    } finally {
      setComparisonLoading(false);
    }
  }

  // Share
  async function handleShareDeck() {
    try {
      const data = await shareDeck(deckId);
      const url = `${window.location.origin}${window.location.pathname}#deck/${data.shareId}`;
      await navigator.clipboard.writeText(url);
      toast.success('Share link copied to clipboard');
      await loadDeck();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleUnshareDeck() {
    try {
      await unshareDeck(deckId);
      toast.success('Deck is no longer shared');
      await loadDeck();
    } catch (err) {
      toast.error(err.message);
    }
  }

  // Settings actions
  async function handleSaveWebhook() {
    setSavingWebhook(true);
    try {
      await updateDeckDiscordWebhook(deckId, webhookValue.trim() || null);
      toast.success(webhookValue.trim() ? 'Webhook saved' : 'Webhook removed');
      setEditingWebhook(false);
      await loadDeck();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingWebhook(false);
    }
  }

  async function handleSavePriceAlert() {
    setSavingPriceAlert(true);
    try {
      const threshold = priceAlertValue === '' ? null : parseFloat(priceAlertValue);
      await updateDeckPriceAlert(deckId, threshold, priceAlertMode);
      toast.success(threshold ? `Price alert set at $${threshold}` : 'Price alert removed');
      setEditingPriceAlert(false);
      await loadDeck();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingPriceAlert(false);
    }
  }

  async function handleCheckPrices() {
    setLoadingPrices(true);
    try {
      const data = await getDeckPrices(deckId);
      setPriceData(data);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoadingPrices(false);
    }
  }

  async function handlePrintProxies() {
    try {
      if (snapshots.length === 0) {
        toast.error('No snapshots available');
        return;
      }
      const snapshotDetail = await getSnapshot(deckId, snapshots[0].id);
      const parsed = parse(snapshotDetail.snapshot.deck_text);
      const cards = formatDeckForMpc(parsed);
      if (cards.length === 0) {
        toast.error('No cards found in the deck');
        return;
      }
      setMpcCards(cards);
      setShowMpc(true);
    } catch {
      toast.error('Failed to load deck for proxy printing');
    }
  }

  function startDownloadPolling(jobId) {
    if (downloadPollRef.current) clearInterval(downloadPollRef.current);
    downloadPollRef.current = setInterval(async () => {
      try {
        const status = await getDownloadJobStatus(deckId, jobId);
        setDownloadJob(status);
        if (status.status === 'completed') {
          clearInterval(downloadPollRef.current);
          downloadPollRef.current = null;
          try {
            await downloadJobFile(deckId, jobId, deck.deck_name);
            toast.success('Card images downloaded!');
          } catch (dlErr) {
            toast.error(dlErr.message || 'Failed to download ZIP');
          }
          setTimeout(() => setDownloadJob(null), 2000);
        } else if (status.status === 'failed') {
          clearInterval(downloadPollRef.current);
          downloadPollRef.current = null;
          toast.error(status.error || 'Image download failed');
          setTimeout(() => setDownloadJob(null), 3000);
        }
      } catch {
        clearInterval(downloadPollRef.current);
        downloadPollRef.current = null;
        toast.error('Lost connection to download job');
        setDownloadJob(null);
      }
    }, 3000);
  }

  async function handleDownloadImages() {
    try {
      const result = await submitImageDownload(deckId);
      setDownloadJob(result);
      if (result.status === 'completed' && result.downloadUrl) {
        try {
          await downloadJobFile(deckId, result.jobId, deck.deck_name);
          toast.success('Card images downloaded!');
        } catch (dlErr) {
          toast.error(dlErr.message || 'Failed to download ZIP');
        }
        setTimeout(() => setDownloadJob(null), 2000);
        return;
      }
      toast.info('Download queued — preparing your card images...');
      startDownloadPolling(result.jobId);
    } catch (err) {
      toast.error(err.message || 'Failed to start image download');
      setDownloadJob(null);
    }
  }

  // Timeline entry click
  function handleTimelineEntryClick(entry, index) {
    const prevId = index > 0 ? timelineData[index - 1].snapshotId : null;
    setOverlayEntry({ entry, prevSnapshotId: prevId });
  }

  // --- Changelog computed values ---

  const filteredChangelogMain = useMemo(
    () => changelogData ? filterSection(changelogData.mainboard, changelogSearch) : null,
    [changelogData, changelogSearch]
  );
  const filteredChangelogSide = useMemo(
    () => changelogData ? filterSection(changelogData.sideboard, changelogSearch) : null,
    [changelogData, changelogSearch]
  );

  const changelogStats = useMemo(() => {
    if (!changelogData) return { totalIn: 0, totalOut: 0, totalChanged: 0, totalPrinting: 0, noChanges: true };
    const mb = changelogData.mainboard;
    const sb = changelogData.sideboard;
    const tIn = mb.cardsIn.length + sb.cardsIn.length;
    const tOut = mb.cardsOut.length + sb.cardsOut.length;
    const tChanged = mb.quantityChanges.length + sb.quantityChanges.length;
    const tPrinting = (mb.printingChanges || []).length + (sb.printingChanges || []).length;
    return { totalIn: tIn, totalOut: tOut, totalChanged: tChanged, totalPrinting: tPrinting, noChanges: tIn === 0 && tOut === 0 && tChanged === 0 && tPrinting === 0 };
  }, [changelogData]);

  const changelogForExport = useMemo(() => {
    if (!changelogData) return null;
    return { mainboard: changelogData.mainboard, sideboard: changelogData.sideboard, hasSideboard: changelogData.hasSideboard, commanders: commanders || [] };
  }, [changelogData, commanders]);

  // Comparison computed values
  const filteredCompMain = useMemo(
    () => comparisonDiff ? filterSection(comparisonDiff.mainboard, comparisonSearch) : null,
    [comparisonDiff, comparisonSearch]
  );
  const filteredCompSide = useMemo(
    () => comparisonDiff ? filterSection(comparisonDiff.sideboard, comparisonSearch) : null,
    [comparisonDiff, comparisonSearch]
  );
  const comparisonStats = useMemo(() => {
    if (!comparisonDiff) return { totalIn: 0, totalOut: 0, totalChanged: 0, totalPrinting: 0, noChanges: true };
    const mb = comparisonDiff.mainboard;
    const sb = comparisonDiff.sideboard;
    const tIn = mb.cardsIn.length + sb.cardsIn.length;
    const tOut = mb.cardsOut.length + sb.cardsOut.length;
    const tChanged = mb.quantityChanges.length + sb.quantityChanges.length;
    const tPrinting = (mb.printingChanges || []).length + (sb.printingChanges || []).length;
    return { totalIn: tIn, totalOut: tOut, totalChanged: tChanged, totalPrinting: tPrinting, noChanges: tIn === 0 && tOut === 0 && tChanged === 0 && tPrinting === 0 };
  }, [comparisonDiff]);
  const comparisonForExport = useMemo(() => {
    if (!comparisonDiff) return null;
    return { mainboard: comparisonDiff.mainboard, sideboard: comparisonDiff.sideboard, hasSideboard: comparisonDiff.hasSideboard, commanders: commanders || [] };
  }, [comparisonDiff, commanders]);

  // --- Render ---

  if (loading) {
    return (
      <div className="deck-page">
        <button className="deck-page-back" onClick={() => { window.location.hash = '#library'; }} type="button">
          &larr; Back to Library
        </button>
        <Skeleton lines={10} />
      </div>
    );
  }

  if (!deck) {
    return (
      <div className="deck-page">
        <button className="deck-page-back" onClick={() => { window.location.hash = '#library'; }} type="button">
          &larr; Back to Library
        </button>
        <p className="deck-page-empty">Deck not found.</p>
      </div>
    );
  }

  return (
    <div className="deck-page">
      {ConfirmDialog}

      {/* Back + action bar */}
      <div className="deck-page-topbar">
        <button className="deck-page-back" onClick={() => { window.location.hash = '#library'; }} type="button">
          &larr; Back to Library
        </button>
        <div className="deck-page-topbar-actions">
          <button className="btn btn-primary btn-sm" onClick={handleRefresh} disabled={refreshing} type="button">
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          {deck.deck_url && (
            <a href={deck.deck_url} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm">
              Archidekt
            </a>
          )}
          <button className="btn btn-sm btn-ghost-danger" onClick={handleUntrack} type="button">
            Untrack
          </button>
        </div>
      </div>

      {/* Header */}
      <div className="deck-page-header">
        <div className="deck-page-header-top">
          <h1 className="deck-page-name">{deck.deck_name}</h1>
          <div className="deck-page-header-badges">
            {priceDisplayEnabled && deck.last_known_price > 0 && (
              <div className="deck-page-prices">
                <span className="deck-page-price-badge">${deck.last_known_price.toFixed(2)}</span>
                {deck.last_known_budget_price != null && deck.last_known_budget_price > 0 && Math.abs(deck.last_known_budget_price - deck.last_known_price) >= 0.01 && (
                  <span className="deck-page-budget-price">Cheapest printing: ${deck.last_known_budget_price.toFixed(2)}</span>
                )}
              </div>
            )}
            <button
              className={`deck-page-pin-btn${deck.pinned ? ' deck-page-pin-btn--active' : ''}`}
              onClick={handleTogglePin}
              type="button"
              title={deck.pinned ? 'Unpin' : 'Pin to top'}
            >
              {'\u{1F4CC}'}
            </button>
          </div>
        </div>

        {/* Commander */}
        <div className="deck-page-commander">
          {editingCommander ? (
            <div className="deck-page-commander-edit">
              <input
                type="text"
                value={commanderValue}
                onChange={e => setCommanderValue(e.target.value)}
                placeholder="Commander name(s), comma-separated"
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSaveCommanders();
                  if (e.key === 'Escape') setEditingCommander(false);
                }}
                disabled={savingCommander}
                autoFocus
              />
              <button className="btn btn-primary btn-sm" onClick={handleSaveCommanders} disabled={savingCommander} type="button">
                {savingCommander ? '...' : 'Save'}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setEditingCommander(false)} type="button">Cancel</button>
            </div>
          ) : (
            <div className="deck-page-commander-display">
              {commanders.length > 0 ? (
                <span className="deck-page-commander-names">{commanders.join(' / ')}</span>
              ) : (
                <span className="deck-page-commander-warn">No commander set</span>
              )}
              <button
                className="deck-page-edit-btn"
                onClick={() => { setEditingCommander(true); setCommanderValue(commanders.join(', ')); }}
                type="button"
                title="Edit commander(s)"
              >
                &#9998;
              </button>
            </div>
          )}
        </div>

        {/* Meta line */}
        <div className="deck-page-meta">
          <span className="deck-page-meta-owner">@{deck.archidekt_username}</span>
          <span className="deck-page-meta-sep">&middot;</span>
          <span>{deck.snapshot_count} snapshot{deck.snapshot_count !== 1 ? 's' : ''}</span>
          {deck.share_id && (
            <>
              <span className="deck-page-meta-sep">&middot;</span>
              <span className="deck-page-shared-badge">Shared</span>
            </>
          )}
          {deck.paper_snapshot_id && (
            <>
              <span className="deck-page-meta-sep">&middot;</span>
              <span className="deck-page-paper-badge">Paper</span>
            </>
          )}
          {deck.latest_snapshot_at && (
            <>
              <span className="deck-page-meta-sep">&middot;</span>
              <span className="deck-page-meta-date">Last Updated: {formatDate(deck.latest_snapshot_at)}</span>
            </>
          )}
        </div>

        {/* Tags */}
        <div className="deck-page-tags">
          {(deck.tags || []).map(tag => (
            <span key={tag} className="deck-tag">
              {tag}
              {editingTags && (
                <button className="deck-tag-remove" onClick={() => handleRemoveTag(tag)} type="button" title="Remove tag">&times;</button>
              )}
            </span>
          ))}
          {editingTags ? (
            <span className="deck-tag-input-wrap">
              <input
                className="deck-tag-input"
                type="text"
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); handleAddTag(tagInput); }
                  if (e.key === 'Escape') setEditingTags(false);
                }}
                placeholder="Add tag..."
                autoFocus
              />
              <button className="btn btn-secondary btn-sm" onClick={() => setEditingTags(false)} type="button">Done</button>
            </span>
          ) : (
            <button className="deck-tag-edit-btn" onClick={() => setEditingTags(true)} type="button" title="Edit tags">+ tag</button>
          )}
        </div>

        {/* Notes */}
        {(deck.notes || editingNotes) && (
          <div className="deck-page-notes">
            {editingNotes ? (
              <div className="deck-page-notes-edit">
                <textarea
                  value={notesValue}
                  onChange={e => setNotesValue(e.target.value)}
                  placeholder="Deck notes..."
                  rows={3}
                  maxLength={2000}
                  disabled={savingNotes}
                />
                <div className="deck-page-notes-actions">
                  <button className="btn btn-primary btn-sm" onClick={handleSaveNotes} disabled={savingNotes} type="button">
                    {savingNotes ? '...' : 'Save'}
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => { setEditingNotes(false); setNotesValue(deck.notes || ''); }} type="button">Cancel</button>
                </div>
              </div>
            ) : (
              <div
                className="deck-page-notes-display"
                onClick={() => { setEditingNotes(true); setNotesValue(deck.notes || ''); }}
                title="Click to edit notes"
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter') { setEditingNotes(true); setNotesValue(deck.notes || ''); } }}
              >
                {deck.notes}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tabs */}
      <nav className="deck-page-tabs">
        {['snapshots', 'changelog', 'timeline', 'fulldeck', 'analytics', 'settings'].map(tab => (
          <button
            key={tab}
            className={`deck-page-tab${activeTab === tab ? ' deck-page-tab--active' : ''}`}
            onClick={() => setActiveTab(tab)}
            type="button"
          >
            {{
              snapshots: 'Snapshots',
              changelog: 'Changelog',
              timeline: 'Timeline',
              fulldeck: 'Full Deck',
              analytics: 'Analytics',
              settings: 'Settings',
            }[tab]}
          </button>
        ))}
      </nav>

      {/* Tab content */}
      <div className="deck-page-content">

        {/* ── Snapshots Tab ── */}
        {activeTab === 'snapshots' && (
          <div className="deck-page-tab-panel">
            <div className="deck-page-snapshot-actions">
              {deck.paper_snapshot_id && (
                <button className="btn btn-primary btn-sm" onClick={handleCompareToPaper} type="button">
                  Paper vs. Latest
                </button>
              )}
              <button
                className={`btn btn-secondary btn-sm${compareMode ? ' btn--active' : ''}`}
                onClick={() => { setCompareMode(!compareMode); setCompareA(''); setCompareB(''); setComparisonDiff(null); }}
                type="button"
              >
                Compare
              </button>
            </div>

            {compareMode && (
              <div className="deck-page-compare">
                <select value={compareA} onChange={e => setCompareA(e.target.value)} aria-label="Select older snapshot">
                  <option value="">Before (older)...</option>
                  {snapshots.map(s => (
                    <option key={s.id} value={s.id}>{s.nickname ? `${s.nickname} (${formatDateTime(s.created_at)})` : formatDateTime(s.created_at)}</option>
                  ))}
                </select>
                <select value={compareB} onChange={e => setCompareB(e.target.value)} aria-label="Select newer snapshot">
                  <option value="">After (newer)...</option>
                  {snapshots.map(s => (
                    <option key={s.id} value={s.id}>{s.nickname ? `${s.nickname} (${formatDateTime(s.created_at)})` : formatDateTime(s.created_at)}</option>
                  ))}
                </select>
                <button className="btn btn-primary btn-sm" onClick={handleCompareSnapshots} disabled={!compareA || !compareB || comparisonLoading} type="button">
                  {comparisonLoading ? 'Loading...' : 'Compare'}
                </button>
              </div>
            )}

            {/* Inline comparison result */}
            {comparisonDiff && (
              <div className="deck-page-inline-diff">
                <div className="deck-page-inline-diff-header">
                  <h3>Snapshot Comparison</h3>
                  <button className="btn btn-secondary btn-sm" onClick={() => setComparisonDiff(null)} type="button">&times;</button>
                </div>
                {!comparisonStats.noChanges && (
                  <>
                    <div className="deck-page-diff-toolbar">
                      <input
                        type="text"
                        className="changelog-search-input"
                        placeholder="Filter cards..."
                        value={comparisonSearch}
                        onChange={e => setComparisonSearch(e.target.value)}
                      />
                      <div className="deck-page-diff-buttons">
                        <CopyButton getText={() => formatChangelog(comparisonForExport, comparisonCardMap)} label="Copy Changelog" />
                        {comparisonTexts && (
                          <CopyButton
                            getText={() => formatForArchidekt(comparisonTexts.afterText, commanders, comparisonTexts.beforeText)}
                            label="Copy for Archidekt"
                            className="copy-btn copy-btn--archidekt"
                          />
                        )}
                      </div>
                    </div>
                    <div className="deck-page-diff-summary">
                      {comparisonStats.totalIn > 0 && <span className="summary-badge summary-badge--in">+{comparisonStats.totalIn} in</span>}
                      {comparisonStats.totalOut > 0 && <span className="summary-badge summary-badge--out">-{comparisonStats.totalOut} out</span>}
                      {comparisonStats.totalChanged > 0 && <span className="summary-badge summary-badge--changed">~{comparisonStats.totalChanged} changed</span>}
                      {comparisonStats.totalPrinting > 0 && <span className="summary-badge summary-badge--printing">&#8635;{comparisonStats.totalPrinting} reprinted</span>}
                    </div>
                  </>
                )}
                {comparisonStats.noChanges ? (
                  <p className="deck-page-empty">No changes between these snapshots.</p>
                ) : (
                  <>
                    {filteredCompMain && <SectionChangelog sectionName="Mainboard" changes={filteredCompMain} cardMap={comparisonCardMap} />}
                    {filteredCompSide && comparisonDiff.hasSideboard && <SectionChangelog sectionName="Sideboard" changes={filteredCompSide} cardMap={comparisonCardMap} />}
                  </>
                )}
              </div>
            )}

            {snapshotsLoading ? (
              <Skeleton lines={5} />
            ) : snapshots.length === 0 ? (
              <p className="deck-page-empty">No snapshots yet. Click Refresh to fetch the current list.</p>
            ) : (
              <ul className="deck-page-snap-list">
                {snapshots.map(snap => (
                  <li key={snap.id} className={`deck-page-snap${snap.locked ? ' deck-page-snap--locked' : ''}${deck.paper_snapshot_id === snap.id ? ' deck-page-snap--paper' : ''}`}>
                    <div className="deck-page-snap-info">
                      {editingNickname === snap.id ? (
                        <span className="deck-page-snap-edit">
                          <input
                            type="text"
                            value={nicknameValue}
                            onChange={e => setNicknameValue(e.target.value)}
                            placeholder="Nickname (optional)"
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleSaveNickname(snap.id);
                              if (e.key === 'Escape') setEditingNickname(null);
                            }}
                            autoFocus
                          />
                          <button className="btn btn-primary btn-sm" onClick={() => handleSaveNickname(snap.id)} type="button">Save</button>
                          <button className="btn btn-secondary btn-sm" onClick={() => setEditingNickname(null)} type="button">Cancel</button>
                        </span>
                      ) : (
                        <>
                          <span className="deck-page-snap-date">{formatDateTime(snap.created_at)}</span>
                          {snap.nickname && <span className="deck-page-snap-nick">{snap.nickname}</span>}
                          {deck.paper_snapshot_id === snap.id && (
                            <span className="deck-page-snap-paper-badge">Paper</span>
                          )}
                        </>
                      )}
                    </div>
                    <div className="deck-page-snap-actions">
                      <button
                        className="deck-page-snap-icon-btn"
                        onClick={() => handleToggleLock(snap.id, !!snap.locked)}
                        type="button"
                        title={snap.locked ? 'Unlock' : 'Lock'}
                      >
                        {snap.locked ? '\uD83D\uDD12' : '\uD83D\uDD13'}
                      </button>
                      <button
                        className={`deck-page-snap-icon-btn${deck.paper_snapshot_id === snap.id ? ' deck-page-snap-icon-btn--active' : ''}`}
                        onClick={() => handleTogglePaper(snap.id, deck.paper_snapshot_id === snap.id)}
                        type="button"
                        title={deck.paper_snapshot_id === snap.id ? 'Remove paper marker' : 'Mark as paper'}
                      >
                        {'\uD83D\uDCCB'}
                      </button>
                      <button
                        className="deck-page-snap-icon-btn"
                        onClick={() => { setEditingNickname(snap.id); setNicknameValue(snap.nickname || ''); }}
                        type="button"
                        title="Edit nickname"
                      >
                        &#9998;
                      </button>
                      <button
                        className="deck-page-snap-icon-btn deck-page-snap-icon-btn--delete"
                        onClick={() => handleDeleteSnapshot(snap.id)}
                        type="button"
                        disabled={!!snap.locked}
                        title={snap.locked ? 'Unlock to delete' : 'Delete'}
                      >
                        &#10005;
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ── Changelog Tab ── */}
        {activeTab === 'changelog' && (
          <div className="deck-page-tab-panel">
            {changelogLoading ? (
              <Skeleton lines={8} />
            ) : !changelogData ? (
              <p className="deck-page-empty">No changelog available. The deck needs at least two snapshots.</p>
            ) : changelogStats.noChanges ? (
              <p className="deck-page-empty">No changes detected between the two most recent snapshots.</p>
            ) : (
              <>
                <div className="deck-page-diff-toolbar">
                  <input
                    type="text"
                    className="changelog-search-input"
                    placeholder="Filter cards..."
                    value={changelogSearch}
                    onChange={e => setChangelogSearch(e.target.value)}
                  />
                  <div className="deck-page-diff-buttons">
                    {[...changelogData.mainboard.cardsIn, ...changelogData.sideboard.cardsIn,
                      ...changelogData.mainboard.quantityChanges.filter(c => c.delta > 0),
                      ...changelogData.sideboard.quantityChanges.filter(c => c.delta > 0)
                    ].length > 0 && (
                      <CopyButton getText={() => formatMpcFill(changelogForExport)} label="Copy for MPCFill" className="copy-btn copy-btn--mpc" />
                    )}
                    <CopyButton getText={() => formatChangelog(changelogForExport, changelogCardMap)} label="Copy Changelog" />
                    {changelogTexts && (
                      <CopyButton
                        getText={() => formatForArchidekt(changelogTexts.afterText, commanders, changelogTexts.beforeText)}
                        label="Copy for Archidekt"
                        className="copy-btn copy-btn--archidekt"
                      />
                    )}
                    <CopyButton getText={() => formatReddit(changelogForExport, changelogCardMap)} label="Copy for Reddit" className="copy-btn copy-btn--reddit" />
                    <CopyButton getText={() => formatJSON(changelogForExport)} label="Copy JSON" className="copy-btn copy-btn--json" />
                  </div>
                </div>

                <div className="deck-page-diff-summary">
                  {changelogStats.totalIn > 0 && <span className="summary-badge summary-badge--in">+{changelogStats.totalIn} in</span>}
                  {changelogStats.totalOut > 0 && <span className="summary-badge summary-badge--out">-{changelogStats.totalOut} out</span>}
                  {changelogStats.totalChanged > 0 && <span className="summary-badge summary-badge--changed">~{changelogStats.totalChanged} changed</span>}
                  {changelogStats.totalPrinting > 0 && <span className="summary-badge summary-badge--printing">&#8635;{changelogStats.totalPrinting} reprinted</span>}
                </div>

                <ManaCurveDelta diffResult={changelogData} cardMap={changelogCardMap} />
                <ColorDistributionDelta diffResult={changelogData} cardMap={changelogCardMap} />
                {filteredChangelogMain && <SectionChangelog sectionName="Mainboard" changes={filteredChangelogMain} cardMap={changelogCardMap} />}
                {filteredChangelogSide && changelogData.hasSideboard && <SectionChangelog sectionName="Sideboard" changes={filteredChangelogSide} cardMap={changelogCardMap} />}
              </>
            )}
          </div>
        )}

        {/* ── Timeline Tab ── */}
        {activeTab === 'timeline' && (
          <div className="deck-page-tab-panel">
            {timelineLoading ? (
              <Skeleton lines={6} />
            ) : !timelineData || timelineData.length === 0 ? (
              <p className="deck-page-empty">No timeline data available.</p>
            ) : (
              <SnapshotTimeline
                entries={timelineData}
                loading={false}
                onEntryClick={handleTimelineEntryClick}
                paperSnapshotId={deck.paper_snapshot_id}
              />
            )}
            {overlayEntry && (
              <TimelineOverlay
                deckId={deckId}
                entry={overlayEntry.entry}
                prevSnapshotId={overlayEntry.prevSnapshotId}
                deckName={deck.deck_name}
                commanders={commanders}
                onClose={() => setOverlayEntry(null)}
              />
            )}
          </div>
        )}

        {/* ── Full Deck Tab ── */}
        {activeTab === 'fulldeck' && (
          <div className="deck-page-tab-panel">
            {deckLoading ? (
              <Skeleton lines={10} />
            ) : !parsedDeck ? (
              <p className="deck-page-empty">No deck data available. The deck needs at least one snapshot.</p>
            ) : (
              <>
                <div className="deck-page-diff-buttons" style={{ marginBottom: 'var(--space-md)' }}>
                  {deckText && (
                    <>
                      <CopyButton
                        getText={() => formatForArchidekt(deckText, commanders)}
                        label="Copy for Archidekt"
                        className="copy-btn copy-btn--archidekt"
                      />
                      <CopyButton getText={() => deckText} label="Copy Deck Text" />
                      <CopyButton getText={() => formatTTS(deckText, commanders)} label="Copy for TTS" className="copy-btn copy-btn--tts" />
                    </>
                  )}
                  <button className="btn btn-secondary btn-sm" onClick={handlePrintProxies} type="button">
                    Print Proxies (MPCFill)
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleDownloadImages}
                    disabled={!!downloadJob}
                    type="button"
                  >
                    {downloadJob
                      ? downloadJob.status === 'queued' ? 'Queued...'
                        : downloadJob.status === 'processing'
                          ? `Downloading ${downloadJob.downloadedImages || 0}/${downloadJob.totalImages || '?'}...`
                          : downloadJob.status === 'completed' ? 'Done!'
                            : 'Download Images (Scryfall)'
                      : 'Download Images (Scryfall)'}
                  </button>
                </div>
                <DeckListView parsedDeck={parsedDeck} cardMap={deckCardMap} commanders={commanders} />
              </>
            )}
          </div>
        )}

        {/* ── Analytics Tab ── */}
        {activeTab === 'analytics' && (
          <div className="deck-page-tab-panel">
            <div className="deck-page-analytics-actions">
              <button className="btn btn-primary btn-sm" onClick={handleCheckPrices} disabled={loadingPrices} type="button">
                {loadingPrices ? 'Checking...' : 'Check Prices'}
              </button>
              {priceDisplayEnabled && deck.last_known_price > 0 && (
                <button className="btn btn-secondary btn-sm" onClick={() => setShowPriceHistory(true)} type="button">
                  Price History
                </button>
              )}
              <button className="btn btn-secondary btn-sm" onClick={() => setShowRecommendations(true)} type="button">
                Suggest Cards
              </button>
            </div>

            {priceData && (
              <div className="deck-page-price-summary">
                <div className="deck-page-price-header">
                  <span className="deck-page-price-total">
                    Total: ${priceData.totalPrice.toFixed(2)}
                    {priceData.budgetPrice != null && Math.abs(priceData.budgetPrice - priceData.totalPrice) >= 0.01 && (
                      <span className="deck-page-budget-price"> (Budget: ${priceData.budgetPrice.toFixed(2)})</span>
                    )}
                  </span>
                  {priceData.previousPrice != null && priceData.previousPrice !== priceData.totalPrice && (
                    <span className={`deck-page-price-delta ${priceData.totalPrice > priceData.previousPrice ? 'delta-add' : 'delta-remove'}`}>
                      {priceData.totalPrice > priceData.previousPrice ? '+' : ''}${(priceData.totalPrice - priceData.previousPrice).toFixed(2)}
                    </span>
                  )}
                  <button className="btn btn-secondary btn-sm" onClick={() => setPriceData(null)} type="button">&times;</button>
                </div>
                {priceData.budgetPrice != null && priceData.totalPrice > priceData.budgetPrice + 0.01 && (
                  <div className="deck-page-price-savings">
                    Savings with cheapest printings: <strong>${(priceData.totalPrice - priceData.budgetPrice).toFixed(2)}</strong>
                  </div>
                )}
                {priceData.cards.length > 0 && (
                  <div className="deck-page-price-cards">
                    {priceData.cards.slice(0, 10).map((c, i) => (
                      <span key={i} className="deck-page-price-card">
                        {c.quantity > 1 ? `${c.quantity}x ` : ''}{c.name} — ${c.total.toFixed(2)}
                        {c.cheapestTotal != null && Math.abs(c.cheapestTotal - c.total) >= 0.01 && (
                          <span className="deck-page-budget-price"> (${c.cheapestTotal.toFixed(2)})</span>
                        )}
                      </span>
                    ))}
                    {priceData.cards.length > 10 && (
                      <span className="deck-page-price-card deck-page-price-more">+{priceData.cards.length - 10} more cards</span>
                    )}
                  </div>
                )}
              </div>
            )}

            {showPriceHistory && (
              <PriceHistoryOverlay deckId={deckId} deckName={deck.deck_name} onClose={() => setShowPriceHistory(false)} />
            )}
            {showRecommendations && (
              <RecommendationsOverlay deckId={deckId} deckName={deck.deck_name} onClose={() => setShowRecommendations(false)} />
            )}
          </div>
        )}

        {/* ── Settings Tab ── */}
        {activeTab === 'settings' && (
          <div className="deck-page-tab-panel">
            {/* Share */}
            <div className="deck-page-settings-section">
              <h3>Sharing</h3>
              {deck.share_id ? (
                <div className="deck-page-settings-row">
                  <span className="deck-page-settings-label">This deck is shared.</span>
                  <button className="btn btn-secondary btn-sm" onClick={handleUnshareDeck} type="button">Unshare</button>
                </div>
              ) : (
                <button className="btn btn-primary btn-sm" onClick={handleShareDeck} type="button">Share Deck</button>
              )}
            </div>

            {/* Notifications */}
            <div className="deck-page-settings-section">
              <h3>Notifications</h3>
              <div className="deck-page-settings-row">
                <span className="deck-page-settings-label">Email on deck change:</span>
                <button
                  className={`btn btn-secondary btn-sm${deck.notify_on_change ? ' btn--active' : ''}`}
                  onClick={async () => {
                    try {
                      await updateDeckNotify(deckId, !deck.notify_on_change);
                      toast.success(deck.notify_on_change ? 'Notifications disabled' : 'Notifications enabled');
                      await loadDeck();
                    } catch (err) { toast.error(err.message); }
                  }}
                  type="button"
                >
                  {deck.notify_on_change ? 'On' : 'Off'}
                </button>
              </div>
            </div>

            {/* Auto-refresh */}
            <div className="deck-page-settings-section">
              <h3>Auto-Refresh</h3>
              <select
                className="deck-page-settings-select"
                value={deck.auto_refresh_hours || ''}
                onChange={async (e) => {
                  const val = e.target.value ? parseInt(e.target.value, 10) : null;
                  try {
                    await updateDeckAutoRefresh(deckId, val);
                    toast.success(val ? `Auto-refresh set to every ${val}h` : 'Auto-refresh disabled');
                    await loadDeck();
                  } catch (err) { toast.error(err.message); }
                }}
              >
                <option value="">Off</option>
                <option value="6">Every 6 hours</option>
                <option value="12">Every 12 hours</option>
                <option value="24">Every 24 hours</option>
                <option value="48">Every 48 hours</option>
                <option value="168">Every 7 days</option>
              </select>
            </div>

            {/* Webhook */}
            <div className="deck-page-settings-section">
              <h3>Discord Webhook</h3>
              {editingWebhook ? (
                <div className="deck-page-settings-edit">
                  <input
                    type="url"
                    value={webhookValue}
                    onChange={e => setWebhookValue(e.target.value)}
                    placeholder="https://discord.com/api/webhooks/..."
                    disabled={savingWebhook}
                  />
                  <div className="deck-page-settings-edit-actions">
                    <button className="btn btn-primary btn-sm" onClick={handleSaveWebhook} disabled={savingWebhook} type="button">
                      {savingWebhook ? '...' : 'Save'}
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => setEditingWebhook(false)} type="button">Cancel</button>
                    {deck.discord_webhook_url && (
                      <button className="btn btn-sm btn-ghost-danger" onClick={() => { setWebhookValue(''); handleSaveWebhook(); }} disabled={savingWebhook} type="button">Remove</button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="deck-page-settings-row">
                  <span className="deck-page-settings-label">
                    {deck.discord_webhook_url ? 'Webhook configured' : 'No webhook set'}
                  </span>
                  <button className="btn btn-secondary btn-sm" onClick={() => { setEditingWebhook(true); setWebhookValue(deck.discord_webhook_url || ''); }} type="button">
                    {deck.discord_webhook_url ? 'Edit' : 'Set Up'}
                  </button>
                </div>
              )}
            </div>

            {/* Price Alert */}
            <div className="deck-page-settings-section">
              <h3>Price Alert</h3>
              {editingPriceAlert ? (
                <div className="deck-page-settings-edit">
                  <label className="deck-page-settings-label-sm">Alert when total deck value changes by more than ($):</label>
                  <input
                    type="number"
                    value={priceAlertValue}
                    onChange={e => setPriceAlertValue(e.target.value)}
                    placeholder="e.g. 25"
                    min="0"
                    step="1"
                    disabled={savingPriceAlert}
                  />
                  <div className="deck-page-price-alert-mode">
                    <label>
                      <input type="radio" value="specific" checked={priceAlertMode === 'specific'} onChange={() => setPriceAlertMode('specific')} disabled={savingPriceAlert} />
                      Your printings
                    </label>
                    <label>
                      <input type="radio" value="cheapest" checked={priceAlertMode === 'cheapest'} onChange={() => setPriceAlertMode('cheapest')} disabled={savingPriceAlert} />
                      Cheapest printings
                    </label>
                  </div>
                  <div className="deck-page-settings-edit-actions">
                    <button className="btn btn-primary btn-sm" onClick={handleSavePriceAlert} disabled={savingPriceAlert} type="button">
                      {savingPriceAlert ? '...' : 'Save'}
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => setEditingPriceAlert(false)} type="button">Cancel</button>
                    {deck.price_alert_threshold && (
                      <button className="btn btn-sm btn-ghost-danger" onClick={() => { setPriceAlertValue(''); handleSavePriceAlert(); }} disabled={savingPriceAlert} type="button">Remove</button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="deck-page-settings-row">
                  <span className="deck-page-settings-label">
                    {deck.price_alert_threshold ? `Alert at $${deck.price_alert_threshold} (${deck.price_alert_mode || 'specific'})` : 'No price alert set'}
                  </span>
                  <button className="btn btn-secondary btn-sm" onClick={() => { setEditingPriceAlert(true); setPriceAlertValue(deck.price_alert_threshold ?? ''); setPriceAlertMode(deck.price_alert_mode || 'specific'); }} type="button">
                    {deck.price_alert_threshold ? 'Edit' : 'Set Up'}
                  </button>
                </div>
              )}
            </div>

            {/* Notes (if none set, show add button) */}
            {!deck.notes && !editingNotes && (
              <div className="deck-page-settings-section">
                <h3>Notes</h3>
                <button className="btn btn-secondary btn-sm" onClick={() => { setEditingNotes(true); setNotesValue(''); }} type="button">
                  Add Notes
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {showMpc && mpcCards && (
        <MpcOverlay cards={mpcCards} deckName={deck.deck_name} deckId={deckId} onClose={() => { setShowMpc(false); setMpcCards(null); }} />
      )}
    </div>
  );
}

// --- Snapshot Timeline (reused from DeckLibrary) ---

function SnapshotTimeline({ entries, loading, onEntryClick, paperSnapshotId }) {
  if (loading) return <Skeleton lines={4} />;
  if (!entries || entries.length === 0) return <p className="deck-page-empty">No snapshots to show.</p>;

  function formatTimelineDate(iso) {
    if (!iso) return '';
    return new Date(iso + 'Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  const displayed = entries.map((entry, originalIndex) => ({ entry, originalIndex })).reverse();

  return (
    <div className="settings-timeline">
      {displayed.map(({ entry, originalIndex }, i) => (
        <div
          key={entry.snapshotId}
          className={`settings-timeline-entry${onEntryClick ? ' settings-timeline-entry--clickable' : ''}`}
          onClick={onEntryClick ? () => onEntryClick(entry, originalIndex) : undefined}
          role={onEntryClick ? 'button' : undefined}
          tabIndex={onEntryClick ? 0 : undefined}
          onKeyDown={onEntryClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEntryClick(entry, originalIndex); } } : undefined}
        >
          <div className="settings-timeline-left">
            <div className={`settings-timeline-dot${paperSnapshotId === entry.snapshotId ? ' settings-timeline-dot--paper' : ''}`} />
            {i < displayed.length - 1 && <div className="settings-timeline-line" />}
          </div>
          <div className="settings-timeline-content">
            <div className="settings-timeline-info">
              <span className="settings-timeline-date">{formatTimelineDate(entry.date)}</span>
              {entry.nickname && <span className="settings-timeline-nick">{entry.nickname}</span>}
              {entry.locked && <span className="settings-timeline-lock" title="Locked">{'\uD83D\uDD12'}</span>}
              {paperSnapshotId === entry.snapshotId && <span className="settings-timeline-paper" title="Paper deck">{'\uD83D\uDCCB'}</span>}
            </div>
            <div className="settings-timeline-stats">
              <span className="settings-timeline-card-count">{entry.cardCount} cards</span>
              {entry.delta && (
                <span className="settings-timeline-delta">
                  {entry.delta.added > 0 && <span className="delta-add">+{entry.delta.added}</span>}
                  {entry.delta.removed > 0 && <span className="delta-remove">-{entry.delta.removed}</span>}
                  {entry.delta.changed > 0 && <span className="delta-change">~{entry.delta.changed}</span>}
                  {entry.delta.added === 0 && entry.delta.removed === 0 && entry.delta.changed === 0 && (
                    <span className="delta-none">no changes</span>
                  )}
                </span>
              )}
              {!entry.delta && <span className="settings-timeline-baseline">baseline</span>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
