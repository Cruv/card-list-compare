import { parse } from './parser.js';

/**
 * Build a header line with commander name(s) and timestamp.
 * e.g. "📋 Atraxa, Praetors' Voice — Changelog (2025-01-15 3:42 PM)"
 */
function buildHeader(diffResult) {
  const commanders = diffResult.commanders || [];
  const now = new Date();
  const date = now.toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const time = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const timestamp = `${date} ${time}`;

  if (commanders.length > 0) {
    const cmdNames = commanders.join(' / ');
    return `${cmdNames} — Changelog (${timestamp})`;
  }

  return `Deck Changelog (${timestamp})`;
}

/**
 * Resolve the type for a card name from either a typeMap (Map<string, string>)
 * or a cardMap (Map<string, { type, ... }>).
 */
function resolveType(typeOrCardMap, name) {
  const entry = typeOrCardMap.get(name.toLowerCase());
  if (!entry) return 'Other';
  return typeof entry === 'string' ? entry : (entry.type || 'Other');
}

function formatCardsByType(cards, typeMap, lineFormatter) {
  if (!typeMap || typeMap.size === 0) {
    return cards.map(lineFormatter).join('');
  }

  // Canonical type order
  const TYPE_ORDER = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Other'];
  const groups = new Map();

  for (const card of cards) {
    const type = resolveType(typeMap, card.name);
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(card);
  }

  let text = '';
  for (const type of TYPE_ORDER) {
    const group = groups.get(type);
    if (!group || group.length === 0) continue;
    group.sort((a, b) => a.name.localeCompare(b.name));
    text += `  [${type}]\n`;
    text += group.map(lineFormatter).join('');
  }
  return text;
}

function formatPrintingDetail(card) {
  let old = '';
  if (card.oldSetCode) old += `(${card.oldSetCode.toUpperCase()})`;
  if (card.oldCollectorNumber) old += ` #${card.oldCollectorNumber}`;
  if (card.oldIsFoil) old += ' \u2726';

  let nw = '';
  if (card.newSetCode) nw += `(${card.newSetCode.toUpperCase()})`;
  if (card.newCollectorNumber) nw += ` #${card.newCollectorNumber}`;
  if (card.newIsFoil) nw += ' \u2726';

  return `${old.trim()} \u2192 ${nw.trim()}`;
}

function formatSection(title, section, typeMap) {
  const { cardsIn, cardsOut, quantityChanges, printingChanges = [] } = section;

  if (cardsIn.length === 0 && cardsOut.length === 0 && quantityChanges.length === 0 && printingChanges.length === 0) {
    return `=== ${title} ===\nNo changes.\n`;
  }

  let text = `=== ${title} ===\n\n`;

  if (cardsIn.length > 0) {
    text += '--- Cards In ---\n';
    text += formatCardsByType(cardsIn, typeMap, card => `+ ${card.quantity} ${card.name}\n`);
    text += '\n';
  }

  if (cardsOut.length > 0) {
    text += '--- Cards Out ---\n';
    text += formatCardsByType(cardsOut, typeMap, card => `- ${card.quantity} ${card.name}\n`);
    text += '\n';
  }

  if (quantityChanges.length > 0) {
    text += '--- Quantity Changes ---\n';
    text += formatCardsByType(quantityChanges, typeMap, card => {
      const sign = card.delta > 0 ? '+' : '';
      return `~ ${card.name} (${card.oldQty} \u2192 ${card.newQty}, ${sign}${card.delta})\n`;
    });
    text += '\n';
  }

  if (printingChanges.length > 0) {
    text += '--- Printing Changes ---\n';
    text += formatCardsByType(printingChanges, typeMap, card => {
      return `~ ${card.quantity} ${card.name}: ${formatPrintingDetail(card)}\n`;
    });
    text += '\n';
  }

  return text;
}

export function formatChangelog(diffResult, typeMap) {
  let output = buildHeader(diffResult) + '\n\n';

  output += formatSection('Mainboard', diffResult.mainboard, typeMap);

  if (diffResult.hasSideboard) {
    output += '\n' + formatSection('Sideboard', diffResult.sideboard, typeMap);
  }

  return output.trim();
}

/**
 * Format all new/added cards as MPCFill-compatible text.
 * Includes fully new cards + quantity increases (just the delta).
 * Format: "N Card Name" per line (one card per line).
 */
export function formatMpcFill(diffResult) {
  const lines = [];

  function addSection(section) {
    for (const card of section.cardsIn) {
      lines.push(`${card.quantity} ${card.name}`);
    }
    for (const card of section.quantityChanges) {
      if (card.delta > 0) {
        lines.push(`${card.delta} ${card.name}`);
      }
    }
  }

  addSection(diffResult.mainboard);
  if (diffResult.hasSideboard) {
    addSection(diffResult.sideboard);
  }

  return lines.join('\n');
}

/**
 * Extract all cards from a parsed deck as an array of { name, quantity }.
 * Used for MPC Autofill proxy search — includes mainboard, sideboard, and commanders.
 */
export function formatDeckForMpc(parsedDeck) {
  const cards = [];
  if (!parsedDeck) return cards;

  // Mainboard
  if (parsedDeck.mainboard) {
    for (const [, entry] of parsedDeck.mainboard) {
      cards.push({ name: entry.displayName, quantity: entry.quantity });
    }
  }

  // Sideboard
  if (parsedDeck.sideboard) {
    for (const [, entry] of parsedDeck.sideboard) {
      cards.push({ name: entry.displayName, quantity: entry.quantity });
    }
  }

  // Commanders (flat string array)
  if (parsedDeck.commanders) {
    for (const name of parsedDeck.commanders) {
      // Check if already included (commanders may also be in mainboard)
      if (!cards.some(c => c.name.toLowerCase() === name.toLowerCase())) {
        cards.push({ name, quantity: 1 });
      }
    }
  }

  return cards;
}

/**
 * Format changelog as Reddit-flavored markdown.
 */
function formatRedditCardsByType(cards, typeMap, lineFormatter) {
  if (!typeMap || typeMap.size === 0) {
    return cards.map(lineFormatter).join('');
  }

  const TYPE_ORDER = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Other'];
  const groups = new Map();

  for (const card of cards) {
    const type = resolveType(typeMap, card.name);
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(card);
  }

  let text = '';
  for (const type of TYPE_ORDER) {
    const group = groups.get(type);
    if (!group || group.length === 0) continue;
    group.sort((a, b) => a.name.localeCompare(b.name));
    text += `\n*${type}:*\n\n`;
    text += group.map(lineFormatter).join('');
  }
  return text;
}

function formatRedditSection(title, section, typeMap) {
  const { cardsIn, cardsOut, quantityChanges, printingChanges = [] } = section;

  if (cardsIn.length === 0 && cardsOut.length === 0 && quantityChanges.length === 0 && printingChanges.length === 0) {
    return '';
  }

  let text = `### ${title}\n\n`;

  if (cardsIn.length > 0) {
    text += '**Cards In:**\n';
    text += formatRedditCardsByType(cardsIn, typeMap, card => `- \\+ ${card.quantity} [[${card.name}]]\n`);
    text += '\n';
  }

  if (cardsOut.length > 0) {
    text += '**Cards Out:**\n';
    text += formatRedditCardsByType(cardsOut, typeMap, card => `- \\- ${card.quantity} [[${card.name}]]\n`);
    text += '\n';
  }

  if (quantityChanges.length > 0) {
    text += '**Quantity Changes:**\n';
    text += formatRedditCardsByType(quantityChanges, typeMap, card => {
      const sign = card.delta > 0 ? '+' : '';
      return `- ~ [[${card.name}]] (${card.oldQty} \u2192 ${card.newQty}, ${sign}${card.delta})\n`;
    });
    text += '\n';
  }

  if (printingChanges.length > 0) {
    text += '**Printing Changes:**\n';
    text += formatRedditCardsByType(printingChanges, typeMap, card => {
      return `- ~ [[${card.name}]]: ${formatPrintingDetail(card)}\n`;
    });
    text += '\n';
  }

  return text;
}

export function formatReddit(diffResult, typeMap) {
  let output = `## ${buildHeader(diffResult)}\n\n`;

  output += formatRedditSection('Mainboard', diffResult.mainboard, typeMap);

  if (diffResult.hasSideboard) {
    output += formatRedditSection('Sideboard', diffResult.sideboard, typeMap);
  }

  return output.trim();
}

/**
 * Build a metadata lookup from parsed deck data.
 * Returns Map<string(lowercased name), Array<{ setCode, collectorNumber, isFoil, quantity }>>
 * Stores all printings per card name to support multi-printing cards (e.g. Nazgul).
 */
function buildMetadataLookup(parsed) {
  const lookup = new Map();

  function addEntries(map) {
    for (const [, entry] of map) {
      const key = entry.displayName.toLowerCase();
      if (entry.setCode || entry.collectorNumber) {
        if (!lookup.has(key)) lookup.set(key, []);
        lookup.get(key).push({
          setCode: entry.setCode,
          collectorNumber: entry.collectorNumber,
          isFoil: entry.isFoil || false,
          quantity: entry.quantity,
        });
      }
    }
  }

  addEntries(parsed.mainboard);
  addEntries(parsed.sideboard);
  return lookup;
}

/**
 * Format a deck list text for Archidekt import.
 * Commander cards get an inline "[Commander{top}]" tag so Archidekt
 * auto-assigns them to the command zone on import.
 * Converts "Sideboard" header to "# Sideboard".
 *
 * When beforeText is provided, cards in the after text that lack printing
 * metadata will inherit set codes, collector numbers, and foil status from
 * matching cards in the before text. This mirrors the server-side
 * carry-forward enrichment pattern and handles multi-printing cards.
 */
export function formatForArchidekt(text, commanders = [], beforeText = null) {
  if (!text || !text.trim()) return '';

  const parsed = parse(text);
  // Merge explicit commanders param with any parsed from the text
  const allCommanders = new Set([
    ...commanders.map(c => c.toLowerCase()),
    ...parsed.commanders.map(c => c.toLowerCase()),
  ]);

  // Build metadata lookup from beforeText for carry-forward
  const beforeLookup = beforeText ? buildMetadataLookup(parse(beforeText)) : new Map();
  // Track consumption of multi-printing metadata (e.g. 9 unique Nazgul artworks)
  const consumed = new Map(); // key → number of printings already consumed

  /**
   * Get carry-forward metadata for a card entry that has no metadata of its own.
   * For multi-printing cards, returns printings sequentially to distribute artworks.
   * Returns an array of { setCode, collectorNumber, isFoil, quantity } entries
   * that cover the requested quantity, or null if no metadata is available.
   */
  function getBeforeMetadata(entry) {
    const key = entry.displayName.toLowerCase();
    const printings = beforeLookup.get(key);
    if (!printings || printings.length === 0) return null;

    const offset = consumed.get(key) || 0;

    if (printings.length === 1) {
      // Single printing — use for all copies
      return [{ ...printings[0], quantity: entry.quantity }];
    }

    // Multi-printing — distribute across artworks
    const result = [];
    let remaining = entry.quantity;
    let idx = offset;

    for (let i = 0; i < printings.length && remaining > 0; i++) {
      const pIdx = (idx + i) % printings.length;
      const p = printings[pIdx < printings.length ? pIdx : 0];
      // For sequential consumption, take up to the original quantity per printing
      const take = Math.min(p.quantity, remaining);
      if (take > 0) {
        result.push({ ...p, quantity: take });
        remaining -= take;
      }
    }

    // If we still have remaining, assign to first printing
    if (remaining > 0) {
      if (result.length > 0) {
        result[0] = { ...result[0], quantity: result[0].quantity + remaining };
      } else {
        result.push({ ...printings[0], quantity: remaining });
      }
    }

    consumed.set(key, offset + entry.quantity);
    return result;
  }

  function formatLine(qty, displayName, setCode, collectorNumber, isFoil) {
    let line = `${qty}x ${displayName}`;
    if (setCode) line += ` (${setCode})`;
    if (collectorNumber) line += ` ${collectorNumber}`;
    if (isFoil) line += ` *F*`;
    if (allCommanders.has(displayName.toLowerCase())) {
      line += ` [Commander{top}]`;
    }
    return line;
  }

  function formatEntry(entry) {
    // If the entry already has metadata, use it directly
    if (entry.setCode || entry.collectorNumber) {
      return [formatLine(entry.quantity, entry.displayName, entry.setCode, entry.collectorNumber, entry.isFoil)];
    }

    // Try carry-forward from beforeText
    const beforeMeta = getBeforeMetadata(entry);
    if (beforeMeta) {
      return beforeMeta.map(m =>
        formatLine(m.quantity, entry.displayName, m.setCode, m.collectorNumber, m.isFoil)
      );
    }

    // No metadata available — output bare name
    return [formatLine(entry.quantity, entry.displayName, '', '', false)];
  }

  const result = [];

  for (const [, entry] of parsed.mainboard) {
    result.push(...formatEntry(entry));
  }

  if (parsed.sideboard.size > 0) {
    result.push('# Sideboard');
    for (const [, entry] of parsed.sideboard) {
      result.push(...formatEntry(entry));
    }
  }

  return result.join('\n').trim();
}

/**
 * Format a deck list text as CSV for Archidekt file upload import.
 * Preserves set code, collector number, and foil status.
 * Output columns match Archidekt's expected import format.
 */
export function formatArchidektCSV(text, commanders = []) {
  if (!text || !text.trim()) return '';

  const parsed = parse(text);
  // Merge explicit commanders param with any parsed from the text
  const allCommanders = new Set([
    ...commanders.map(c => c.toLowerCase()),
    ...parsed.commanders.map(c => c.toLowerCase()),
  ]);

  // Match Archidekt's exact export header and column order
  const header = 'quantity,card name,edition name,edition code,category,secondary categories,label,modifier,collector number,salt,color,cmc,rarity,scryfall ID,types,price,collection status,card text';
  const rows = [header];

  function addEntries(map, sectionCategory) {
    for (const [, entry] of map) {
      const name = entry.displayName.includes(',') ? `"${entry.displayName}"` : entry.displayName;
      const isCommander = allCommanders.has(entry.displayName.toLowerCase());
      const category = isCommander ? 'Commander' : sectionCategory;
      const modifier = entry.isFoil ? 'Foil' : 'Normal';
      // Archidekt column order: quantity, card name, edition name, edition code,
      // category, secondary categories, label, modifier, collector number,
      // salt, color, cmc, rarity, scryfall ID, types, price, collection status, card text
      rows.push([
        entry.quantity,
        name,
        '',                              // edition name (we don't store this)
        entry.setCode || '',
        category,
        '""',                            // secondary categories
        'default',                       // label
        modifier,
        entry.collectorNumber || '',
        '',                              // salt
        '',                              // color
        '',                              // cmc
        '',                              // rarity
        '',                              // scryfall ID
        '',                              // types
        '',                              // price
        'not owned',                     // collection status
        '',                              // card text
      ].join(','));
    }
  }

  addEntries(parsed.mainboard, '');
  addEntries(parsed.sideboard, 'Sideboard');

  return rows.join('\n');
}

/**
 * Generate a Tabletop Simulator saved object JSON for a full deck.
 * Each card becomes a TTS card with its Scryfall image as a custom face.
 * cardMap should be a Map<string, { imageUri, ... }> from fetchCardData().
 *
 * Returns a JSON string ready to save as a .json file and import into TTS.
 */
export function formatTTS(text, cardMap, commanders = []) {
  if (!text || !text.trim()) return '';

  const parsed = parse(text);
  const deckCards = [];
  const cardBack = 'https://backs.scryfall.io/large/59/43/5946ea0e-0ade-4dab-8e25-6e51e0a6f0f3.jpg';

  let cardIdCounter = 100;

  function addEntries(map) {
    for (const [, entry] of map) {
      const nameLower = entry.displayName.toLowerCase();
      const compositeKey = entry.collectorNumber ? `${nameLower}|${entry.collectorNumber}` : null;
      const data = (compositeKey && cardMap?.get(compositeKey)) || cardMap?.get(nameLower);
      const faceUrl = data?.imageUri || '';

      for (let i = 0; i < entry.quantity; i++) {
        deckCards.push({
          id: cardIdCounter,
          name: entry.displayName,
          faceUrl,
        });
        cardIdCounter++;
      }
    }
  }

  // Commanders first, then mainboard, then sideboard
  const commanderSet = new Set([
    ...commanders.map(c => c.toLowerCase()),
    ...parsed.commanders.map(c => c.toLowerCase()),
  ]);

  // Separate commanders from mainboard
  const mainCards = new Map();
  const cmdCards = new Map();
  for (const [key, entry] of parsed.mainboard) {
    if (commanderSet.has(entry.displayName.toLowerCase())) {
      cmdCards.set(key, entry);
    } else {
      mainCards.set(key, entry);
    }
  }

  addEntries(cmdCards);
  addEntries(mainCards);
  addEntries(parsed.sideboard);

  if (deckCards.length === 0) return '';

  // Build TTS deck object
  const containedObjects = deckCards.map((card, idx) => ({
    CardID: card.id * 100,
    Name: 'CardCustom',
    Nickname: card.name,
    Transform: {
      posX: 0, posY: 0, posZ: 0,
      rotX: 0, rotY: 180, rotZ: 180,
      scaleX: 1, scaleY: 1, scaleZ: 1,
    },
    CustomDeck: {
      [String(card.id)]: {
        FaceURL: card.faceUrl,
        BackURL: cardBack,
        NumWidth: 1,
        NumHeight: 1,
        BackIsHidden: true,
        UniqueBack: false,
      },
    },
  }));

  const customDeck = {};
  for (const card of deckCards) {
    customDeck[String(card.id)] = {
      FaceURL: card.faceUrl,
      BackURL: cardBack,
      NumWidth: 1,
      NumHeight: 1,
      BackIsHidden: true,
      UniqueBack: false,
    };
  }

  const cmdName = commanders.length > 0
    ? commanders.join(' / ')
    : (parsed.commanders.length > 0 ? parsed.commanders.join(' / ') : 'Deck');

  const ttsObject = {
    SaveName: cmdName,
    Date: new Date().toISOString(),
    ObjectStates: [{
      Name: 'DeckCustom',
      Nickname: cmdName,
      DeckIDs: deckCards.map(c => c.id * 100),
      CustomDeck: customDeck,
      ContainedObjects: containedObjects,
      Transform: {
        posX: 0, posY: 1, posZ: 0,
        rotX: 0, rotY: 180, rotZ: 180,
        scaleX: 1, scaleY: 1, scaleZ: 1,
      },
    }],
  };

  return JSON.stringify(ttsObject, null, 2);
}

/**
 * Format diff as structured JSON for data export.
 */
export function formatJSON(diffResult) {
  const { mainboard, sideboard, hasSideboard, commanders } = diffResult;
  return JSON.stringify({
    commanders,
    timestamp: new Date().toISOString(),
    mainboard: {
      cardsIn: mainboard.cardsIn,
      cardsOut: mainboard.cardsOut,
      quantityChanges: mainboard.quantityChanges,
      printingChanges: mainboard.printingChanges || [],
    },
    ...(hasSideboard ? {
      sideboard: {
        cardsIn: sideboard.cardsIn,
        cardsOut: sideboard.cardsOut,
        quantityChanges: sideboard.quantityChanges,
        printingChanges: sideboard.printingChanges || [],
      },
    } : {}),
  }, null, 2);
}
