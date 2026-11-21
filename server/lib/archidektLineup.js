import { cardIdentityKey, normalizeCardName } from '../../src/lib/cardIdentity.js';
import { inspectDeckImport } from '../../src/lib/parser.js';
import { formatDeckCardLine } from './deckToText.js';

export function archidektLineupKey(text) {
  const counts = new Map();
  for (const row of inspectDeckImport(text).accepted) {
    const key = JSON.stringify([row.section, normalizeCardName(row.displayName)]);
    counts.set(key, (counts.get(key) ?? 0) + row.quantity);
  }
  return JSON.stringify([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

function printingKey(row) {
  return cardIdentityKey({ ...row, displayName: normalizeCardName(row.displayName) });
}

export function keepArchidektLocalPrintings(currentText, sourceText, previousSourceText) {
  const localByName = new Map();
  for (const row of inspectDeckImport(currentText).accepted) {
    const name = normalizeCardName(row.displayName);
    if (!localByName.has(name)) localByName.set(name, []);
    localByName.get(name).push({ ...row, printing: printingKey(row) });
  }

  const previousCopies = new Map();
  for (const row of inspectDeckImport(previousSourceText ?? '').accepted) {
    const printing = printingKey(row);
    if (!previousCopies.has(printing)) previousCopies.set(printing, new Map());
    const copies = previousCopies.get(printing);
    copies.set(row.section, (copies.get(row.section) ?? 0) + row.quantity);
  }

  const incoming = inspectDeckImport(sourceText).accepted.map(row => {
    const printing = printingKey(row);
    const local = localByName.get(normalizeCardName(row.displayName)) ?? [];
    const before = { quantity: 0, local, printing, section: row.section, kept: [] };
    const extra = { ...before, quantity: row.quantity, kept: [] };
    return { row, before, extra, previous: previousCopies.get(printing) };
  });

  // Match continuing source copies in their original section first, then match
  // moves. This reserves the incoming printing of any identifiable extra copy.
  for (const sameSection of [true, false]) {
    for (const { before, extra, previous } of incoming) {
      if (!previous || !extra.quantity) continue;
      for (const [section, available] of previous) {
        if (!extra.quantity) break;
        if (sameSection && section !== before.section) continue;
        const continuing = Math.min(available, extra.quantity);
        previous.set(section, available - continuing);
        before.quantity += continuing;
        extra.quantity -= continuing;
      }
    }
  }

  function allocate(slots, sameSection, samePrinting) {
    for (const slot of slots) {
      for (const local of slot.local) {
        if (!slot.quantity) break;
        if (!local.quantity || (sameSection && local.section !== slot.section) ||
            (samePrinting && local.printing !== slot.printing)) continue;
        const quantity = Math.min(slot.quantity, local.quantity);
        slot.kept.push({ ...local, quantity });
        local.quantity -= quantity;
        slot.quantity -= quantity;
      }
    }
  }

  for (const group of ['before', 'extra']) {
    const slots = incoming.map(entry => entry[group]).filter(slot => slot.quantity);
    for (const sameSection of [true, false]) {
      allocate(slots, sameSection, true);
      allocate(slots, sameSection, false);
    }
  }

  const sections = { commander: new Map(), main: new Map(), sideboard: new Map() };
  function addCopy(row, printing, quantity) {
    if (!quantity) return;
    const card = { ...printing, displayName: row.displayName, quantity };
    const section = sections[row.section];
    const key = cardIdentityKey(card);
    const existing = section.get(key);
    if (existing) existing.quantity += quantity;
    else section.set(key, card);
  }
  for (const { row, before, extra } of incoming) {
    for (const local of [...before.kept, ...extra.kept]) {
      addCopy(row, local, local.quantity);
    }
    addCopy(row, row, before.quantity + extra.quantity);
  }
  const lines = section => [...section.values()].map(card =>
    formatDeckCardLine(card.quantity, card.displayName, card.setCode, card.collectorNumber, card.isFoil));
  return [
    ...(sections.commander.size ? ['Commander', ...lines(sections.commander), ''] : []),
    ...lines(sections.main),
    ...(sections.sideboard.size ? ['', 'Sideboard', ...lines(sections.sideboard)] : []),
  ].join('\n');
}
