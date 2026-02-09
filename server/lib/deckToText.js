export function archidektToText(data) {
  const mainLines = [];
  const sideLines = [];
  const commanderLines = [];
  const commanderNames = [];

  const cards = data.cards || [];

  for (const entry of cards) {
    const name = entry.card?.oracleCard?.name || entry.card?.name || 'Unknown';
    const qty = entry.quantity || 1;
    const categories = (entry.categories || []).map((c) =>
      typeof c === 'string' ? c.toLowerCase() : (c.name || '').toLowerCase()
    );

    const line = `${qty} ${name}`;

    if (categories.includes('commander') || categories.includes('commanders')) {
      commanderLines.push(line);
      commanderNames.push(name);
    } else if (categories.includes('sideboard')) {
      sideLines.push(line);
    } else if (categories.includes('maybeboard') || categories.includes('considering')) {
      continue;
    } else {
      mainLines.push(line);
    }
  }

  let text = '';

  if (commanderLines.length > 0) {
    text += 'Commander\n' + commanderLines.join('\n') + '\n\n';
  }

  text += mainLines.join('\n');

  if (sideLines.length > 0) {
    text += '\n\nSideboard\n' + sideLines.join('\n');
  }

  return { text, commanders: commanderNames };
}
