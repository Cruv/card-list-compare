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
import { comparisonShareUrl } from './lib/comparisonSharing';
import { clearPasswordResetUrl } from './lib/authNavigation';
import { toast } from './components/Toast';
import { preloadManaSymbols } from './components/ManaCost';
import WhatsNewModal from './components/WhatsNewModal';
import { PRINT_COMPARISON_EVENT, loadPrintComparison, consumePrintComparison } from './lib/printComparisonHandoff';
import './App.css';

const APP_VERSION = '2.65.0';
const WHATS_NEW = [
  'Preview exact printings and skipped rows before importing a deck',
  'Download a one-sheet paper proof and inspect recovery options in Printer',
  'Set an expiry or revoke a comparison link you own',
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
  printStation: 'The printer',
  printList: 'Print lists',
};

export default function App() {
  const { user, loading: authLoading } = useAuth();
  const { route, shareId, deckShareId, deckId, initialPrintJobId } = useHashRoute();
  const shareScope = useMemo(() => route === 'share' ? { id: shareId } : null, [route, shareId]);
  const [shareLoad, setShareLoad] = useState(null);
  const [inputs, setInputs] = useState({ scope: null, beforeText: '', afterText: '' });
  const { beforeText, afterText } = inputs.scope === shareScope ? inputs : { beforeText: '', afterText: '' };
  const [comparison, setComparedLists] = useState(null);
  const comparedLists = comparison?.scope === shareScope ? comparison : null;
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

  const showComparison = useCallback((beforeText, afterText, scope) => {
    const revision = ++comparisonRevision.current;
    const before = parse(beforeText);
    const after = parse(afterText);
    const diff = computeDiff(before, after);
    setComparedLists({ scope, diff, beforeText, afterText, beforeProblems: before.problems, afterProblems: after.problems });
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
    showComparison(beforeText, afterText, shareScope);
  }

  function updateInput(field, text) {
    setInputs(current => ({
      ...(current.scope === shareScope ? current : { scope: shareScope, beforeText: '', afterText: '' }),
      [field]: text,
    }));
  }

  function handleClear() {
    setInputs({ scope: shareScope, beforeText: '', afterText: '' });
    comparisonRevision.current++;
    setComparedLists(null);
    setCardMap(null);
  }

  function handleSwap() {
    setInputs({ scope: shareScope, beforeText: afterText, afterText: beforeText });
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
    if (!shareScope) return;
    let active = true;
    comparisonRevision.current++;
    async function loadShare() {
      try {
        const data = await getShare(shareScope.id);
        if (!active) return;
        const beforeText = data.beforeText || '';
        const afterText = data.afterText || '';
        setInputs({ scope: shareScope, beforeText, afterText });
        showComparison(beforeText, afterText, shareScope);
        setShareLoad({ scope: shareScope, status: 'ready' });
      } catch {
        if (active) setShareLoad({ scope: shareScope, status: 'error' });
      }
    }
    loadShare();
    return () => { active = false; };
  }, [shareScope, showComparison]);

  async function handleShare(expiresAt) {
    const commanders = diffResult?.commanders || [];
    const title = commanders.length > 0 ? commanders.join(' / ') + ' Changelog' : null;
    const { id } = await createShare(comparedLists.beforeText, comparedLists.afterText, title, expiresAt);
    return comparisonShareUrl(id);
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
      if (['main', 'share'].includes(route) && !e.target.closest?.('[role="dialog"], dialog')
        && (e.ctrlKey || e.metaKey) && e.key === 'Enter' && canCompareRef.current) {
        e.preventDefault();
        handleCompareRef.current();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [route]);

  const inShell = content => <AppShell route={route} version={APP_VERSION} onWhatsNew={() => setShowWhatsNew(true)} onShowForgotPassword={() => setShowForgotPassword(true)}>
    {showForgotPassword && !user && <ErrorBoundary><ForgotPassword onClose={() => setShowForgotPassword(false)} /></ErrorBoundary>}
    <ErrorBoundary key={resetToken ? 'password-reset' : route}><Suspense fallback={<div className="app-loading" role="status"><span className="loading-pulse" /> Loading your workspace…</div>}>{content}</Suspense></ErrorBoundary>
    {showWhatsNew && <WhatsNewModal version={APP_VERSION} changes={WHATS_NEW} onClose={() => setShowWhatsNew(false)} />}
  </AppShell>;

  if (resetToken) return inShell(<div className="app-auth-required"><header className="page-heading"><h1>Set a new password</h1><p>Choose a new password for your CLC account.</p></header><ResetPassword token={resetToken} onComplete={() => { clearPasswordResetUrl(); setResetToken(null); }} /></div>);
  if (AUTH_ROUTES[route] && authLoading) return inShell(<div className="app-loading" role="status">Loading your account…</div>);
  if (AUTH_ROUTES[route] && !user) return inShell(<section className="app-auth-required"><span className="auth-required-icon"><Icon name="user" size={36} /></span><h1>Log in to continue</h1><p>{AUTH_ROUTES[route]} is available when you’re signed in. Use <strong>Log In</strong> above to pick up where you left off.</p><a className="btn btn-secondary" href="#">Compare without an account <Icon name="arrow" size={16} /></a></section>);
  if (route === 'guide') return inShell(<GuidePage />);
  if (route === 'admin') return inShell(<AdminPage />);
  if (route === 'settings' && user) return inShell(<UserSettings key={user.id} />);
  if (route === 'connections' && user) return inShell(<ConnectionsPage key={user.id} />);
  if (route === 'printList' && user) return inShell(<PrintListPage key={user.id} initialPrintJobId={initialPrintJobId} initialComparison={printComparison} onComparisonConsumed={onComparisonConsumed} />);
  if (route === 'printStation' && user) return inShell(<PrintStationPage key={user.id} />);
  if (route === 'library' && user) return inShell(<DeckLibrary key={user.id} />);
  if (route === 'libraryDeck' && user && deckId) return inShell(<DeckPage key={`${user.id}:${deckId}`} deckId={deckId} initialPrintJobId={initialPrintJobId} />);
  if (route === 'deck' && deckShareId) return inShell(<SharedDeckView key={deckShareId} shareId={deckShareId} />);
  if (shareScope && shareLoad?.scope !== shareScope) return inShell(<div className="app-loading" role="status">Loading shared comparison…</div>);
  if (shareScope && shareLoad.status === 'error') return inShell(<section className="app-auth-required">
    <h1>Shared comparison unavailable</h1>
    <p role="alert">The link may be invalid or expired.</p>
    <a className="btn btn-secondary" href="#">Compare deck lists</a>
  </section>);

  return inShell(
    <div className="app compare-workspace">
      <header className="compare-hero">
        <div><h1>Compare deck lists</h1><p>Find cards to add or remove, then print or export the changes.</p></div>
        <a className="compare-help" href="#guide/deck-comparison">How to compare <Icon name="guide" size={16} /></a>
      </header>

      <div id="deck-inputs" className="app-inputs">
        <DeckInput
          key={`${user?.id || 'guest'}-before`}
          label="Before"
          caption="Earlier version or the deck you have in paper"
          value={beforeText}
          onChange={text => updateInput('beforeText', text)}
          user={user}
        />
        <DeckInput
          key={`${user?.id || 'guest'}-after`}
          label="After"
          caption="Newer version you want to build"
          value={afterText}
          onChange={text => updateInput('afterText', text)}
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
          Swap lists
        </button>
        <button className="btn btn-secondary" onClick={handleClear} type="button">
          Clear lists
        </button>
      </div>

      <ErrorBoundary>
        {diffResult && <>
          {(beforeText !== comparedLists.beforeText || afterText !== comparedLists.afterText) &&
            <p role="status">These results use your last comparison. Compare again to use the edited lists for printing or export.</p>}
          {(comparedLists.beforeProblems.length > 0 || comparedLists.afterProblems.length > 0) &&
            <p role="status">This comparison omits unsupported etched cards from {[
              ['Before', comparedLists.beforeProblems],
              ['After', comparedLists.afterProblems],
            ].filter(([, problems]) => problems.length).map(([label, problems]) =>
              `${label} (${problems.length} ${problems.length === 1 ? 'line' : 'lines'}, first on line ${problems[0].line})`).join(' and ')}.</p>}
          <ChangelogOutput diffResult={diffResult} cardMap={cardMap} onShare={handleShare} shareOwnerId={user?.id}
            afterText={comparedLists.afterText} beforeText={comparedLists.beforeText} />
        </>}
      </ErrorBoundary>


    </div>
  );
}
