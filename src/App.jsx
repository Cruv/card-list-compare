import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react';
import DeckInput from './components/DeckInput';
import ChangelogOutput from './components/ChangelogOutput';
import AppShell from './components/AppShell';
import Icon from './components/Icon';
import ForgotPassword from './components/ForgotPassword';
import ResetPassword from './components/ResetPassword';
import ErrorBoundary from './components/ErrorBoundary';

// Lazy-loaded page components (code-split into separate chunks)
const AdminPage = lazy(() => import('./components/admin/AdminPage'));
const UserSettings = lazy(() => import('./components/UserSettings'));
const ConnectionsPage = lazy(() => import('./components/ConnectionsPage'));
const DeckLibrary = lazy(() => import('./components/DeckLibrary'));
const DeckPage = lazy(() => import('./components/DeckPage'));
const SharedDeckView = lazy(() => import('./components/SharedDeckView'));
const GuidePage = lazy(() => import('./components/GuidePage'));
const PrintStationPage = lazy(() => import('./components/PrintStationPage'));
const PrintListPage = lazy(() => import('./components/PrintListPage'));
import { useAuth } from './context/AuthContext';
import { useHashRoute } from './lib/useHashRoute';
import { parse } from './lib/parser';
import { computeDiff } from './lib/differ';
import { collectCardIdentifiers, fetchCardData } from './lib/scryfall';
import { createShare, getShare, verifyEmail } from './lib/api';
import { clearPasswordResetUrl } from './lib/authNavigation';
import { toast } from './components/Toast';
import { preloadManaSymbols } from './components/ManaCost';
import WhatsNewModal from './components/WhatsNewModal';
import { PRINT_COMPARISON_EVENT, loadPrintComparison, consumePrintComparison } from './lib/printComparisonHandoff';
import './App.css';

const APP_VERSION = '2.52.1';
const WHATS_NEW = [
  'Print controls stay reachable on smaller screens',
  'Smoother keyboard navigation through artwork and deck dialogs',
  'Compare and Guide reopen offline after the app is prepared',
  'Temporary connection failures keep your saved login for reconnecting',
];

function getResetToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get('reset') || null;
}

function getVerifyToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get('verify') || null;
}

// Hash routes that require a signed-in user, mapped to their display name.
const AUTH_ROUTES = {
  settings: 'Account settings',
  connections: 'Connections',
  library: 'The deck library',
  libraryDeck: 'This deck',
  admin: 'The admin panel',
  printStation: 'The print station',
  printList: 'Print lists',
};

export default function App() {
  const { user, loading: authLoading } = useAuth();
  const { route, shareId, deckShareId, deckId } = useHashRoute();
  const [beforeText, setBeforeText] = useState('');
  const [afterText, setAfterText] = useState('');
  const [comparedLists, setComparedLists] = useState(null);
  const diffResult = comparedLists?.diff || null;
  const comparisonRevision = useRef(0);
  const [handoffRevision, setHandoffRevision] = useState(0);
  const [cardMap, setCardMap] = useState(null);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetToken, setResetToken] = useState(getResetToken);
  const [showWhatsNew, setShowWhatsNew] = useState(false);

  useEffect(() => {
    const refresh = () => setHandoffRevision(value => value + 1);
    window.addEventListener(PRINT_COMPARISON_EVENT, refresh);
    return () => window.removeEventListener(PRINT_COMPARISON_EVENT, refresh);
  }, []);
  const printComparison = useMemo(() => {
    // The event also refreshes a handoff while this App instance is still mounted.
    void handoffRevision;
    if (route !== 'printList' || !user) return null;
    try { return loadPrintComparison(window.sessionStorage, user.id); } catch { return null; }
  }, [route, user, handoffRevision]);
  const onComparisonConsumed = useCallback(id => {
    consumePrintComparison(window.sessionStorage, id);
    setHandoffRevision(value => value + 1);
  }, []);

  // Show "what's new" toast once per version
  // Prefetch common mana symbol SVGs at idle priority
  useEffect(() => { preloadManaSymbols(); }, []);

  useEffect(() => {
    const lastSeen = localStorage.getItem('clc-version-seen');
    if (lastSeen === APP_VERSION) return;
    // First visit ever — stamp the version but don't show a toast
    if (!lastSeen) {
      localStorage.setItem('clc-version-seen', APP_VERSION);
      return;
    }
    // Returning user with an older version — show the toast, then stamp
    localStorage.setItem('clc-version-seen', APP_VERSION);
    const timer = setTimeout(() => {
      const highlights = WHATS_NEW.slice(0, 2).join(', ');
      const suffix = WHATS_NEW.length > 2 ? ', and more!' : '';
      toast.info(`What's new in v${APP_VERSION}: ${highlights}${suffix}`, 8000);
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  // Handle email verification token from URL
  useEffect(() => {
    const verifyToken = getVerifyToken();
    if (!verifyToken) return;
    verifyEmail(verifyToken)
      .then(() => {
        toast.success('Email verified successfully!');
      })
      .catch(() => {
        toast.error('Email verification failed — the link may be invalid or expired.');
      })
      .finally(() => {
        // Clean URL
        window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      });
  }, []);

  // Prompt existing users without email (once per session)
  useEffect(() => {
    if (!user) return;
    if (user.email) return;
    if (sessionStorage.getItem('clc-email-prompted')) return;
    sessionStorage.setItem('clc-email-prompted', '1');
    // Small delay so it doesn't fire immediately on login
    const timer = setTimeout(() => {
      toast.info('Add an email in Settings to enable password reset.', 6000);
    }, 1500);
    return () => clearTimeout(timer);
  }, [user]);

  const showComparison = useCallback((beforeText, afterText) => {
    const revision = ++comparisonRevision.current;
    const before = parse(beforeText);
    const after = parse(afterText);
    const diff = computeDiff(before, after);
    setComparedLists({ diff, beforeText, afterText });
    setCardMap(null);

    // Fetch card data in the background (non-blocking)
    // Uses identifiers with set+collector when available for exact printing artwork
    const identifiers = collectCardIdentifiers(diff);
    if (identifiers.size > 0) {
      fetchCardData(identifiers)
        .then(data => { if (revision === comparisonRevision.current) setCardMap(data); })
        .catch(() => {}); // Silent fail — cards just won't be grouped by type
    }
  }, []);

  function handleCompare() {
    showComparison(beforeText, afterText);
  }

  function handleClear() {
    setBeforeText('');
    setAfterText('');
    comparisonRevision.current++;
    setComparedLists(null);
    setCardMap(null);
  }

  function handleSwap() {
    setBeforeText(afterText);
    setAfterText(beforeText);
    comparisonRevision.current++;
    setComparedLists(null);
    setCardMap(null);
  }

  const canCompare = useMemo(
    () => beforeText.trim().length > 0 || afterText.trim().length > 0,
    [beforeText, afterText]
  );

  // Load shared comparison from URL hash (e.g. #share/abc123)
  useEffect(() => {
    if (route !== 'share' || !shareId) return;
    let active = true;
    const revision = ++comparisonRevision.current;
    async function loadShare() {
      try {
        const data = await getShare(shareId);
        if (!active || revision !== comparisonRevision.current) return;
        setBeforeText(data.beforeText || '');
        setAfterText(data.afterText || '');
        showComparison(data.beforeText || '', data.afterText || '');
      } catch {
        if (active && revision === comparisonRevision.current) toast.error('Failed to load shared comparison. The link may be invalid or expired.');
      }
    }
    loadShare();
    return () => { active = false; };
  }, [route, shareId, showComparison]);

  async function handleShare() {
    const commanders = diffResult?.commanders || [];
    const title = commanders.length > 0 ? commanders.join(' / ') + ' Changelog' : null;
    const data = await createShare(comparedLists.beforeText, comparedLists.afterText, title);
    const url = `${window.location.origin}${window.location.pathname}#share/${data.id}`;
    window.history.replaceState(null, '', `#share/${data.id}`);
    return url;
  }

  // Ctrl+Enter to compare
  const handleCompareRef = useRef(handleCompare);
  const canCompareRef = useRef(canCompare);

  useEffect(() => {
    handleCompareRef.current = handleCompare;
    canCompareRef.current = canCompare;
  });

  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canCompareRef.current) {
        e.preventDefault();
        handleCompareRef.current();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const inShell = content => <AppShell route={route} version={APP_VERSION} onWhatsNew={() => setShowWhatsNew(true)} onShowForgotPassword={() => setShowForgotPassword(true)}>
    {showForgotPassword && !user && <ErrorBoundary><ForgotPassword onClose={() => setShowForgotPassword(false)} /></ErrorBoundary>}
    <ErrorBoundary key={resetToken ? 'password-reset' : route}><Suspense fallback={<div className="app-loading" role="status"><span className="loading-pulse" /> Loading your workspace…</div>}>{content}</Suspense></ErrorBoundary>
    {showWhatsNew && <WhatsNewModal version={APP_VERSION} changes={WHATS_NEW} onClose={() => setShowWhatsNew(false)} />}
  </AppShell>;

  if (resetToken) return inShell(<div className="app-auth-required"><header className="page-heading"><h1>A fresh start.</h1><p>Choose a new password for your CLC account.</p></header><ResetPassword token={resetToken} onComplete={() => { clearPasswordResetUrl(); setResetToken(null); }} /></div>);
  if (AUTH_ROUTES[route] && authLoading) return inShell(<div className="app-loading" role="status">Loading your account…</div>);
  if (AUTH_ROUTES[route] && !user) return inShell(<section className="app-auth-required"><span className="auth-required-icon"><Icon name="cards" size={36} /></span><p className="eyebrow">Your personal workspace</p><h1>Bring your decks along.</h1><p>{AUTH_ROUTES[route]} is available when you’re signed in. Use <strong>Log In</strong> above to pick up where you left off.</p><a className="btn btn-secondary" href="#">Compare without an account <Icon name="arrow" size={16} /></a></section>);
  if (route === 'guide') return inShell(<GuidePage />);
  if (route === 'admin') return inShell(<AdminPage />);
  if (route === 'settings' && user) return inShell(<UserSettings key={user.id} />);
  if (route === 'connections' && user) return inShell(<ConnectionsPage key={user.id} />);
  if (route === 'printList' && user) return inShell(<PrintListPage key={user.id} initialComparison={printComparison} onComparisonConsumed={onComparisonConsumed} />);
  if (route === 'printStation' && user) return inShell(<PrintStationPage key={user.id} />);
  if (route === 'library' && user) return inShell(<DeckLibrary key={user.id} />);
  if (route === 'libraryDeck' && user && deckId) return inShell(<DeckPage key={`${user.id}:${deckId}`} deckId={deckId} />);
  if (route === 'deck' && deckShareId) return inShell(<SharedDeckView key={deckShareId} shareId={deckShareId} />);

  return inShell(
    <div className="app compare-workspace">
      <header className="compare-hero">
        <div><p className="eyebrow">Less sorting. More playing.</p><h1>From list to game night.</h1><p>See what changed, choose your artwork, and get your next deck ready for the table.</p></div>
        <div className="compare-journey" aria-label="Compare, review and print"><span><Icon name="compare" /><small>Compare</small></span><Icon name="chevron" size={14} /><span><Icon name="cards" /><small>Review</small></span><Icon name="chevron" size={14} /><span><Icon name="print" /><small>Print</small></span></div>
      </header>

      <div id="deck-inputs" className="app-inputs">
        <DeckInput
          label="Before"
          value={beforeText}
          onChange={setBeforeText}
          user={user}
        />
        <DeckInput
          label="After"
          value={afterText}
          onChange={setAfterText}
          user={user}
        />
      </div>

      <div className="app-actions">
        <button
          className="btn btn-primary"
          onClick={handleCompare}
          disabled={!canCompare}
          type="button"
          title="Ctrl+Enter"
          aria-keyshortcuts="Control+Enter"
        >
          Compare Lists <Icon name="arrow" size={18} />
        </button>
        <button className="btn btn-secondary" onClick={handleSwap} type="button">
          Swap
        </button>
        <button className="btn btn-secondary" onClick={handleClear} type="button">
          Clear
        </button>
      </div>

      <ErrorBoundary>
        {diffResult && <>
          {(beforeText !== comparedLists.beforeText || afterText !== comparedLists.afterText) &&
            <p role="status">These results use your last comparison. Compare again to use the edited lists for printing or export.</p>}
          <ChangelogOutput diffResult={diffResult} cardMap={cardMap} onShare={handleShare} afterText={comparedLists.afterText} beforeText={comparedLists.beforeText} />
        </>}
      </ErrorBoundary>

      {!diffResult && <aside className="compare-next"><div><Icon name="library" size={24} /><span><strong>Your next comparison, already saved.</strong><p>Track decks to keep snapshots and compare what changed since your last print.</p></span></div><a href="#library">Explore your library <Icon name="arrow" size={16} /></a></aside>}
    </div>
  );
}
