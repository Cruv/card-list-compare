const ARCHIDEKT_BASE = 'https://archidekt.com/api';

export async function fetchOwnerDecks(archidektUsername) {
  const url = `${ARCHIDEKT_BASE}/decks/cards/?owner=${encodeURIComponent(archidektUsername)}&ownerexact=true&pageSize=100`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Archidekt returned status ${res.status}`);
  }
  const data = await res.json();
  return (data.results || []).map(deck => ({
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
