import { describe, it, expect } from 'vitest';
import { emptyLibraryDraft, libraryImportKey, loadLibraryImport, saveLibraryDraft, saveLibraryImportRequest, settleLibraryImport } from './libraryImport';
const operationId = 'e58e6b3e-c26a-4ba9-a2af-d76c41742a40';
const request = { operationId, name: 'Friday deck', deckText: '1 Sol Ring (C21) 263\n1 Delver of Secrets // Insectile Aberration (MID) 47' };
function storage() { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }; }
describe('library import draft and uncertain creation recovery', () => {
  it('keeps exact text and original operation across close/reload, separate per user', () => {
    const store = storage();
    saveLibraryDraft(store, 1, { ...emptyLibraryDraft(), tab: 'text', text: request.deckText, name: request.name });
    saveLibraryImportRequest(store, 1, request);
    expect(loadLibraryImport(store, 1).pending).toEqual(request);
    expect(loadLibraryImport(store, 2)).toEqual({ draft: emptyLibraryDraft(), pending: null });
    expect(() => saveLibraryDraft(store, 1, emptyLibraryDraft())).toThrow('Confirm');
    expect(() => saveLibraryImportRequest(store, 1, { ...request, deckText: '1 Counterspell' })).toThrow('Another import');
    expect(saveLibraryImportRequest(store, 1, JSON.parse(JSON.stringify(request))).pending).toEqual(request);
  });
  it('never clears a different concurrent request and retains the text after settlement', () => {
    const store = storage();
    saveLibraryDraft(store, 1, { ...emptyLibraryDraft(), text: request.deckText });
    saveLibraryImportRequest(store, 1, request);
    expect(() => settleLibraryImport(store, 1, { ...request, name: 'changed' })).toThrow('changed');
    settleLibraryImport(store, 1, request);
    expect(loadLibraryImport(store, 1).draft.text).toBe(request.deckText);
    expect(loadLibraryImport(store, 1).pending).toBeNull();
  });
  it('preserves supported source URL requests without substituting pasted text', () => {
    const store = storage(), source = { operationId, sourceUrl: 'https://archidekt.com/decks/18032574' };
    saveLibraryImportRequest(store, 1, source);
    expect(loadLibraryImport(store, 1).pending).toEqual(source);
  });
  it.each([null, {}, { version: 1, draft: emptyLibraryDraft(), pending: { ...request, operationId: 'bad' } }, { version: 1, draft: { ...emptyLibraryDraft(), text: 'x'.repeat(500001) }, pending: null }])('blocks corrupted or oversized saved state rather than replacing it', value => {
    const store = storage(); store.setItem(libraryImportKey(1), JSON.stringify(value));
    expect(() => saveLibraryImportRequest(store, 1, request)).toThrow();
    expect(store.getItem(libraryImportKey(1))).toBe(JSON.stringify(value));
  });
  it('keeps account-row tracking identity for naturally idempotent retries', () => {
    const store = storage(), row = { operationId, trackedOwnerId: 4, archidektDeckId: 18032574, deckName: 'Sauron', deckUrl: 'https://archidekt.com/decks/18032574' };
    saveLibraryImportRequest(store, 1, row);
    expect(loadLibraryImport(store, 1).pending).toEqual(row);
    expect(() => saveLibraryImportRequest(store, 1, { ...row, trackedOwnerId: 5 })).toThrow('Another import');
  });
  it('does not report a request persisted if storage is unavailable', () => {
    const store = storage(); store.setItem = () => { throw new Error('quota exceeded'); };
    expect(() => saveLibraryImportRequest(store, 1, request)).toThrow('quota exceeded');
    expect(loadLibraryImport(store, 1).pending).toBeNull();
  });
});
