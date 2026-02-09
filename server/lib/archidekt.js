const ARCHIDEKT_BASE = 'https://archidekt.com/api';

export async function fetchOwnerDecks(archidektUsername) {
  // Step 1: Look up the user's numeric ID via the users endpoint
  const usersUrl = `${ARCHIDEKT_BASE}/users/?username=${encodeURIComponent(archidektUsername)}`;
  const usersRes = await fetch(usersUrl);
  if (!usersRes.ok) {
    throw new Error(`Archidekt users API returned status ${usersRes.status}`);
  }
  const usersData = await usersRes.json();
  const exactMatch = (usersData.results || []).find(
    u => u.username.toLowerCase() === archidektUsername.toLowerCase()
  );
  if (!exactMatch) {
    throw new Error(`Archidekt user "${archidektUsername}" not found`);
  }

  // Step 2: Fetch the user's decks by their numeric ID
  const decksUrl = `${ARCHIDEKT_BASE}/users/${exactMatch.id}/decks/`;
  const decksRes = await fetch(decksUrl);
  if (!decksRes.ok) {
    throw new Error(`Archidekt decks API returned status ${decksRes.status}`);
  }
  const decksData = await decksRes.json();
  // Archidekt wraps the array in { decks: [...], rootFolder: ... }
  const decksList = Array.isArray(decksData)
    ? decksData
    : decksData.decks || decksData.results || [];
  return decksList.map(deck => ({
    id: deck.id,
    name: deck.name,
    url: `https://archidekt.com/decks/${deck.id}`,
  }));
}

export async function fetchDeck(deckId) {
  const url = `${ARCHIDEKT_BASE}/decks/${deckId}/`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Deck not found on Archidekt');
    throw new Error(`Archidekt returned status ${res.status}`);
  }
  return res.json();
}
