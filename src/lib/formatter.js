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

function formatSection(title, section, typeMap) {
  const { cardsIn, cardsOut, quantityChanges } = section;

  if (cardsIn.length === 0 && cardsOut.length === 0 && quantityChanges.length === 0) {
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
  const { cardsIn, cardsOut, quantityChanges } = section;

  if (cardsIn.length === 0 && cardsOut.length === 0 && quantityChanges.length === 0) {
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
 * Format a deck list text for Archidekt import.
 * Commander cards get an inline "//COMMANDER" tag so Archidekt
 * auto-assigns them to the command zone on import.
 * Converts "Sideboard" header to "# Sideboard".
 */
export function formatForArchidekt(text, commanders = []) {
  if (!text || !text.trim()) return '';

  const parsed = parse(text);
  // Merge explicit commanders param with any parsed from the text
  const allCommanders = new Set([
    ...commanders.map(c => c.toLowerCase()),
    ...parsed.commanders.map(c => c.toLowerCase()),
  ]);

  function formatEntry(entry) {
    // Archidekt text format: 1x Name (set) collectorNum *F* [Category]
    let line = `${entry.quantity}x ${entry.displayName}`;
    if (entry.setCode) line += ` (${entry.setCode})`;
    if (entry.collectorNumber) line += ` ${entry.collectorNumber}`;
    if (entry.isFoil) line += ` *F*`;
    if (allCommanders.has(entry.displayName.toLowerCase())) {
      line += ` [Commander{top}]`;
    }
    return line;
  }

  const result = [];

  for (const [, entry] of parsed.mainboard) {
    result.push(formatEntry(entry));
  }

  if (parsed.sideboard.size > 0) {
    result.push('# Sideboard');
    for (const [, entry] of parsed.sideboard) {
      result.push(formatEntry(entry));
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
    },
    ...(hasSideboard ? {
      sideboard: {
        cardsIn: sideboard.cardsIn,
        cardsOut: sideboard.cardsOut,
        quantityChanges: sideboard.quantityChanges,
      },
    } : {}),
  }, null, 2);
}
