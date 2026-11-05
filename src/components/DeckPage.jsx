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
import { fetchCardData, collectCardIdentifiers, collectDeckIdentifiers } from '../lib/scryfall';
import SectionChangelog from './SectionChangelog';
import ManaCurveDelta from './ManaCurveDelta';
import ColorDistributionDelta from './ColorDistributionDelta';
import DeckListView from './DeckListView';
import CopyButton from './CopyButton';
import Skeleton from './Skeleton';
import TimelineOverlay from './TimelineOverlay';
import RecommendationsOverlay from './RecommendationsOverlay';
import MpcOverlay from './MpcOverlay';
import ManaSyncOwnership from './ManaSyncOwnership';
import ProposalReview from './ProposalReview';
import SourceSyncReview from './SourceSyncReview';
import { sourceRefreshFeedback, sourceStatusLabel } from '../lib/sourceSync';
import PriceHistoryOverlay from './PriceHistoryOverlay';
import PrintPanel from './PrintPanel';
import PrintComparisonButton from './PrintComparisonButton';
import './DeckPage.css';
import './DeckGridCard.css';
import useDeckArtwork, { deckCommanders } from '../hooks/useDeckArtwork';
import DeckArtwork from './DeckArtwork';
import Icon from './Icon';
import ActionMenu from './ActionMenu';

function formatDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z'));
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z')).toLocaleString();
}

function sectionHasChanges(section) {
  return section && [section.cardsIn, section.cardsOut, section.quantityChanges, section.printingChanges].some(rows => rows?.length);
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


export default function DeckPage({ deckId, initialPrintJobId }) {
  const { user } = useAuth();
  const { priceDisplayEnabled } = useAppSettings();
  const [confirm, ConfirmDialog] = useConfirm();

  // Core data
  const [deck, setDeck] = useState(null);
  const coverFor = useDeckArtwork(deck ? [deck] : []);
  const [loading, setLoading] = useState(true);
  const [snapshots, setSnapshots] = useState([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Tabs
  const [activeTab, setActiveTab] = useState(initialPrintJobId ? 'printing' : 'fulldeck');
  useEffect(() => { if (initialPrintJobId) setActiveTab('printing'); }, [initialPrintJobId]);

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
  const [compareA, setCompareA] = useState('');
  const [compareB, setCompareB] = useState('');

  // Comparison overlay (for snapshot comparison)
  const [comparisonDiff, setComparisonDiff] = useState(null);
  const [comparisonCardMap, setComparisonCardMap] = useState(null);
  const [comparisonTexts, setComparisonTexts] = useState(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonSearch, setComparisonSearch] = useState('');
  const comparisonSequence = useRef(0);
  const [comparisonPair, setComparisonPair] = useState(null);
  const [dataRevision, setDataRevision] = useState(0);
  const [sourceAttention, setSourceAttention] = useState(false);
  const [proposalAttention, setProposalAttention] = useState(false);
  const [reviewJump, setReviewJump] = useState(0);
  const reviewHeading = useRef(null);
  const fullDeckSequence = useRef(0);

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
  const commanders = useMemo(() => deckCommanders(deck), [deck]);

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
    } catch {
      toast.error('Failed to load deck');
    }
  }, [deckId]);

  const loadSnapshots = useCallback(async () => {
    setSnapshotsLoading(true);
    try {
      const data = await getDeckSnapshots(deckId);
      setSnapshots(data.snapshots);
      return data.snapshots;
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

  function invalidateDeckViews() {
    comparisonSequence.current++;
    fullDeckSequence.current++;
    setComparisonDiff(null); setComparisonCardMap(null); setComparisonTexts(null); setComparisonPair(null);
    setParsedDeck(null); setDeckCardMap(null); setDeckText(null); setTimelineData(null);
    setDataRevision(value => value + 1);
  }
  async function afterDeckChanged() {
    await Promise.all([loadDeck(), loadSnapshots()]);
    invalidateDeckViews();
  }
  function openReviews() { setActiveTab('changes'); setReviewJump(value => value + 1); }

  const loadTimeline = useCallback(async () => {
    setTimelineLoading(true);
    try {
      const data = await getDeckTimeline(deckId);
      setTimelineData(data.entries);
    } catch {
      toast.error('Failed to load timeline');
    } finally {
      setTimelineLoading(false);
    }
  }, [deckId]);

  const loadFullDeck = useCallback(async snapshotId => {
    if (!snapshotId) return;
    const sequence = ++fullDeckSequence.current;
    setDeckLoading(true);
    try {
      const data = await getSnapshot(deckId, snapshotId);
      const rawText = data.snapshot.deck_text, parsed = parse(rawText);
      const identifiers = collectDeckIdentifiers(parsed);
      let cm = new Map();
      try { if (identifiers.size > 0) cm = await fetchCardData(identifiers); }
      catch { /* Saved text remains usable when card metadata is temporarily unavailable. */ }
      if (sequence !== fullDeckSequence.current) return;
      setDeckText(rawText); setParsedDeck(parsed); setDeckCardMap(cm);
    } catch {
      if (sequence === fullDeckSequence.current) toast.error('Failed to load cards');
    } finally {
      if (sequence === fullDeckSequence.current) setDeckLoading(false);
    }
  }, [deckId]);

  // --- Actions ---

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const result = await refreshDeck(deckId);
      const feedback = sourceRefreshFeedback(result);
      toast(feedback.message, feedback.tone);
      await afterDeckChanged();
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
      title: 'Delete version?',
      message: 'This saved version will be permanently deleted.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await apiDeleteSnapshot(deckId, snapshotId);
      toast.success('Version deleted');
      await afterDeckChanged();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleToggleLock(snapshotId, isLocked) {
    try {
      if (isLocked) {
        if (deck?.paper_snapshot_id === snapshotId) {
          toast('Warning: allowing cleanup of your paper version means older versions may be automatically removed', 'info', 5000);
        }
        await unlockSnapshot(deckId, snapshotId);
        toast.success('Version can be cleaned up');
      } else {
        await lockSnapshot(deckId, snapshotId);
        toast.success('Version protected from cleanup');
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

  const compareVersions = useCallback(async (beforeId, afterId) => {
    if (!beforeId || !afterId) return;
    const sequence = ++comparisonSequence.current;
    setCompareA(String(beforeId)); setCompareB(String(afterId));
    setComparisonLoading(true); setComparisonSearch('');
    try {
      const data = await getDeckChangelog(deckId, beforeId, afterId);
      const identifiers = collectCardIdentifiers(data.diff);
      let cm = new Map();
      try { if (identifiers.size > 0) cm = await fetchCardData(identifiers); }
      catch { /* Saved text remains usable when card metadata is temporarily unavailable. */ }
      if (sequence !== comparisonSequence.current) return;
      setComparisonDiff(data.diff); setComparisonCardMap(cm);
      setComparisonTexts({ beforeText: data.before.deck_text, afterText: data.after.deck_text });
      setComparisonPair({ before: data.before, after: data.after });
    } catch (err) {
      if (sequence === comparisonSequence.current) toast.error(err.message || 'Failed to load comparison');
    } finally {
      if (sequence === comparisonSequence.current) setComparisonLoading(false);
    }
  }, [deckId]);
  function handleCompareSnapshots() { return compareVersions(compareA, compareB); }
  function handleCompareToPaper() {
    return compareVersions(deck?.paper_snapshot_id, snapshots[0]?.id);
  }
  function handleLatestChanges() { return compareVersions(snapshots[1]?.id, snapshots[0]?.id); }
  function inspectVersion(snapshot, index) {
    const known = timelineData?.find(entry => entry.snapshotId === snapshot.id);
    setOverlayEntry({ entry: { ...known, snapshotId: snapshot.id, nickname: snapshot.nickname,
      date: snapshot.created_at, cardCount: snapshot.cardCount ?? snapshot.card_count ?? known?.cardCount, locked: snapshot.locked },
      prevSnapshotId: snapshots[index + 1]?.id ?? null });
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
  async function handleSaveWebhook(value = webhookValue) {
    setSavingWebhook(true);
    try {
      await updateDeckDiscordWebhook(deckId, value.trim() || null);
      toast.success(value.trim() ? 'Webhook saved' : 'Webhook removed');
      setEditingWebhook(false);
      await loadDeck();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingWebhook(false);
    }
  }

  async function handleSavePriceAlert(value = priceAlertValue) {
    setSavingPriceAlert(true);
    try {
      const threshold = value === '' ? null : parseFloat(value);
      await updateDeckPriceAlert(deckId, threshold, priceAlertMode);
      toast.success(threshold ? `Price alert set for a $${threshold} change` : 'Price alert removed');
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
          toast.error('Image download incomplete — review the missing cards below.');
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

  // Data follows its saved version, including first load and same-tab refresh.
  const latestSnapshotId = snapshots[0]?.id, previousSnapshotId = snapshots[1]?.id, paperSnapshotId = deck?.paper_snapshot_id;
  useEffect(() => {
    if (activeTab === 'fulldeck' && latestSnapshotId) void loadFullDeck(latestSnapshotId);
  }, [activeTab, latestSnapshotId, dataRevision, loadFullDeck]);
  useEffect(() => {
    if (activeTab !== 'changes') return;
    if (!comparisonDiff && previousSnapshotId) {
      const before = paperSnapshotId && paperSnapshotId !== latestSnapshotId ? paperSnapshotId : previousSnapshotId;
      void compareVersions(before, latestSnapshotId);
    }
  }, [activeTab, latestSnapshotId, previousSnapshotId, paperSnapshotId, dataRevision, comparisonDiff, compareVersions]);
  useEffect(() => { if (activeTab === 'changes') void loadTimeline(); }, [activeTab, latestSnapshotId, dataRevision, loadTimeline]);
  useEffect(() => {
    if (reviewJump && activeTab === 'changes') {
      reviewHeading.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      reviewHeading.current?.focus({ preventScroll: true });
    }
  }, [reviewJump, activeTab]);
  useEffect(() => () => { comparisonSequence.current++; fullDeckSequence.current++; }, []);

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

  const sourceProvider = deck?.source_sync?.sourceProvider || deck?.source_type || 'archidekt';
  const sourceName = { archidekt: 'Archidekt', moxfield: 'Moxfield', deckcheck: 'DeckCheck' }[sourceProvider] || 'Archidekt';

  // --- Render ---

  if (loading) {
    return (
      <div className="deck-page">
        <button className="deck-page-back" onClick={() => { window.location.hash = '#library'; }} type="button">
          &larr; Back to Decks
        </button>
        <Skeleton lines={10} />
      </div>
    );
  }

  if (!deck) {
    return (
      <div className="deck-page">
        <button className="deck-page-back" onClick={() => { window.location.hash = '#library'; }} type="button">
          &larr; Back to Decks
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
          &larr; Back to Decks
        </button>
        <div className="deck-page-topbar-actions">
          <button className="btn btn-secondary btn-sm" onClick={handleRefresh} disabled={refreshing || deck.source_type === 'manual'} title={deck.source_type === 'manual' ? 'Manual decks have no upstream source to refresh' : undefined} type="button">
            <Icon name="refresh" size={16} /> {refreshing ? 'Checking…' : 'Check for updates'}
          </button>
          {deck.deck_url && (
            <a href={deck.deck_url} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm">
              {sourceName}
            </a>
          )}
          {activeTab !== 'printing' && <button className="btn btn-primary btn-sm" onClick={() => setActiveTab('printing')} type="button"><Icon name="print" size={17} /> Print cards</button>}
          <details className="deck-page-more"><summary aria-label="More deck actions"><Icon name="more" /></summary>
            <div><button className="btn btn-sm btn-ghost-danger" onClick={event => { event.currentTarget.focus(); handleUntrack(); }} type="button">Untrack deck</button></div>
          </details>
        </div>
      </div>

      {/* Header */}
      <div className="deck-page-hero">
        <DeckArtwork imageUri={coverFor(commanders[0])} className="deck-page-cover" />
        <div className="deck-page-header">
        <span className="deck-page-eyebrow">{sourceName === 'Archidekt' && deck.source_type === 'manual' ? 'Manual deck' : sourceName} · Deck workspace</span>
        <div className="deck-page-header-top">
          <h1 className="deck-page-name">{deck.deck_name}</h1>
          <div className="deck-page-header-badges">
            <button
              className={`deck-page-pin-btn${deck.pinned ? ' deck-page-pin-btn--active' : ''}`}
              onClick={handleTogglePin}
              type="button"
              title={deck.pinned ? 'Unpin' : 'Pin to top'}
            >
              <Icon name="pin" size={18} />
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
                <Icon name="edit" size={15} />
              </button>
            </div>
          )}
        </div>

        {/* Meta line */}
        <div className="deck-page-meta">
          <span className="deck-page-meta-owner">{deck.source_type === 'manual' ? 'Manual deck' : deck.archidekt_username ? `@${deck.archidekt_username}` : sourceName}</span>
          <span className="deck-page-meta-sep">&middot;</span>
          <span>{deck.snapshot_count} version{deck.snapshot_count !== 1 ? 's' : ''}</span>
          {deck.share_id && (
            <>
              <span className="deck-page-meta-sep">&middot;</span>
              <span className="deck-page-shared-badge">Shared</span>
            </>
          )}
          {deck.paper_snapshot_id && (
            <>
              <span className="deck-page-meta-sep">&middot;</span>
              <span className="deck-page-paper-badge">Paper version saved</span>
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

      </div>

      {(sourceAttention || proposalAttention) && <button className="deck-attention-link" type="button" onClick={openReviews}>
        <Icon name="connections" size={17} /> Updates need your review <Icon name="chevron" size={15} />
      </button>}

      {/* Tabs */}
      <nav className="deck-page-tabs" aria-label="Deck sections">
        {['fulldeck', 'changes', 'printing', 'settings'].map(tab => (
          <button
            key={tab}
            className={`deck-page-tab${activeTab === tab ? ' deck-page-tab--active' : ''}`}
            onClick={() => setActiveTab(tab)}
            aria-current={activeTab === tab ? 'page' : undefined}
            type="button"
          >
            {{
              fulldeck: 'Cards', changes: 'Changes', printing: 'Print', settings: 'Settings',
            }[tab]}
          </button>
        ))}
      </nav>

      {/* Tab content */}
      <div className="deck-page-content">
        {activeTab === 'printing' && <PrintPanel key={deckId} deck={deck} snapshots={snapshots} initialJobId={initialPrintJobId} />}

        {/* ── Snapshots Tab ── */}
        {activeTab === 'changes' && (
          <div className="deck-page-tab-panel">
            <div className="deck-changes-heading"><h2>Compare saved versions</h2><p>Choose the versions to see what changed.</p></div>
            {snapshots.length >= 2 ? <>
              <div className="deck-page-snapshot-actions">
                {deck.paper_snapshot_id && <button className="btn btn-secondary btn-sm" disabled={comparisonLoading} onClick={handleCompareToPaper} type="button">Paper to latest</button>}
                <button className="btn btn-secondary btn-sm" disabled={comparisonLoading} onClick={handleLatestChanges} type="button">Latest update</button>
              </div>
              <form className="deck-page-compare" onSubmit={event => { event.preventDefault(); handleCompareSnapshots(); }}>
                <label>Before<select value={compareA} onChange={e => setCompareA(e.target.value)} aria-label="Select older version">
                  <option value="">Choose a version</option>{snapshots.map(version => <option key={version.id} value={version.id}>{version.nickname || formatDateTime(version.created_at)}{version.id === deck.paper_snapshot_id ? ' · Paper' : ''}</option>)}
                </select></label>
                <label>After<select value={compareB} onChange={e => setCompareB(e.target.value)} aria-label="Select newer version">
                  <option value="">Choose a version</option>{snapshots.map(version => <option key={version.id} value={version.id}>{version.nickname || formatDateTime(version.created_at)}{version.id === snapshots[0]?.id ? ' · Latest' : ''}</option>)}
                </select></label>
                <button className="btn btn-primary btn-sm" disabled={!compareA || !compareB || comparisonLoading} type="submit">{comparisonLoading ? 'Comparing…' : 'Compare versions'}</button>
              </form>
            </> : <p className="deck-page-empty">Save a second version to compare changes.</p>}
            {comparisonLoading && <p role="status">Loading the comparison…</p>}

            {/* Inline comparison result */}
            {comparisonDiff && (
              <div className="deck-page-inline-diff">
                <div className="deck-page-inline-diff-header">
                  <h3>{comparisonPair ? `${comparisonPair.before.nickname || formatDateTime(comparisonPair.before.created_at)} → ${comparisonPair.after.nickname || formatDateTime(comparisonPair.after.created_at)}` : 'Changes'}</h3>
                  {comparisonTexts && <PrintComparisonButton {...comparisonTexts} listName={`${deck.deck_name} comparison`} />}

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
                      <CopyButton getText={() => formatChangelog(comparisonForExport, comparisonCardMap)} label="Copy changes" />
                      <ActionMenu label="Export" ariaLabel="Export comparison">
                        {comparisonTexts && <CopyButton getText={() => formatForArchidekt(comparisonTexts.afterText, commanders, comparisonTexts.beforeText)} label="Copy for Archidekt" />}
                        <CopyButton getText={() => formatMpcFill(comparisonForExport)} label="Copy for MPCFill" />
                        <CopyButton getText={() => formatReddit(comparisonForExport, comparisonCardMap)} label="Copy for Reddit" />
                        <CopyButton getText={() => formatJSON(comparisonForExport)} label="Copy JSON" />
                      </ActionMenu>
                    </div>
                    <div className="deck-page-diff-summary">
                      {comparisonStats.totalIn > 0 && <span className="summary-badge summary-badge--in">+{comparisonStats.totalIn} in</span>}
                      {comparisonStats.totalOut > 0 && <span className="summary-badge summary-badge--out">-{comparisonStats.totalOut} out</span>}
                      {comparisonStats.totalChanged > 0 && <span className="summary-badge summary-badge--changed">~{comparisonStats.totalChanged} changed</span>}
                      {comparisonStats.totalPrinting > 0 && <span className="summary-badge summary-badge--printing">&#8635;{comparisonStats.totalPrinting} printing changes</span>}
                    </div>
                  </>
                )}
                {comparisonStats.noChanges ? (
                  <p className="deck-page-empty">These versions have the same cards and printings.</p>
                ) : (
                  <>
                    <details className="deck-change-insights"><summary>How the deck changed</summary><ManaCurveDelta diffResult={comparisonDiff} cardMap={comparisonCardMap} /><ColorDistributionDelta diffResult={comparisonDiff} cardMap={comparisonCardMap} /></details>
                    {sectionHasChanges(filteredCompMain) && <SectionChangelog sectionName="Mainboard" changes={filteredCompMain} cardMap={comparisonCardMap} />}
                    {sectionHasChanges(filteredCompSide) && comparisonDiff.hasSideboard && <SectionChangelog sectionName="Sideboard" changes={filteredCompSide} cardMap={comparisonCardMap} />}
                    {comparisonSearch && !sectionHasChanges(filteredCompMain) && !sectionHasChanges(filteredCompSide) && <p className="deck-page-empty">No changed cards match this search.</p>}
                  </>
                )}
              </div>
            )}

            <div className="deck-history-heading"><h2>Version history</h2><p>Browse earlier cards or mark the version you have on paper.</p></div>{timelineLoading && <p role="status">Loading version changes…</p>}
            {snapshotsLoading ? (
              <Skeleton lines={5} />
            ) : snapshots.length === 0 ? (
              <p className="deck-page-empty">No saved versions yet.</p>
            ) : (
              <ul className="deck-page-snap-list">
                {snapshots.map((snap, index) => (
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
                            <span className="deck-page-snap-paper-badge">Paper deck</span>
                          )}
                        </>
                      )}
                    </div>
                    <VersionDelta entry={timelineData?.find(entry => entry.snapshotId === snap.id)} />
                    <div className="deck-page-snap-actions">
                      <button className="btn btn-secondary btn-sm" type="button" onClick={event => { event.currentTarget.focus(); inspectVersion(snap, index); }}>View version</button>
                      <ActionMenu label="Options" ariaLabel={`Options for ${snap.nickname || formatDateTime(snap.created_at)}`}>

                      <button
                        className="deck-page-snap-icon-btn"
                        onClick={() => handleToggleLock(snap.id, !!snap.locked)}
                        type="button"
                        aria-label={snap.locked ? 'Allow version cleanup' : 'Protect version'}
                      >
                        <Icon name={snap.locked ? "lock" : "unlock"} size={17} />{snap.locked ? 'Allow cleanup' : 'Protect version'}
                      </button>
                      <button
                        className={`deck-page-snap-icon-btn${deck.paper_snapshot_id === snap.id ? ' deck-page-snap-icon-btn--active' : ''}`}
                        onClick={() => handleTogglePaper(snap.id, deck.paper_snapshot_id === snap.id)}
                        type="button"
                        aria-label={deck.paper_snapshot_id === snap.id ? 'Remove paper marker' : 'Mark as paper deck'}
                      >
                        <Icon name="cards" size={17} />{deck.paper_snapshot_id === snap.id ? 'Remove paper marker' : 'Mark as paper deck'}
                      </button>
                      <button
                        className="deck-page-snap-icon-btn"
                        onClick={() => { setEditingNickname(snap.id); setNicknameValue(snap.nickname || ''); }}
                        type="button"
                        aria-label="Name version"
                      >
                        <Icon name="edit" size={15} />Name version
                      </button>
                      <button
                        className="deck-page-snap-icon-btn deck-page-snap-icon-btn--delete"
                        onClick={event => { event.currentTarget.focus(); handleDeleteSnapshot(snap.id); }}
                        type="button"
                        disabled={!!snap.locked}
                        title={snap.locked ? 'Allow cleanup before deleting' : 'Delete version'}
                      >
                        <Icon name="close" size={17} />Delete version
                      </button>
                      </ActionMenu>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <section className="deck-reviews" hidden={activeTab !== 'changes'} aria-label="Deck updates to review">
          <h2 ref={reviewHeading} tabIndex={-1}>Updates to review</h2>
          {deck.source_type !== 'manual' && <details className="deck-source-disclosure" open={reviewJump > 0 || sourceAttention}>
            <summary><Icon name="connections" size={16} /><span>Source updates</span><span className="deck-source-summary-status">{sourceStatusLabel(deck.source_sync?.status).replaceAll('Archidekt', sourceName)}</span></summary>
            <SourceSyncReview deckId={deckId} sourceProvider={sourceProvider} onAttentionChange={setSourceAttention}
              refreshKey={`${snapshots[0]?.id}:${deck.source_sync?.status}:${deck.source_sync?.checkedAt}`} onChanged={afterDeckChanged} />
          </details>}
          <ProposalReview deckId={deckId} onChanged={afterDeckChanged} onAttentionChange={setProposalAttention} />
        </section>
        {overlayEntry && <TimelineOverlay deckId={deckId} entry={overlayEntry.entry} prevSnapshotId={overlayEntry.prevSnapshotId}
          deckName={deck.deck_name} commanders={commanders} onClose={() => setOverlayEntry(null)} />}

        {/* ── Full Deck Tab ── */}
        {activeTab === 'fulldeck' && (
          <div className="deck-page-tab-panel">
            {deckLoading ? (
              <Skeleton lines={10} />
            ) : !parsedDeck ? (
              <p className="deck-page-empty">No saved version is available yet.</p>
            ) : (
              <>
                <div className="deck-full-toolbar"><div><h2>Latest saved version</h2><p>{snapshots[0]?.nickname || formatDateTime(snapshots[0]?.created_at)} · Printings saved with this version</p></div>
                  <ActionMenu label="Export" ariaLabel="Export deck and artwork">
                  {deckText && (
                    <>
                      <CopyButton
                        getText={() => formatForArchidekt(deckText, commanders)}
                        label="Copy for Archidekt"
                        className="copy-btn copy-btn--archidekt"
                      />
                      <CopyButton getText={() => deckText} label="Copy Deck Text" />
                      <CopyButton getText={() => formatTTS(deckText, deckCardMap, commanders)} label="Copy for TTS" className="copy-btn copy-btn--tts" />
                    </>
                  )}
                  <button className="btn btn-secondary btn-sm" onClick={event => { event.currentTarget.focus(); handlePrintProxies(); }} type="button">
                    MPCFill artwork
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleDownloadImages}
                    disabled={downloadJob && downloadJob.status !== 'failed'}
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
                </ActionMenu></div>
                {downloadJob && downloadJob.status !== 'failed' && <p className="deck-download-status" role="status">{downloadJob.status === 'processing' ? `Downloading ${downloadJob.downloadedImages || 0}/${downloadJob.totalImages || '?'} images…` : downloadJob.status === 'queued' ? 'Your image download is queued.' : 'Image download complete.'}</p>}
                {downloadJob?.status === 'failed' && (
                  <div className="deck-page-download-error" role="alert">
                    <strong>Image download could not be completed</strong>
                    <pre>{downloadJob.error || 'Please retry the image download.'}</pre>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => setDownloadJob(null)}>Dismiss</button>
                  </div>
                )}
                <details className="deck-ownership-disclosure"><summary><Icon name="connections" size={17} /> Ownership & shopping</summary>
                  <ManaSyncOwnership deckId={deckId} parsedDeck={parsedDeck} cardMap={deckCardMap} deckText={deckText} />
                </details>
                <DeckListView parsedDeck={parsedDeck} cardMap={deckCardMap} commanders={commanders} insights={<>
            <div className="deck-page-analytics-actions">
              {priceDisplayEnabled && <button className="btn btn-secondary btn-sm" onClick={handleCheckPrices} disabled={loadingPrices} type="button">
                {loadingPrices ? 'Checking…' : 'Check prices'}
              </button>}
              {priceDisplayEnabled && deck.last_known_price > 0 && (
                <button className="btn btn-secondary btn-sm" onClick={event => { event.currentTarget.focus(); setShowPriceHistory(true); }} type="button">
                  Price history
                </button>
              )}
              <button className="btn btn-secondary btn-sm" onClick={event => { event.currentTarget.focus(); setShowRecommendations(true); }} type="button">
                Suggest cards
              </button>
            </div>

            {priceDisplayEnabled && priceData && (
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

                </>} />
              </>
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
                  <span className="deck-page-settings-label">Anyone with the link can view saved versions.</span><button className="btn btn-secondary btn-sm" onClick={handleShareDeck} type="button">Copy share link</button>
                  <button className="btn btn-secondary btn-sm" onClick={handleUnshareDeck} type="button">Unshare</button>
                </div>
              ) : (
                <button className="btn btn-primary btn-sm" onClick={handleShareDeck} type="button">Share Deck</button>
              )}
            </div>

            {/* Notifications */}
            <div className="deck-page-settings-section">
              <h3>Deck alerts</h3>
              {user && user.emailVerified === false && (
                <p className="deck-page-settings-warning">
                  ⚠ Email alerts (deck change &amp; price) require a verified email.
                  {' '}Verify yours in <a href="#settings">Account Settings</a> — Discord webhooks work regardless.
                </p>
              )}
              <div className="deck-page-settings-row">
                <span className="deck-page-settings-label">Email on deck change:</span>
                <button
                  className={`btn btn-secondary btn-sm${deck.notify_on_change ? ' btn--active' : ''}`}
                  disabled={deck.source_type === 'manual'}
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
              <h3>Automatic source checks</h3>
              <select
                className="deck-page-settings-select"
                value={deck.auto_refresh_hours || ''}
                disabled={deck.source_type === 'manual'}
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
              {deck.source_type === 'manual' && <p>Manual decks are saved in CLC and have no provider source to refresh.</p>}
            </div>

            {/* Webhook */}
            <div className="deck-page-settings-section">
              <h3>Discord deck alerts</h3><p className="deck-page-settings-label">For this deck’s changes and price alerts. <a href="#print-station">Printer flip alerts</a> are set up with the printer.</p>
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
                    <button className="btn btn-primary btn-sm" onClick={() => handleSaveWebhook()} disabled={savingWebhook} type="button">
                      {savingWebhook ? '...' : 'Save'}
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => setEditingWebhook(false)} type="button">Cancel</button>
                    {deck.discord_webhook_url && (
                      <button className="btn btn-sm btn-ghost-danger" onClick={() => handleSaveWebhook('')} disabled={savingWebhook} type="button">Remove</button>
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
                    <button className="btn btn-primary btn-sm" onClick={() => handleSavePriceAlert()} disabled={savingPriceAlert} type="button">
                      {savingPriceAlert ? '...' : 'Save'}
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => setEditingPriceAlert(false)} type="button">Cancel</button>
                    {deck.price_alert_threshold && (
                      <button className="btn btn-sm btn-ghost-danger" onClick={() => { setPriceAlertValue(''); handleSavePriceAlert(''); }} disabled={savingPriceAlert} type="button">Remove</button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="deck-page-settings-row">
                  <span className="deck-page-settings-label">
                    {deck.price_alert_threshold ? `Alert on a $${deck.price_alert_threshold} change (${deck.price_alert_mode || 'specific'})` : 'No price alert set'}
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

function VersionDelta({ entry }) {
  if (!entry?.delta) return null;
  const delta = entry.delta;
  return <div className="deck-version-delta" aria-label="Changes from previous version">
    {delta.added > 0 && <span>+{delta.added} added</span>}
    {delta.removed > 0 && <span>−{delta.removed} removed</span>}
    {delta.changed > 0 && <span>{delta.changed} changed</span>}
    {delta.printingChanged > 0 && <span>{delta.printingChanged} printings</span>}
    {!delta.added && !delta.removed && !delta.changed && !delta.printingChanged && <span>No card changes</span>}
  </div>;
}
