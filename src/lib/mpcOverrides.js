const validRevision = value => Number.isSafeInteger(value) && value >= 0;
const copy = entries => new Map(entries || []);
let windowDraftId;
const getWindowDraftId = () => windowDraftId ||= crypto.randomUUID();

/** Legacy arrays may migrate only after an authenticated, versioned server read. */
export function readMpcOverrideCache(raw) {
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return { legacy: copy(data) };
    if (data?.version !== 1 || (!validRevision(data.baseRevision) && !(data.baseRevision === null && data.pending === true))) return {};
    return {
      overrides: copy(data.overrides), baseline: copy(data.baseline),
      pending: data.pending === true, baseRevision: data.baseRevision,
      configured: data.configured === true,
    };
  } catch { return {}; }
}

/** Account/deck-scoped cache. Acknowledgements never erase another tab's draft. */
export function createMpcOverrideCache({ storage, session, key, legacyKey, createId = getWindowDraftId }) {
  const sessionKey = `${key}:session`;
  // Browser duplication copies sessionStorage. An identity generated for this
  // browser runtime cannot collide with the original tab's durable draft key.
  // Reopening the overlay in the same window keeps its own draft identity.
  const draftKey = `${key}:draft:${createId()}`;

  function read() {
    try {
      let tabRaw;
      try { tabRaw = session.getItem(sessionKey); } catch { /* durable storage may still work */ }
      const tabCache = readMpcOverrideCache(tabRaw);
      if (tabCache.pending) return tabCache;
      const ownRaw = storage.getItem(draftKey);
      if (ownRaw) return readMpcOverrideCache(ownRaw);
      // An already-used tab follows the server when it has no pending draft.
      // A new tab may recover a durable draft left by a closed tab.
      if (!tabRaw) {
        const candidates = [];
        for (let i = 0; i < storage.length; i++) {
          const candidateKey = storage.key(i);
          if (!candidateKey?.startsWith(`${key}:draft:`)) continue;
          const raw = storage.getItem(candidateKey);
          const data = JSON.parse(raw);
          if (readMpcOverrideCache(raw).pending) candidates.push({ key: candidateKey, raw, time: data.cachedAt || 0 });
        }
        candidates.sort((a, b) => b.time - a.time);
        if (candidates[0]) {
          return readMpcOverrideCache(candidates[0].raw);
        }
      }
      return readMpcOverrideCache(storage.getItem(key) || tabRaw || storage.getItem(legacyKey));
    } catch {
      try { return readMpcOverrideCache(session.getItem(sessionKey)); } catch { return {}; }
    }
  }

  function write(serialized) {
    let device = false;
    let tab = false;
    try { session.setItem(sessionKey, serialized); tab = true; } catch { /* report the remaining safe storage scope */ }
    try {
      const data = JSON.parse(serialized);
      if (data.pending) {
        storage.setItem(draftKey, JSON.stringify({ ...data, cachedAt: Date.now() }));
      } else {
        storage.setItem(key, serialized);
        storage.removeItem(draftKey);
        // Never remove a recovered foreign key: its editor may still be open,
        // and this tab's decision is not permission to discard that draft.
      }
      if (validRevision(data.baseRevision)) storage.removeItem(legacyKey);
      device = true;
    } catch { /* session storage or the open editor may be the only surviving draft */ }
    return device ? 'device' : tab ? 'tab' : 'window';
  }

  return { read, write };
}

export function getMpcArtworkDifferences(saved, draft) {
  const names = new Set([...saved.keys(), ...draft.keys()]);
  return [...names].filter(name => JSON.stringify(saved.get(name)) !== JSON.stringify(draft.get(name)))
    .map(name => ({ name, saved: saved.get(name), draft: draft.get(name) }));
}

function snapshot(data) {
  if (!validRevision(data?.revision) || !Array.isArray(data.overrides) || typeof data.configured !== 'boolean') {
    throw new Error('Artwork saves need an updated server. Reload CLC after updating it.');
  }
  return { overrides: copy(data.overrides), revision: data.revision, configured: data.configured };
}

/**
 * Complete-record saves use the last acknowledged server revision. A conflict or
 * uncertain response blocks every queued write until the user chooses recovery.
 * Persist the draft separately from its acknowledged baseline, including resets.
 */
export function createMpcOverrideSync({ loadRemote, saveRemote, initialCache = {}, persist = () => {} }) {
  let draft = copy(initialCache.overrides);
  let baseline = copy(initialCache.baseline);
  let baseRevision = validRevision(initialCache.baseRevision) ? initialCache.baseRevision : null;
  let configured = initialCache.configured === true;
  let pending = initialCache.pending === true;
  let loaded = false;
  let phase = 'loading';
  let error = null;
  let remote = null;
  let generation = 0;
  let block = 0;
  let writeQueue = Promise.resolve();
  let readPromise = null;
  let persistence = 'device';
  const listeners = new Set();

  function getState() {
    return {
      phase, error, pending, persistence, overrides: copy(draft), savedOverrides: copy(remote?.overrides || baseline),
      revision: remote?.revision ?? baseRevision,
      restored: phase === 'conflict' && error?.code === 'ARTWORK_DRAFT_RESTORED',
    };
  }

  function publish() {
    if (validRevision(baseRevision) || pending) {
      try {
        const result = persist(JSON.stringify({
          version: 1, overrides: [...draft], baseline: [...baseline],
          baseRevision, configured, pending,
        }));
        persistence = result === false ? 'window' : result || 'device';
      } catch { persistence = 'window'; }
    }
    for (const listener of listeners) listener(getState());
  }

  function adopt(data) {
    baseline = copy(data.overrides);
    baseRevision = data.revision;
    configured = data.configured;
    remote = null;
  }

  function holdConflict(data, reason) {
    remote = data;
    phase = 'conflict';
    error = reason;
    block++;
    publish();
  }

  function blockedError() {
    return error || new Error('Load saved artwork before saving changes.');
  }

  function save(overrides) {
    draft = copy(overrides);
    pending = true;
    const edit = ++generation;
    const requested = copy(draft);
    const allowedBlock = block;
    if (!loaded || phase === 'conflict' || phase === 'error' || phase === 'unavailable') {
      publish();
      return Promise.reject(blockedError());
    }
    phase = 'saving';
    publish();
    const request = writeQueue.catch(() => {}).then(async () => {
      if (block !== allowedBlock) throw blockedError();
      try {
        const response = await saveRemote([...requested], baseRevision);
        // A malformed/old success cannot establish a safe baseline for the next write.
        if (!validRevision(response?.revision) || response.revision !== baseRevision + 1) {
          throw new Error('The server did not confirm the artwork revision. Reload saved choices before continuing.');
        }
        adopt({ overrides: requested, revision: response.revision, configured: true });
        if (generation === edit) {
          pending = false;
          phase = 'ready';
        }
        error = null;
        publish();
        return response;
      } catch (cause) {
        if (cause.status === 409 && cause.data?.code === 'ARTWORK_CONFLICT') {
          try { holdConflict(snapshot(cause.data), cause); }
          catch (invalid) { error = invalid; phase = 'error'; block++; publish(); }
        } else {
          error = cause;
          phase = 'error';
          block++;
          publish();
        }
        throw cause;
      }
    });
    writeQueue = request;
    return request;
  }

  function load() {
    if (readPromise) return readPromise;
    const startedAt = generation;
    phase = 'loading';
    publish();
    readPromise = (async () => {
      try {
        const data = snapshot(await loadRemote());
        loaded = true;
        if (pending || generation !== startedAt) {
          // A lost response may have committed this exact draft. Reading it is
          // sufficient proof; no replay or guessed new revision is necessary.
          if (data.configured && getMpcArtworkDifferences(data.overrides, draft).length === 0) {
            adopt(data);
            pending = false;
            error = null;
            phase = 'ready';
          } else {
            // Keep the acknowledged baseline in the cache until explicit recovery.
            if (!validRevision(baseRevision)) adopt(data);
            const restored = new Error('Unsaved artwork is still on this device. Choose which choices to keep.');
            restored.code = 'ARTWORK_DRAFT_RESTORED';
            holdConflict(data, restored);
          }
          publish();
          return copy(draft);
        }
        adopt(data);
        error = null;
        phase = 'ready';
        const legacy = initialCache.legacy;
        if (!data.configured && legacy?.size > 0) {
          await save(legacy);
        } else {
          draft = copy(data.overrides);
          pending = false;
          publish();
        }
        return copy(draft);
      } catch (cause) {
        if (phase !== 'conflict' && phase !== 'error') {
          error = cause;
          phase = 'unavailable';
          publish();
        }
        throw cause;
      } finally { readPromise = null; }
    })();
    return readPromise;
  }

  async function retry() {
    if (!loaded) return load();
    if (phase !== 'error') throw blockedError();
    // Preserve the acknowledged revision even if the failed request committed.
    phase = 'ready';
    error = null;
    await writeQueue.catch(() => {});
    return save(draft);
  }

  function useSavedChoices() {
    if (phase !== 'conflict' || !remote) throw blockedError();
    generation++;
    adopt(remote);
    draft = copy(baseline);
    pending = false;
    phase = 'ready';
    error = null;
    publish();
    return copy(draft);
  }

  async function replaceSavedChoices() {
    if (phase !== 'conflict' || !remote) throw blockedError();
    // This is the only rebase: the user explicitly approved replacing the
    // displayed server snapshot. A further concurrent change still conflicts.
    const replacement = copy(draft);
    adopt(remote);
    phase = 'ready';
    error = null;
    await writeQueue.catch(() => {});
    return save(replacement);
  }

  return {
    load, save, retry, useSavedChoices, replaceSavedChoices, getState,
    subscribe(listener) { listeners.add(listener); listener(getState()); return () => listeners.delete(listener); },
  };
}

/** Freeze the displayed search defaults as well as custom art, including DFC backs. */
export function collectPrintArtwork(overrides, fronts = [], backs = []) {
  const result = new Map(overrides);
  for (const card of [...fronts, ...backs]) {
    if (!card.name || !card.identifier || card.hasMatch === false) continue;
    const key = card.name.toLowerCase();
    if (result.get(key)?.identifier) continue;
    result.set(key, {
      identifier: card.identifier, thumbnailUrl: card.thumbnailUrl,
      dpi: card.dpi, sourceName: card.sourceName, extension: card.extension || 'png',
    });
  }
  if (result.size > 612) throw new Error('Saved artwork exceeds 612 faces. Review or reset older choices before saving this deck.');
  return result;
}
