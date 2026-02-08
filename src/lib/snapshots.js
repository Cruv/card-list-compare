/**
 * Deck snapshot storage using localStorage.
 *
 * Each snapshot stores:
 *  - id: unique identifier
 *  - name: user-provided or auto-generated name
 *  - text: raw deck list text
 *  - createdAt: ISO timestamp
 *  - source: 'paste' | 'archidekt' | 'moxfield' | 'file'
 *  - sourceUrl: original URL if imported
 */

const STORAGE_KEY = 'mtg-changelog-snapshots';

function loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveAll(snapshots) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots));
}

export function getSnapshots() {
  return loadAll().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function saveSnapshot({ name, text, source = 'paste', sourceUrl = null }) {
  const snapshots = loadAll();
  const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);

  const snapshot = {
    id,
    name: name || `Snapshot ${new Date().toLocaleString()}`,
    text,
    source,
    sourceUrl,
    createdAt: new Date().toISOString(),
  };

  snapshots.push(snapshot);
  saveAll(snapshots);
  return snapshot;
}

export function deleteSnapshot(id) {
  const snapshots = loadAll().filter((s) => s.id !== id);
  saveAll(snapshots);
  return snapshots;
}

export function getSnapshot(id) {
  return loadAll().find((s) => s.id === id) || null;
}

export function renameSnapshot(id, newName) {
  const snapshots = loadAll();
  const snap = snapshots.find((s) => s.id === id);
  if (snap) {
    snap.name = newName;
    saveAll(snapshots);
  }
  return snap;
}
