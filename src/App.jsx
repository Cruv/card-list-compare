import { useState, useEffect, useRef, useMemo } from 'react';
import DeckInput from './components/DeckInput';
import ChangelogOutput from './components/ChangelogOutput';
import AuthBar from './components/AuthBar';
import AdminPage from './components/admin/AdminPage';
import UserSettings from './components/UserSettings';
import DeckLibrary from './components/DeckLibrary';
import DeckPage from './components/DeckPage';
import SharedDeckView from './components/SharedDeckView';
import ForgotPassword from './components/ForgotPassword';
import ResetPassword from './components/ResetPassword';
import ErrorBoundary from './components/ErrorBoundary';
import { useAuth } from './context/AuthContext';
import { useHashRoute } from './lib/useHashRoute';
import { parse } from './lib/parser';
import { computeDiff } from './lib/differ';
import { collectCardNames, collectCardIdentifiers, fetchCardData } from './lib/scryfall';
import { createShare, getShare, verifyEmail } from './lib/api';
import { toast } from './components/Toast';
import { preloadManaSymbols } from './components/ManaCost';
import WhatsNewModal from './components/WhatsNewModal';
import './App.css';

const APP_VERSION = '2.37.1';
const WHATS_NEW = [
  'Deck library grid layout — tracked decks shown as visual cards in a responsive grid',
  'Individual deck pages — click any deck card to see snapshots, changelog, timeline, full deck, analytics, and settings in a dedicated page',
  'Download Images button now labeled "(Scryfall)" to clarify image source',
];

function getResetToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get('reset') || null;
}

function getVerifyToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get('verify') || null;
}

export default function App() {
  const { user } = useAuth();
  const { route, shareId, deckShareId, deckId } = useHashRoute();
  const [beforeText, setBeforeText] = useState('');
  const [afterText, setAfterText] = useState('');
  const [diffResult, setDiffResult] = useState(null);
  const [cardMap, setCardMap] = useState(null);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetToken, setResetToken] = useState(getResetToken);
  const [showWhatsNew, setShowWhatsNew] = useState(false);

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
      toast.info(`What's new in v${APP_VERSION}: ${WHATS_NEW[0]}, ${WHATS_NEW[1]}, and more!`, 8000);
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

  function handleCompare() {
    const before = parse(beforeText);
    const after = parse(afterText);
    const diff = computeDiff(before, after);
    setDiffResult(diff);
    setCardMap(null);

    // Fetch card data in the background (non-blocking)
    // Uses identifiers with set+collector when available for exact printing artwork
    const identifiers = collectCardIdentifiers(diff);
    if (identifiers.size > 0) {
      fetchCardData(identifiers)
        .then(setCardMap)
        .catch(() => {}); // Silent fail — cards just won't be grouped by type
    }
  }

  function handleClear() {
    setBeforeText('');
    setAfterText('');
    setDiffResult(null);
    setCardMap(null);
  }

  function handleSwap() {
    setBeforeText(afterText);
    setAfterText(beforeText);
    setDiffResult(null);
  }

  const canCompare = useMemo(
    () => beforeText.trim().length > 0 || afterText.trim().length > 0,
    [beforeText, afterText]
  );

  // Load shared comparison from URL hash (e.g. #share/abc123)
  useEffect(() => {
    if (route !== 'share' || !shareId) return;
    async function loadShare() {
      try {
        const data = await getShare(shareId);
        setBeforeText(data.beforeText || '');
        setAfterText(data.afterText || '');
        // Auto-compare
        const before = parse(data.beforeText || '');
        const after = parse(data.afterText || '');
        const diff = computeDiff(before, after);
        setDiffResult(diff);

        // Fetch card data in the background (with exact printing identifiers)
        const identifiers = collectCardIdentifiers(diff);
        if (identifiers.size > 0) {
          fetchCardData(identifiers)
            .then(setCardMap)
            .catch(() => {});
        }
      } catch {
        toast.error('Failed to load shared comparison. The link may be invalid or expired.');
      }
    }
    loadShare();
  }, [route, shareId]);

  async function handleShare() {
    const commanders = diffResult?.commanders || [];
    const title = commanders.length > 0 ? commanders.join(' / ') + ' Changelog' : null;
    const data = await createShare(beforeText, afterText, title);
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

  // If a reset token is in the URL, show the reset password form
  if (resetToken) {
    return (
      <div className="app">
        <header className="app-header">
          <h1 className="app-title">Card List Compare</h1>
        </header>
        <ResetPassword
          token={resetToken}
          onComplete={() => {
            setResetToken(null);
            window.history.replaceState(null, '', window.location.pathname);
          }}
        />
      </div>
    );
  }

  // Full-page admin panel (replaces main compare UI)
  if (route === 'admin') {
    return (
      <ErrorBoundary>
        <AdminPage />
      </ErrorBoundary>
    );
  }

  // Full-page settings (replaces main compare UI)
  if (route === 'settings' && user) {
    return (
      <ErrorBoundary>
        <UserSettings />
      </ErrorBoundary>
    );
  }

  // Full-page deck library (replaces main compare UI)
  if (route === 'library' && user) {
    return (
      <ErrorBoundary>
        <DeckLibrary />
      </ErrorBoundary>
    );
  }

  // Individual deck page (authenticated)
  if (route === 'libraryDeck' && user && deckId) {
    return (
      <ErrorBoundary>
        <DeckPage deckId={deckId} />
      </ErrorBoundary>
    );
  }

  // Shared deck view (public, no auth required)
  if (route === 'deck' && deckShareId) {
    return (
      <ErrorBoundary>
        <SharedDeckView shareId={deckShareId} />
      </ErrorBoundary>
    );
  }

  return (
    <div className="app" role="main">
      <a href="#deck-inputs" className="sr-only sr-only-focusable">Skip to content</a>
      <header className="app-header">
        <AuthBar
          onShowForgotPassword={() => { setShowForgotPassword(true); }}
        />
        <h1 className="app-title">Card List Compare</h1>
        <p className="app-subtitle">
          Compare two deck lists &mdash; paste, upload, or import from Archidekt / Moxfield / TappedOut / Deckstats / DeckCheck
        </p>
      </header>

      {showForgotPassword && !user && (
        <ErrorBoundary>
          <ForgotPassword onClose={() => setShowForgotPassword(false)} />
        </ErrorBoundary>
      )}

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
          Compare Lists
        </button>
        <button className="btn btn-secondary" onClick={handleSwap} type="button">
          Swap
        </button>
        <button className="btn btn-secondary" onClick={handleClear} type="button">
          Clear
        </button>
      </div>

      <ErrorBoundary>
        {diffResult && <ChangelogOutput diffResult={diffResult} cardMap={cardMap} onShare={handleShare} afterText={afterText} beforeText={beforeText} />}
      </ErrorBoundary>

      {!diffResult && (
        <div className="app-empty">
          <p>
            Paste, upload, or import deck lists from{' '}
            <strong>Archidekt</strong> or <strong>Moxfield</strong> URLs,
            then click <strong>Compare Lists</strong> to generate a changelog.
          </p>
          <p className="app-empty-hint">
            Track your decks in the <a href="#library">Deck Library</a> to automatically snapshot changes and compare versions.
          </p>
        </div>
      )}

      <footer className="app-footer">
        <button
          className="whatsnew-link"
          onClick={() => setShowWhatsNew(true)}
          type="button"
        >
          What's new in v{APP_VERSION}
        </button>
      </footer>

      {showWhatsNew && (
        <WhatsNewModal
          version={APP_VERSION}
          changes={WHATS_NEW}
          onClose={() => setShowWhatsNew(false)}
        />
      )}
    </div>
  );
}
