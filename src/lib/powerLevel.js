/**
 * Power Level Estimation for Commander decks.
 *
 * Heuristic-based scoring (1–10 scale) using card type distribution,
 * mana curve, and known card patterns. Not a substitute for human
 * evaluation, but gives a directional signal.
 *
 * Input: parsed deck (from parser.js) + cardMap (from scryfall.js)
 */

// Known fast mana cards (lowercase)
const FAST_MANA = new Set([
  'sol ring', 'mana crypt', 'mana vault', 'mox diamond', 'chrome mox',
  'mox opal', 'mox amber', 'lotus petal', 'dark ritual', 'cabal ritual',
  'simian spirit guide', 'elvish spirit guide', 'jeweled lotus',
  'lion\'s eye diamond', 'grim monolith', 'basalt monolith',
  'arcane signet', 'fellwar stone', 'talisman of progress',
  'talisman of dominance', 'talisman of indulgence', 'talisman of impulse',
  'talisman of unity', 'talisman of creativity', 'talisman of conviction',
  'talisman of curiosity', 'talisman of hierarchy', 'talisman of resilience',
  'carpet of flowers', 'deathrite shaman', 'birds of paradise',
  'llanowar elves', 'elvish mystic', 'fyndhorn elves', 'avacyn\'s pilgrim',
  'elves of deep shadow', 'ignoble hierarch', 'noble hierarch',
  'bloom tender', 'priest of titania', 'orcish lumberjack',
]);

// Known tutor cards (lowercase, partial matches)
const TUTOR_PATTERNS = [
  'demonic tutor', 'vampiric tutor', 'imperial seal', 'mystical tutor',
  'enlightened tutor', 'worldly tutor', 'gamble', 'diabolic intent',
  'diabolic tutor', 'final parting', 'grim tutor', 'razaketh',
  'sidisi, undead vizier', 'doomsday', 'wishclaw talisman',
  'scheming symmetry', 'profane tutor', 'personal tutor',
  'merchant scroll', 'muddle the mixture', 'trophy mage',
  'trinket mage', 'fabricate', 'whir of invention',
  'idyllic tutor', 'open the armory', 'eladamri\'s call',
  'chord of calling', 'green sun\'s zenith', 'natural order',
  'survival of the fittest', 'fauna shaman', 'birthing pod',
  'neoform', 'eldritch evolution', 'finale of devastation',
  'tooth and nail',
];

// Known free/efficient interaction (lowercase)
const FREE_INTERACTION = new Set([
  'force of will', 'pact of negation', 'fierce guardianship',
  'deflecting swat', 'deadly rollick', 'flawless maneuver',
  'force of negation', 'mental misstep', 'misdirection',
  'commandeer', 'mindbreak trap', 'foil',
  'swan song', 'dispel', 'spell pierce', 'negate',
  'pyroblast', 'red elemental blast', 'hydroblast', 'blue elemental blast',
  'swords to plowshares', 'path to exile', 'fatal push',
  'abrupt decay', 'assassin\'s trophy', 'cyclonic rift',
  'toxic deluge', 'fire covenant',
]);

// Cards that signal combo decks
const COMBO_ENABLERS = new Set([
  'thassa\'s oracle', 'demonic consultation', 'tainted pact',
  'laboratory maniac', 'jace, wielder of mysteries',
  'isochron scepter', 'dramatic reversal',
  'basalt monolith', 'rings of brighthearth', 'power artifact',
  'nim deathmantle', 'ashnod\'s altar', 'phyrexian altar',
  'kiki-jiki, mirror breaker', 'splinter twin', 'zealous conscripts',
  'felidar guardian', 'restoration angel',
  'exquisite blood', 'sanguine bond',
  'mindcrank', 'bloodchief ascension',
  'walking ballista', 'heliod, sun-crowned',
  'food chain', 'eternal scourge', 'squee, the immortal',
  'underworld breach', 'brain freeze', 'lion\'s eye diamond',
  'grinding station', 'salvaging station',
  'deadeye navigator', 'peregrine drake', 'palinchron',
  'mikaeus, the unhallowed', 'triskelion',
  'animate dead', 'worldgorger dragon',
]);

/**
 * Parse mana cost string like "{2}{U}{B}" to CMC number.
 */
function parseCmc(manaCost) {
  if (!manaCost) return 0;
  let cmc = 0;
  const tokens = manaCost.match(/\{[^}]+\}/g) || [];
  for (const token of tokens) {
    const inner = token.slice(1, -1);
    const num = parseInt(inner, 10);
    if (!isNaN(num)) {
      cmc += num;
    } else if (inner === 'X') {
      // X costs count as 0 for CMC
    } else {
      // Color symbol = 1 CMC each
      cmc += 1;
    }
  }
  return cmc;
}

/**
 * Estimate power level of a Commander deck.
 *
 * @param {Object} parsed - Output of parse() { mainboard, sideboard, commanders }
 * @param {Map} cardMap - Output of fetchCardData()
 * @returns {{ level: number, label: string, signals: string[] }}
 */
export function estimatePowerLevel(parsed, cardMap) {
  if (!parsed || !cardMap || cardMap.size === 0) {
    return { level: 0, label: 'Unknown', signals: ['No card data available'] };
  }

  // Collect all cards (mainboard + commanders)
  const allCards = [];
  for (const [key, entry] of parsed.mainboard) {
    const data = cardMap.get(entry.name.toLowerCase()) || {};
    allCards.push({ ...entry, ...data, key });
  }
  for (const [key, entry] of parsed.commanders) {
    const data = cardMap.get(entry.name.toLowerCase()) || {};
    allCards.push({ ...entry, ...data, key, isCommander: true });
  }

  const signals = [];
  let score = 5.0; // Start at middle

  const totalCards = allCards.length;
  if (totalCards === 0) {
    return { level: 0, label: 'Unknown', signals: ['Empty deck'] };
  }

  // --- Mana Curve ---
  const nonLands = allCards.filter(c => c.type !== 'Land');
  const cmcValues = nonLands.map(c => parseCmc(c.manaCost));
  const avgCmc = cmcValues.length > 0 ? cmcValues.reduce((a, b) => a + b, 0) / cmcValues.length : 0;

  if (avgCmc <= 1.8) { score += 1.5; signals.push(`Very low avg CMC (${avgCmc.toFixed(2)})`); }
  else if (avgCmc <= 2.3) { score += 1.0; signals.push(`Low avg CMC (${avgCmc.toFixed(2)})`); }
  else if (avgCmc <= 2.8) { score += 0.3; signals.push(`Moderate avg CMC (${avgCmc.toFixed(2)})`); }
  else if (avgCmc <= 3.5) { score -= 0.3; signals.push(`High avg CMC (${avgCmc.toFixed(2)})`); }
  else { score -= 1.0; signals.push(`Very high avg CMC (${avgCmc.toFixed(2)})`); }

  // --- Fast Mana ---
  const fastManaCount = allCards.filter(c => FAST_MANA.has(c.name.toLowerCase())).reduce((s, c) => s + c.quantity, 0);
  if (fastManaCount >= 10) { score += 1.5; signals.push(`${fastManaCount} fast mana sources`); }
  else if (fastManaCount >= 6) { score += 1.0; signals.push(`${fastManaCount} fast mana sources`); }
  else if (fastManaCount >= 3) { score += 0.5; signals.push(`${fastManaCount} fast mana sources`); }
  else if (fastManaCount === 0) { score -= 0.5; signals.push('No fast mana'); }

  // --- Tutors ---
  const tutorCount = allCards.filter(c => {
    const lower = c.name.toLowerCase();
    return TUTOR_PATTERNS.some(t => lower === t || lower.includes(t));
  }).reduce((s, c) => s + c.quantity, 0);
  if (tutorCount >= 6) { score += 1.5; signals.push(`${tutorCount} tutors`); }
  else if (tutorCount >= 3) { score += 1.0; signals.push(`${tutorCount} tutors`); }
  else if (tutorCount >= 1) { score += 0.3; signals.push(`${tutorCount} tutor${tutorCount > 1 ? 's' : ''}`); }

  // --- Free/Efficient Interaction ---
  const interactionCount = allCards.filter(c => FREE_INTERACTION.has(c.name.toLowerCase())).reduce((s, c) => s + c.quantity, 0);
  if (interactionCount >= 8) { score += 1.0; signals.push(`${interactionCount} efficient interaction pieces`); }
  else if (interactionCount >= 4) { score += 0.5; signals.push(`${interactionCount} efficient interaction pieces`); }

  // --- Combo Potential ---
  const comboCards = allCards.filter(c => COMBO_ENABLERS.has(c.name.toLowerCase()));
  const comboCount = comboCards.length;
  if (comboCount >= 4) { score += 1.5; signals.push(`${comboCount} combo enablers detected`); }
  else if (comboCount >= 2) { score += 0.8; signals.push(`${comboCount} combo enablers detected`); }

  // --- Land Count ---
  const landCount = allCards.filter(c => c.type === 'Land').reduce((s, c) => s + c.quantity, 0);
  const landRatio = landCount / totalCards;
  if (landRatio < 0.30) { score += 0.3; signals.push(`Low land count (${landCount})`); }
  else if (landRatio > 0.42) { score -= 0.3; signals.push(`High land count (${landCount})`); }

  // --- Card Price as Proxy ---
  const totalPrice = allCards.reduce((sum, c) => {
    const price = c.priceUsd ?? 0;
    return sum + price * c.quantity;
  }, 0);
  if (totalPrice > 2000) { score += 0.8; signals.push(`High-value deck ($${totalPrice.toFixed(0)})`); }
  else if (totalPrice > 800) { score += 0.3; }
  else if (totalPrice < 100) { score -= 0.3; signals.push(`Budget deck ($${totalPrice.toFixed(0)})`); }

  // Clamp to 1-10
  const level = Math.max(1, Math.min(10, Math.round(score)));

  const labels = {
    1: 'Jank', 2: 'Casual', 3: 'Casual',
    4: 'Focused', 5: 'Focused', 6: 'Optimized',
    7: 'Optimized', 8: 'High Power', 9: 'cEDH-lite',
    10: 'cEDH',
  };

  return { level, label: labels[level], signals };
}
