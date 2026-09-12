const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const libraryImportKey = userId => `clc-library-import:${userId}`;
export const emptyLibraryDraft = () => ({ tab: 'sources', name: '', text: '', url: '' });

function validDraft(value) {
  return value && ['sources', 'text', 'url'].includes(value.tab) &&
    typeof value.name === 'string' && value.name.length <= 200 &&
    typeof value.text === 'string' && value.text.length <= 500000 &&
    typeof value.url === 'string' && value.url.length <= 2000;
}
function validRequest(value) {
  if (value?.trackedOwnerId !== undefined) return typeof value === 'object' && !Array.isArray(value) && UUID.test(value.operationId || '') &&
    Object.keys(value).every(key => ['operationId', 'trackedOwnerId', 'archidektDeckId', 'deckName', 'deckUrl'].includes(key)) &&
    Number.isSafeInteger(value.trackedOwnerId) && value.trackedOwnerId > 0 && Number.isSafeInteger(value.archidektDeckId) && value.archidektDeckId > 0 &&
    typeof value.deckName === 'string' && value.deckName.trim() && value.deckName.length <= 200 && typeof value.deckUrl === 'string' && value.deckUrl.length <= 2000;
  return value && typeof value === 'object' && !Array.isArray(value) && UUID.test(value.operationId || '') &&
    Object.keys(value).every(key => ['operationId', 'name', 'deckText', 'sourceUrl'].includes(key)) &&
    (value.name === undefined || typeof value.name === 'string' && value.name.length <= 200) &&
    (value.deckText === undefined || typeof value.deckText === 'string' && value.deckText.length <= 500000) &&
    (value.sourceUrl === undefined || typeof value.sourceUrl === 'string' && value.sourceUrl.length <= 2000) &&
    (value.sourceUrl?.trim() || value.name?.trim() && value.deckText?.trim());
}
export function loadLibraryImport(storage, userId) {
  const raw = storage.getItem(libraryImportKey(userId));
  if (!raw) return { draft: emptyLibraryDraft(), pending: null };
  const data = JSON.parse(raw);
  if (!data || data.version !== 1 || !validDraft(data.draft) || data.pending !== null && !validRequest(data.pending)) {
    throw new Error('The saved import could not be read. Keep this browser data until the previous request is recovered.');
  }
  return { draft: data.draft, pending: data.pending };
}
function save(storage, userId, value) {
  storage.setItem(libraryImportKey(userId), JSON.stringify({ version: 1, ...value }));
  return value;
}
export function saveLibraryDraft(storage, userId, draft) {
  if (!validDraft(draft)) throw new Error('The deck name, URL, or card list is too long.');
  const current = loadLibraryImport(storage, userId);
  if (current.pending) throw new Error('Confirm the saved import before starting another deck.');
  return save(storage, userId, { draft, pending: null });
}
export function saveLibraryImportRequest(storage, userId, request) {
  if (!validRequest(request)) throw new Error('Enter a deck name and card list, or a supported deck URL.');
  const current = loadLibraryImport(storage, userId);
  if (current.pending && JSON.stringify(current.pending) !== JSON.stringify(request)) throw new Error('Another import is awaiting confirmation. Reopen Add decks to recover it.');
  return save(storage, userId, { ...current, pending: request });
}
export function settleLibraryImport(storage, userId, request) {
  const current = loadLibraryImport(storage, userId);
  if (JSON.stringify(current.pending) !== JSON.stringify(request)) throw new Error('The saved import changed. Reopen Add decks to review its status.');
  return save(storage, userId, { ...current, pending: null });
}
