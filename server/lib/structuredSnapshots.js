import { createHash } from 'node:crypto';
import { parseLine } from '../../src/lib/parser.js';
import { COMMANDER_HEADER, MAINBOARD_HEADER, SIDEBOARD_HEADER, COMMENT_LINE } from '../../src/lib/constants.js';
import { all, get } from '../db.js';
import { trackedDeckSourceLink } from './deckSources.js';

export const textHash = text => createHash('sha256').update(text, 'utf8').digest('hex');

export function latestSnapshot(deckId) {
  return get('SELECT * FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [deckId]);
}

// Keep a card per source line, including printing metadata and its explicit
// section. Unknown identities remain null; this read never chooses a printing.
export function structuredCards(text) {
  const cards = [];
  const unresolvedLines = [];
  const sourceLines = text.split(/\r?\n/);
  const hasExplicitCommander = sourceLines.some(line => COMMANDER_HEADER.test(line.trim()));
  let section = 'mainboard';
  let sectionHasCards = false;
  let seenExplicitSideboard = false;
  for (const [index, rawLine] of sourceLines.entries()) {
    const line = rawLine.trim();
    if (!line) {
      // CLC's Archidekt converter ends the commander block with a blank line.
      // A blank directly after the heading still permits its first commander.
      if (section === 'commander' && sectionHasCards) section = 'mainboard';
      else if (section === 'mainboard' && sectionHasCards && !seenExplicitSideboard && !hasExplicitCommander) section = 'sideboard';
      sectionHasCards = false;
      continue;
    }
    if (COMMANDER_HEADER.test(line)) { section = 'commander'; sectionHasCards = false; continue; }
    if (MAINBOARD_HEADER.test(line)) { section = 'mainboard'; sectionHasCards = false; continue; }
    if (SIDEBOARD_HEADER.test(line) || /^#\s*sideboard\s*$/i.test(line)) { section = 'sideboard'; seenExplicitSideboard = true; sectionHasCards = false; continue; }
    if (COMMENT_LINE.test(line)) continue;
    // Other explicit headings belong to the saved text, not fabricated cards.
    if (/^\[.+\]$|^[\w\s]+:$/.test(line)) {
      section = line.replace(/^\[|\]$|:$/g, '').toLowerCase();
      sectionHasCards = false;
      unresolvedLines.push({ lineNumber: index + 1, rawLine });
      continue;
    }
    const card = parseLine(line);
    if (!card || !/^(?:SB:\s*)?\d+\s*(?:x?\s|,)/i.test(line)) {
      unresolvedLines.push({ lineNumber: index + 1, rawLine });
      continue;
    }
    cards.push({ name: card.name, quantity: card.quantity,
      section: card.isSB ? 'sideboard' : card.isCommander ? 'commander' : section,
      scryfallId: null, oracleId: null, setCode: card.setCode || '',
      collectorNumber: card.collectorNumber || '', finish: card.isFoil ? 'foil' : 'nonfoil',
      lineNumber: index + 1, rawLine });
    sectionHasCards = true;
  }
  return { cards, unresolvedLines };
}

export function serializeSnapshot(snapshot, latestId, paperId) {
  const proposal = snapshot.origin_proposal_id
    ? get('SELECT id, operation_id FROM deck_proposals WHERE id = ?', [snapshot.origin_proposal_id]) : null;
  return { id: String(snapshot.id), deckId: String(snapshot.tracked_deck_id),
    deckText: snapshot.deck_text, textHash: textHash(snapshot.deck_text),
    isLatest: snapshot.id === latestId, isPaper: snapshot.id === paperId,
    createdAt: snapshot.created_at, nickname: snapshot.nickname,
    ...structuredCards(snapshot.deck_text),
    origin: proposal ? { source: 'manasync', proposalId: proposal.id, operationId: proposal.operation_id } : null };
}

export function serializeDeck(deck) {
  const snapshots = all('SELECT * FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at DESC, id DESC', [deck.id]);
  const latestId = snapshots[0]?.id ?? null;
  const paperId = snapshots.find(snapshot => snapshot.id === deck.paper_snapshot_id)?.id ?? null;
  return { id: String(deck.id), name: deck.deck_name, url: deck.deck_url, sourceLink: trackedDeckSourceLink(deck),
    latestSnapshotId: latestId === null ? null : String(latestId),
    paperSnapshotId: paperId === null ? null : String(paperId),
    snapshots: snapshots.map(snapshot => serializeSnapshot(snapshot, latestId, paperId)) };
}
