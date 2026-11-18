import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../context/AuthContext';
import { useModalLayer } from '../lib/useModalLayer';
import { getOwners, getOwnerDecks, addOwner, trackDeck, createLibraryDeck } from '../lib/api';
import { fetchDeckFromUrl, detectSite } from '../lib/fetcher';
import { createOperationId } from '../lib/operationId';
import { inspectDeckImport, inspectDeckPaste, parse } from '../lib/parser';
import { emptyLibraryDraft, loadLibraryImport, saveLibraryDraft, saveLibraryImportRequest, settleLibraryImport } from '../lib/libraryImport';
import Icon from './Icon';
import DeckImportReview from './DeckImportReview';
import './AddDecksDialog.css';

const TRACKED_SITES = ['archidekt', 'moxfield', 'deckcheck'];

export default function AddDecksDialog(props) {
  const { user } = useAuth();
  return user ? <ScopedAddDecksDialog key={user.id} userId={user.id} {...props} /> : null;
}

function ScopedAddDecksDialog({ userId, onClose, onAdded }) {
  const panelRef = useRef(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const sourceSequence = useRef(0);
  const token = useRef(null);
  const [draft, setDraft] = useState(emptyLibraryDraft);
  const [importReview, setImportReview] = useState(null);
  const [undoImport, setUndoImport] = useState(null);
  const [reviewedSource, setReviewedSource] = useState(null);
  const [sourcePreviewFailed, setSourcePreviewFailed] = useState(false);
  const [pending, setPending] = useState(null);
  const [storageReady, setStorageReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [added, setAdded] = useState(null);
  const [addedSourceIds, setAddedSourceIds] = useState(new Set());
  const [sources, setSources] = useState([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState('');
  const [sourceSearch, setSourceSearch] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [addingOwner, setAddingOwner] = useState(false);
  useModalLayer(onClose, { containerRef: panelRef });

  useEffect(() => {
    mounted.current = true;
    try {
      token.current = localStorage.getItem('clc-auth-token');
      const saved = loadLibraryImport(localStorage, userId);
      setDraft(saved.draft); setPending(saved.pending); setStorageReady(true);
    } catch (cause) { setError(cause.message); }
    return () => { mounted.current = false; };
  }, [userId]);

  const loadSources = useCallback(async () => {
    const sequence = ++sourceSequence.current;
    setSourcesLoading(true); setSourcesError('');
    try {
      const { owners } = await getOwners();
      // Keep failures attached to the affected account; another account can
      // still supply its untracked decks when one provider lookup fails.
      const rows = await Promise.all(owners.map(async owner => {
        try { return { owner, decks: (await getOwnerDecks(owner.id)).decks }; }
        catch (cause) { return { owner, decks: [], error: cause.message }; }
      }));
      if (mounted.current && sourceSequence.current === sequence) setSources(rows);
    } catch (cause) { if (mounted.current && sourceSequence.current === sequence) setSourcesError(cause.message); }
    finally { if (mounted.current && sourceSequence.current === sequence) setSourcesLoading(false); }
  }, []);
  useEffect(() => { void loadSources(); }, [loadSources]);

  function sessionCurrent() {
    if (!mounted.current || !token.current || token.current !== localStorage.getItem('clc-auth-token')) throw new Error('Your sign-in changed. Close and reopen Add decks before continuing.');
  }
  function edit(patch) {
    if (busyRef.current || pending || !storageReady) return;
    if (Object.hasOwn(patch, 'text') || Object.hasOwn(patch, 'tab') || Object.hasOwn(patch, 'url')) {
      setImportReview(null); setReviewedSource(null); setSourcePreviewFailed(false);
    }
    if (Object.hasOwn(patch, 'text')) setUndoImport(null);
    const next = { ...draft, ...patch };
    setDraft(next); setError(''); setNotice('');
    try { saveLibraryDraft(localStorage, userId, next); }
    catch (cause) { setError(`${cause.message} Your current text remains in this editor.`); }
  }
  async function submit(request) {
    if (busyRef.current || !storageReady) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    let recorded = false;
    try {
      sessionCurrent();
      const saved = saveLibraryImportRequest(localStorage, userId, request);
      setPending(saved.pending); recorded = true;
      const receipt = request.trackedOwnerId
        ? await trackDeck(request.trackedOwnerId, request.archidektDeckId, request.deckName, request.deckUrl)
        : await createLibraryDeck(request);
      if (!receipt.deck?.id) throw new Error('The server did not return the saved deck. Retry to confirm this import.');
      settleLibraryImport(localStorage, userId, request);
      if (!mounted.current) return;
      setPending(null); setAdded(receipt.deck);
      if (request.archidektDeckId) setAddedSourceIds(current => new Set([...current, request.archidektDeckId]));
      setNotice(receipt.tracking?.message || (receipt.linkedExisting ? 'This deck is already saved. Its current cards were preserved.' : 'Deck added to your library.'));
      try { await onAdded?.(); } catch { setNotice('The deck was added. Reopen Decks to refresh the library.'); }
    } catch (cause) {
      // Validation rejection cannot have created a deck. Uncertain failures
      // retain the original operation and exact body for a safe retry.
      if (recorded && [400, 422].includes(cause.status)) {
        try { settleLibraryImport(localStorage, userId, request); if (mounted.current) setPending(null); } catch { /* Keep the recovery record if storage failed. */ }
      }
      if (mounted.current) setError(cause.message);
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  function saveText(event) {
    event.preventDefault();
    if (importReview) return;
    const parsed = parse(draft.text);
    if (!draft.name.trim() || !draft.text.trim() || parsed.mainboard.size + parsed.sideboard.size === 0) {
      setError('Enter a name and at least one card in the list.'); return;
    }
    void submit({ operationId: createOperationId(), name: draft.name, deckText: draft.text });
  }
  function previewPaste(event) {
    const pasted = event.clipboardData?.getData('text/plain');
    if (!pasted?.trim()) return;
    event.preventDefault();
    const { selectionStart, selectionEnd } = event.currentTarget;
    const review = inspectDeckPaste(draft.text, pasted, selectionStart, selectionEnd);
    if (review.text.length > 500000) { setError('The card list exceeds 500,000 characters.'); return; }
    setImportReview(review);
  }
  function applyImport() {
    if (!importReview?.accepted.length) return;
    if (importReview.sourceUrl) {
      setReviewedSource({ sourceUrl: importReview.sourceUrl, deckText: importReview.text, name: importReview.sourceName });
      setImportReview(null);
      return;
    }
    const fromUrl = draft.tab === 'url';
    edit({ tab: 'text', text: importReview.text });
    setUndoImport({ text: draft.text, tab: draft.tab });
    if (fromUrl) setNotice('Add a name and save this list as a manual deck.');
  }
  async function importUrl(event) {
    event.preventDefault();
    const url = draft.url.trim(), site = detectSite(url);
    if (!site) { setError('Enter a supported public deck URL.'); return; }
    const tracked = TRACKED_SITES.includes(site);
    if (reviewedSource?.sourceUrl === url) {
      const name = draft.name.trim() || reviewedSource.name;
      void submit({ operationId: createOperationId(), sourceUrl: url, deckText: reviewedSource.deckText,
        ...(name ? { name } : {}) });
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setSourcePreviewFailed(false);
    try {
      sessionCurrent();
      const { text, skipped = [], sourceName } = await fetchDeckFromUrl(url, { review: true });
      sessionCurrent();
      if (text.length > 500000) throw new Error('The imported card list exceeds 500,000 characters.');
      const result = inspectDeckImport(text);
      setImportReview({ ...result, skipped: [...result.skipped, ...skipped],
        ...(tracked ? { sourceUrl: url, sourceName: typeof sourceName === 'string' ? sourceName.trim().slice(0, 200) : null } : {}) });
    } catch (cause) { if (mounted.current) { setError(cause.message); setSourcePreviewFailed(tracked); } }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  async function addAccount(event) {
    event.preventDefault();
    if (addingOwner || busyRef.current || !newOwner.trim()) return;
    setAddingOwner(true); setError('');
    try { sessionCurrent(); await addOwner(newOwner.trim()); if (!mounted.current) return; setNewOwner(''); await loadSources(); await onAdded?.(); }
    catch (cause) { if (mounted.current) setError(cause.message); }
    finally { if (mounted.current) setAddingOwner(false); }
  }
  const disabled = busy || addingOwner || !!pending || !storageReady;
  const site = detectSite(draft.url.trim());
  const untracked = sources.flatMap(({ owner, decks }) => decks.filter(deck => !deck.tracked && !addedSourceIds.has(deck.id)).map(deck => ({ owner, deck })));
  const filtered = untracked.filter(({ owner, deck }) => `${deck.name} ${owner.archidekt_username}`.toLowerCase().includes(sourceSearch.trim().toLowerCase()));

  return createPortal(<div className="add-decks-backdrop" role="dialog" aria-modal="true" aria-label="Add decks" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="add-decks-dialog" ref={panelRef} tabIndex={-1}>
      <header><div><h2>Add decks</h2><p>Start tracking a deck or save a card list.</p></div><button className="btn btn-secondary" type="button" onClick={onClose} aria-label="Close Add decks"><Icon name="close" /></button></header>
      {error && <p className="add-decks-error" role="alert">{error}</p>}
      {notice && <div className="add-decks-notice" role="status"><p>{notice}</p>{added && <a className="btn btn-primary" href={`#library/${added.id}`} onClick={onClose}>Open deck</a>}</div>}
      {pending && <section className="add-decks-pending" aria-label="Import awaiting confirmation"><h3>{busy ? 'Adding your deck…' : 'Confirm the saved import'}</h3><p>{pending.name || pending.deckName || pending.sourceUrl}</p><p>This request is saved. Retrying confirms the same deck without making another copy.</p><details><summary>Saved request</summary><pre>{pending.deckText || pending.sourceUrl || pending.deckUrl}</pre></details><button className="btn btn-primary" type="button" disabled={busy} onClick={() => submit(pending)}>{busy ? 'Adding…' : 'Retry saved import'}</button></section>}
      <nav className="add-decks-tabs" aria-label="Add deck methods">{[['sources', 'Untracked decks'], ['text', 'Paste a list'], ['url', 'Import URL']].map(([tab, label]) => <button key={tab} type="button" aria-current={draft.tab === tab ? 'page' : undefined} disabled={disabled} onClick={() => edit({ tab })}>{label}</button>)}</nav>
      {draft.tab === 'sources' && <div>
        <div className="add-decks-search"><label><Icon name="search" size={18} /><input type="search" value={sourceSearch} onChange={event => setSourceSearch(event.target.value)} placeholder="Find an untracked deck…" aria-label="Search untracked decks" /></label><button className="btn btn-secondary" type="button" onClick={loadSources} disabled={sourcesLoading || busy}>Reload decks</button></div>
        {sourcesLoading && <p role="status">Loading decks from your Archidekt accounts…</p>}
        {sourcesError && <p role="alert" className="add-decks-error">{sourcesError}</p>}
        {sources.filter(row => row.error).map(row => <p key={row.owner.id} role="alert" className="add-decks-error">{row.owner.archidekt_username}: {row.error}</p>)}
        {!sourcesLoading && !sourcesError && !untracked.length && <p className="add-decks-empty">{sources.some(row => row.error) ? 'No untracked decks loaded. Retry the accounts that could not be reached.' : sources.length ? 'All available decks from these accounts are already saved.' : 'Add an Archidekt account below to browse its decks, or paste a list or URL.'}</p>}
        {!sourcesLoading && untracked.length > 0 && !filtered.length && <p className="add-decks-empty">No untracked decks match this search.</p>}
        <ul className="add-decks-list">{filtered.map(({ owner, deck }) => <li key={`${owner.id}:${deck.id}`}><div><strong>{deck.name}</strong><span>@{owner.archidekt_username}</span></div><button className="btn btn-primary" type="button" disabled={disabled} onClick={() => submit({ operationId: createOperationId(), trackedOwnerId: owner.id, archidektDeckId: deck.id, deckName: deck.name, deckUrl: deck.url || `https://archidekt.com/decks/${deck.id}` })}>Track deck</button></li>)}</ul>
        <details className="add-decks-accounts" open={sources.length === 0 && !sourcesLoading}><summary>Add an Archidekt account</summary><p>Public decks from this account appear here. Tracking only starts when you choose a deck.</p><form onSubmit={addAccount}><input type="text" value={newOwner} onChange={event => setNewOwner(event.target.value)} maxLength={60} aria-label="Archidekt username" placeholder="Archidekt username" disabled={disabled} /><button className="btn btn-secondary" disabled={disabled || !newOwner.trim()} type="submit">{addingOwner ? 'Adding…' : 'Add account'}</button></form></details>
      </div>}
      {draft.tab === 'text' && <form className="add-decks-form" onSubmit={saveText}>
        <label>Deck name<input value={draft.name} onChange={event => edit({ name: event.target.value })} maxLength={200} disabled={disabled} required /></label>
        <label>Card list<textarea value={draft.text} onChange={event => edit({ text: event.target.value })} onPaste={previewPaste} maxLength={500000} disabled={disabled} rows={10} placeholder={'1 Sol Ring (C21) 263\n1 Counterspell\n\nSideboard\n1 Negate'} required /></label>
        {undoImport && <button className="btn btn-secondary" type="button" disabled={disabled} onClick={() => edit(undoImport)}>Undo import</button>}
        <p>Saved as a manual deck. You can add new versions later; the original text and printing choices are kept.</p>
        <button className="btn btn-primary" type="submit" disabled={disabled || !!importReview || !draft.name.trim() || !draft.text.trim()}>Save deck</button>
      </form>}
      {draft.tab === 'url' && <form className="add-decks-form" onSubmit={importUrl}>
        <label>Deck URL<input type="url" value={draft.url} onChange={event => edit({ url: event.target.value })} maxLength={2000} disabled={disabled} required placeholder="https://archidekt.com/decks/…" /></label>
        <label>Deck name (optional)<input value={draft.name} onChange={event => edit({ name: event.target.value })} maxLength={200} disabled={disabled} /></label>
        <p>{site && !TRACKED_SITES.includes(site) ? 'This site supports a one-time list import. Review the list before saving a manual deck.' : 'Archidekt, Moxfield, and DeckCheck stay linked for future updates. Saved local edits remain protected.'}</p>
        {reviewedSource && <p role="status">Reviewed list ready to save. {reviewedSource.name && `Source deck: ${reviewedSource.name}`}</p>}
        <button className="btn btn-primary" type="submit" disabled={disabled || !!importReview || !draft.url.trim()}>{reviewedSource ? 'Track reviewed deck' : 'Preview list'}</button>
        {reviewedSource && <button type="button" className="btn btn-secondary" disabled={disabled} onClick={() => setReviewedSource(null)}>Undo import</button>}
        {sourcePreviewFailed && <button type="button" className="btn btn-secondary" disabled={disabled} onClick={() => submit({
          operationId: createOperationId(), sourceUrl: draft.url.trim(), ...(draft.name.trim() ? { name: draft.name } : {}),
        })}>Track URL and wait for source</button>}
      </form>}
      {importReview && !disabled && <DeckImportReview review={importReview} baseline={draft.text} label="Preview deck import"
        onApply={applyImport} onCancel={() => setImportReview(null)} />}
    </section>
  </div>, document.body);
}
