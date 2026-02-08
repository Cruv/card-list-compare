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
  let output = formatSection('Mainboard', diffResult.mainboard);

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
