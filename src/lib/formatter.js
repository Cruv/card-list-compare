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

function formatCardsByType(cards, typeMap, lineFormatter) {
  if (!typeMap || typeMap.size === 0) {
    return cards.map(lineFormatter).join('');
  }

  // Canonical type order
  const TYPE_ORDER = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Other'];
  const groups = new Map();

  for (const card of cards) {
    const type = typeMap.get(card.name.toLowerCase()) || 'Other';
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
    const type = typeMap.get(card.name.toLowerCase()) || 'Other';
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
export function formatForArchidekt(text) {
  if (!text || !text.trim()) return '';

  const lines = text.split('\n');
  const output = [];
  let inCommander = false;
  const commanderCards = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();

    // Detect section headers
    if (lower === 'commander' || lower === 'commanders' || lower === 'command zone') {
      inCommander = true;
      continue;
    }
    if (lower === 'sideboard' || lower === 'side') {
      inCommander = false;
      output.push('# Sideboard');
      continue;
    }

    // Blank line ends commander section
    if (inCommander && trimmed === '') {
      inCommander = false;
      continue;
    }

    // Skip leading blank lines
    if (trimmed === '' && output.length === 0) continue;

    if (inCommander && trimmed) {
      commanderCards.push(trimmed);
    } else {
      output.push(trimmed || '');
    }
  }

  // Prepend commander cards with //COMMANDER tag
  const result = [];
  for (const card of commanderCards) {
    result.push(card + ' //COMMANDER');
  }
  result.push(...output);

  return result.join('\n').trim();
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
