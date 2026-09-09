/**
 * Coordinate deck art choices with the server. Loading is read-only unless it
 * migrates existing local choices into a never-configured server record. Search results
 * are deliberately unrelated: missing cards and DFC backs must retain their art.
 */
export function createMpcOverrideSync({ loadRemote, saveRemote }) {
  let revision = 0;
  let writeQueue = Promise.resolve();

  function save(overrides) {
    revision++;
    const entries = [...overrides];
    // Requests replace the complete record, so preserve the user's edit order
    // even when an earlier request is slow or fails.
    writeQueue = writeQueue.catch(() => {}).then(() => saveRemote(entries));
    return writeQueue;
  }

  async function load(localOverrides) {
    const startedAt = revision;
    const data = await loadRemote();
    // A late initial response must not undo an art selection or Reset Art.
    if (revision !== startedAt) return null;

    const remoteOverrides = new Map(data.overrides || []);
    // An explicitly saved empty record means Reset Art. It must clear a stale
    // local cache instead of migrating that cache back into the server.
    if (remoteOverrides.size > 0 || data.configured === true) return remoteOverrides;

    if (localOverrides.size > 0) await save(localOverrides);
    // An explicit edit may have happened while migration was being saved.
    if (revision !== startedAt + (localOverrides.size > 0 ? 1 : 0)) return null;
    return localOverrides;
  }

  return { load, save };
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
