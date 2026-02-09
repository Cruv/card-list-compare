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

function formatSection(title, section) {
  const { cardsIn, cardsOut, quantityChanges } = section;

  if (cardsIn.length === 0 && cardsOut.length === 0 && quantityChanges.length === 0) {
    return `=== ${title} ===\nNo changes.\n`;
  }

  let text = `=== ${title} ===\n\n`;

  if (cardsIn.length > 0) {
    text += '--- Cards In ---\n';
    for (const card of cardsIn) {
      text += `+ ${card.quantity} ${card.name}\n`;
    }
    text += '\n';
  }

  if (cardsOut.length > 0) {
    text += '--- Cards Out ---\n';
    for (const card of cardsOut) {
      text += `- ${card.quantity} ${card.name}\n`;
    }
    text += '\n';
  }

  if (quantityChanges.length > 0) {
    text += '--- Quantity Changes ---\n';
    for (const card of quantityChanges) {
      const sign = card.delta > 0 ? '+' : '';
      text += `~ ${card.name} (${card.oldQty} \u2192 ${card.newQty}, ${sign}${card.delta})\n`;
    }
    text += '\n';
  }

  return text;
}

export function formatChangelog(diffResult) {
  let output = buildHeader(diffResult) + '\n\n';

  output += formatSection('Mainboard', diffResult.mainboard);

  if (diffResult.hasSideboard) {
    output += '\n' + formatSection('Sideboard', diffResult.sideboard);
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
function formatRedditSection(title, section) {
  const { cardsIn, cardsOut, quantityChanges } = section;

  if (cardsIn.length === 0 && cardsOut.length === 0 && quantityChanges.length === 0) {
    return '';
  }

  let text = `### ${title}\n\n`;

  if (cardsIn.length > 0) {
    text += '**Cards In:**\n\n';
    for (const card of cardsIn) {
      text += `- \\+ ${card.quantity} [[${card.name}]]\n`;
    }
    text += '\n';
  }

  if (cardsOut.length > 0) {
    text += '**Cards Out:**\n\n';
    for (const card of cardsOut) {
      text += `- \\- ${card.quantity} [[${card.name}]]\n`;
    }
    text += '\n';
  }

  if (quantityChanges.length > 0) {
    text += '**Quantity Changes:**\n\n';
    for (const card of quantityChanges) {
      const sign = card.delta > 0 ? '+' : '';
      text += `- ~ [[${card.name}]] (${card.oldQty} \u2192 ${card.newQty}, ${sign}${card.delta})\n`;
    }
    text += '\n';
  }

  return text;
}

export function formatReddit(diffResult) {
  let output = `## ${buildHeader(diffResult)}\n\n`;

  output += formatRedditSection('Mainboard', diffResult.mainboard);

  if (diffResult.hasSideboard) {
    output += formatRedditSection('Sideboard', diffResult.sideboard);
  }

  return output.trim();
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
