/**
 * Deck Recommendations Engine
 *
 * Suggests Commander staple cards based on color identity, card types,
 * and what the deck is currently missing. Organized by category
 * (ramp, draw, removal, board wipes, lands, protection).
 *
 * Runs client-side against cardMap data from Scryfall.
 */

// ── Staple recommendations by color identity ──
// Each entry: { name, colors (set of required color letters), category, reason }
// Colors: W=White, U=Blue, B=Black, R=Red, G=Green, C=Colorless (any deck)

const STAPLES = [
  // === RAMP (Colorless — any deck) ===
  { name: 'Sol Ring', colors: '', category: 'Ramp', reason: 'Best mana rock in the format' },
  { name: 'Arcane Signet', colors: '', category: 'Ramp', reason: 'Produces any color in your identity' },
  { name: 'Fellwar Stone', colors: '', category: 'Ramp', reason: 'Efficient 2-mana rock' },
  { name: 'Mind Stone', colors: '', category: 'Ramp', reason: '2-mana rock that draws a card late game' },
  { name: 'Thought Vessel', colors: '', category: 'Ramp', reason: 'Ramp + no max hand size' },
  { name: 'Wayfarer\'s Bauble', colors: '', category: 'Ramp', reason: 'Colorless land ramp' },
  { name: 'Commander\'s Sphere', colors: '', category: 'Ramp', reason: 'Flexible mana rock + card draw' },
  { name: 'Mana Crypt', colors: '', category: 'Ramp', reason: 'Free fast mana (high power)' },
  { name: 'Mana Vault', colors: '', category: 'Ramp', reason: 'Burst mana for big turns' },
  { name: 'Chrome Mox', colors: '', category: 'Ramp', reason: 'Zero-cost mana acceleration' },
  { name: 'Jeweled Lotus', colors: '', category: 'Ramp', reason: 'Fast commander cast' },

  // === GREEN RAMP ===
  { name: 'Rampant Growth', colors: 'G', category: 'Ramp', reason: 'Efficient land ramp' },
  { name: 'Cultivate', colors: 'G', category: 'Ramp', reason: 'Two lands for one card' },
  { name: 'Kodama\'s Reach', colors: 'G', category: 'Ramp', reason: 'Two lands for one card' },
  { name: 'Nature\'s Lore', colors: 'G', category: 'Ramp', reason: 'Untapped land ramp' },
  { name: 'Three Visits', colors: 'G', category: 'Ramp', reason: 'Untapped land ramp' },
  { name: 'Farseek', colors: 'G', category: 'Ramp', reason: 'Finds dual lands' },
  { name: 'Birds of Paradise', colors: 'G', category: 'Ramp', reason: '1-mana any-color dork' },
  { name: 'Llanowar Elves', colors: 'G', category: 'Ramp', reason: '1-mana ramp creature' },
  { name: 'Elvish Mystic', colors: 'G', category: 'Ramp', reason: '1-mana ramp creature' },
  { name: 'Bloom Tender', colors: 'G', category: 'Ramp', reason: 'Multi-color mana dork' },
  { name: 'Sakura-Tribe Elder', colors: 'G', category: 'Ramp', reason: 'Ramp on a chump blocker' },

  // === BLACK RAMP ===
  { name: 'Dark Ritual', colors: 'B', category: 'Ramp', reason: 'Burst mana for explosive turns' },
  { name: 'Cabal Ritual', colors: 'B', category: 'Ramp', reason: 'Conditional burst mana' },
  { name: 'Black Market Connections', colors: 'B', category: 'Ramp', reason: 'Repeatable treasure, cards, and creatures' },

  // === CARD DRAW (Colorless) ===
  { name: 'Skullclamp', colors: '', category: 'Card Draw', reason: 'Best draw engine with small creatures' },

  // === BLUE CARD DRAW ===
  { name: 'Rhystic Study', colors: 'U', category: 'Card Draw', reason: 'Premier enchantment draw' },
  { name: 'Mystic Remora', colors: 'U', category: 'Card Draw', reason: 'Early game draw engine' },
  { name: 'Ponder', colors: 'U', category: 'Card Draw', reason: 'Efficient card selection' },
  { name: 'Preordain', colors: 'U', category: 'Card Draw', reason: 'Efficient card selection' },
  { name: 'Brainstorm', colors: 'U', category: 'Card Draw', reason: 'Instant-speed card selection' },
  { name: 'Windfall', colors: 'U', category: 'Card Draw', reason: 'Wheel effect for full hand refill' },

  // === BLACK CARD DRAW ===
  { name: 'Necropotence', colors: 'B', category: 'Card Draw', reason: 'Powerful repeatable draw' },
  { name: 'Sign in Blood', colors: 'B', category: 'Card Draw', reason: 'Efficient 2-mana draw' },
  { name: 'Read the Bones', colors: 'B', category: 'Card Draw', reason: 'Draw + scry for card quality' },
  { name: 'Phyrexian Arena', colors: 'B', category: 'Card Draw', reason: 'Repeatable draw engine' },
  { name: 'Night\'s Whisper', colors: 'B', category: 'Card Draw', reason: 'Efficient 2-card draw' },
  { name: 'Deadly Dispute', colors: 'B', category: 'Card Draw', reason: 'Draw + treasure from sacrifice' },

  // === GREEN CARD DRAW ===
  { name: 'Beast Whisperer', colors: 'G', category: 'Card Draw', reason: 'Draw on creature casts' },
  { name: 'Guardian Project', colors: 'G', category: 'Card Draw', reason: 'Draw on creature ETBs' },
  { name: 'The Great Henge', colors: 'G', category: 'Card Draw', reason: 'Draw + ramp + lifegain' },
  { name: 'Sylvan Library', colors: 'G', category: 'Card Draw', reason: 'Powerful repeatable selection' },

  // === WHITE CARD DRAW ===
  { name: 'Esper Sentinel', colors: 'W', category: 'Card Draw', reason: 'Tax-based draw on 1-drop' },
  { name: 'Welcoming Vampire', colors: 'W', category: 'Card Draw', reason: 'Draw on small creature ETBs' },
  { name: 'Archivist of Oghma', colors: 'W', category: 'Card Draw', reason: 'Flash draw on opponent searches' },

  // === RED CARD DRAW ===
  { name: 'Jeska\'s Will', colors: 'R', category: 'Card Draw', reason: 'Mana + impulse draw' },
  { name: 'Faithless Looting', colors: 'R', category: 'Card Draw', reason: 'Efficient card filtering' },
  { name: 'Wheel of Fortune', colors: 'R', category: 'Card Draw', reason: 'Full hand refill (high power)' },

  // === TARGETED REMOVAL ===
  { name: 'Swords to Plowshares', colors: 'W', category: 'Removal', reason: '1-mana exile removal' },
  { name: 'Path to Exile', colors: 'W', category: 'Removal', reason: '1-mana exile removal' },
  { name: 'Generous Gift', colors: 'W', category: 'Removal', reason: 'Destroys any permanent' },
  { name: 'Anguished Unmaking', colors: 'WB', category: 'Removal', reason: 'Exile any nonland permanent' },
  { name: 'Despark', colors: 'WB', category: 'Removal', reason: 'Exile high-CMC threats' },
  { name: 'Counterspell', colors: 'U', category: 'Removal', reason: 'Clean 2-mana counter' },
  { name: 'Swan Song', colors: 'U', category: 'Removal', reason: '1-mana counter for key spells' },
  { name: 'Fierce Guardianship', colors: 'U', category: 'Removal', reason: 'Free counter with commander' },
  { name: 'Force of Will', colors: 'U', category: 'Removal', reason: 'Free counter (high power)' },
  { name: 'Negate', colors: 'U', category: 'Removal', reason: 'Efficient noncreature counter' },
  { name: 'Reality Shift', colors: 'U', category: 'Removal', reason: 'Exile creature at instant speed' },
  { name: 'Fatal Push', colors: 'B', category: 'Removal', reason: 'Cheap creature removal' },
  { name: 'Go for the Throat', colors: 'B', category: 'Removal', reason: 'Efficient creature removal' },
  { name: 'Infernal Grasp', colors: 'B', category: 'Removal', reason: '2-mana unconditional removal' },
  { name: 'Feed the Swarm', colors: 'B', category: 'Removal', reason: 'Black enchantment removal' },
  { name: 'Abrupt Decay', colors: 'BG', category: 'Removal', reason: 'Uncounterable removal' },
  { name: 'Assassin\'s Trophy', colors: 'BG', category: 'Removal', reason: 'Destroys any permanent' },
  { name: 'Chaos Warp', colors: 'R', category: 'Removal', reason: 'Red catch-all removal' },
  { name: 'Beast Within', colors: 'G', category: 'Removal', reason: 'Destroys any permanent' },
  { name: 'Nature\'s Claim', colors: 'G', category: 'Removal', reason: '1-mana artifact/enchantment removal' },
  { name: 'Krosan Grip', colors: 'G', category: 'Removal', reason: 'Uncounterable artifact/enchant removal' },

  // === BOARD WIPES ===
  { name: 'Wrath of God', colors: 'W', category: 'Board Wipe', reason: 'Classic creature wipe' },
  { name: 'Farewell', colors: 'W', category: 'Board Wipe', reason: 'Flexible multi-type exile' },
  { name: 'Austere Command', colors: 'W', category: 'Board Wipe', reason: 'Modal board wipe' },
  { name: 'Supreme Verdict', colors: 'WU', category: 'Board Wipe', reason: 'Uncounterable wrath' },
  { name: 'Cyclonic Rift', colors: 'U', category: 'Board Wipe', reason: 'One-sided bounce (format staple)' },
  { name: 'Toxic Deluge', colors: 'B', category: 'Board Wipe', reason: 'Scalable cheap wipe' },
  { name: 'Damnation', colors: 'B', category: 'Board Wipe', reason: 'Black creature wipe' },
  { name: 'Blasphemous Act', colors: 'R', category: 'Board Wipe', reason: 'Usually costs 1 mana' },
  { name: 'Vandalblast', colors: 'R', category: 'Board Wipe', reason: 'One-sided artifact wipe' },

  // === PROTECTION / UTILITY ===
  { name: 'Lightning Greaves', colors: '', category: 'Protection', reason: 'Haste + shroud for commander' },
  { name: 'Swiftfoot Boots', colors: '', category: 'Protection', reason: 'Haste + hexproof for commander' },
  { name: 'Heroic Intervention', colors: 'G', category: 'Protection', reason: 'Save board from wipes' },
  { name: 'Teferi\'s Protection', colors: 'W', category: 'Protection', reason: 'Ultimate board protection' },
  { name: 'Flawless Maneuver', colors: 'W', category: 'Protection', reason: 'Free indestructible with commander' },
  { name: 'Deflecting Swat', colors: 'R', category: 'Protection', reason: 'Free redirect with commander' },
  { name: 'Deadly Rollick', colors: 'B', category: 'Protection', reason: 'Free exile with commander' },

  // === LANDS ===
  { name: 'Command Tower', colors: '', category: 'Lands', reason: 'Produces all commander colors' },
  { name: 'Exotic Orchard', colors: '', category: 'Lands', reason: 'Multi-color fixing from opponents' },
  { name: 'Reliquary Tower', colors: '', category: 'Lands', reason: 'No maximum hand size' },
  { name: 'Boseiju, Who Endures', colors: 'G', category: 'Lands', reason: 'Uncounterable removal on a land' },
  { name: 'Otawara, Soaring City', colors: 'U', category: 'Lands', reason: 'Bounce spell on a land' },
  { name: 'Urza\'s Saga', colors: '', category: 'Lands', reason: 'Tutors for Sol Ring / Mana Crypt' },
  { name: 'Ancient Tomb', colors: '', category: 'Lands', reason: 'Fast colorless mana' },
  { name: 'War Room', colors: '', category: 'Lands', reason: 'Card draw on a land' },

  // === RECURSION ===
  { name: 'Eternal Witness', colors: 'G', category: 'Recursion', reason: 'Return any card from graveyard' },
  { name: 'Regrowth', colors: 'G', category: 'Recursion', reason: 'Cheap graveyard recursion' },
  { name: 'Reanimate', colors: 'B', category: 'Recursion', reason: '1-mana reanimation' },
  { name: 'Animate Dead', colors: 'B', category: 'Recursion', reason: 'Efficient reanimation enchantment' },
  { name: 'Sun Titan', colors: 'W', category: 'Recursion', reason: 'Recurring small permanents' },
];

/**
 * Determine color identity from commander card data.
 * Returns a Set of color letters: W, U, B, R, G
 */
function getColorIdentity(commanderNames, cardMap) {
  const identity = new Set();
  for (const name of commanderNames) {
    const data = cardMap.get(name.toLowerCase());
    if (data?.colorIdentity) {
      for (const c of data.colorIdentity) {
        identity.add(c.toUpperCase());
      }
    }
  }
  return identity;
}

/**
 * Check if a staple's color requirement is met by the deck's color identity.
 */
function colorMatch(stapleColors, deckIdentity) {
  if (!stapleColors) return true; // colorless — always available
  for (const c of stapleColors) {
    if (!deckIdentity.has(c)) return false;
  }
  return true;
}

/**
 * Analyze deck for category gaps and adjust scores.
 */
function analyzeDeckNeeds(parsed, cardMap) {
  const categories = {
    ramp: 0,
    draw: 0,
    removal: 0,
    wipe: 0,
    lands: 0,
    protection: 0,
  };

  const allEntries = [...parsed.mainboard.values(), ...parsed.commanders.values()];
  const totalCards = allEntries.reduce((s, e) => s + e.quantity, 0);

  for (const entry of allEntries) {
    const data = cardMap.get(entry.name.toLowerCase());
    if (!data) continue;
    const type = (data.type || '').toLowerCase();
    const name = entry.name.toLowerCase();

    if (type.includes('land')) {
      categories.lands += entry.quantity;
    }

    // Rough heuristic classification
    if (type.includes('land') && !name.includes('fetch') && !name.includes('shock')) continue;

    // Check against known categories from our staple list
    const matchedStaple = STAPLES.find(s => s.name.toLowerCase() === name);
    if (matchedStaple) {
      const cat = matchedStaple.category.toLowerCase();
      if (cat === 'ramp') categories.ramp += entry.quantity;
      else if (cat === 'card draw') categories.draw += entry.quantity;
      else if (cat === 'removal') categories.removal += entry.quantity;
      else if (cat === 'board wipe') categories.wipe += entry.quantity;
      else if (cat === 'protection') categories.protection += entry.quantity;
    }
  }

  // Recommended minimums for a 100-card Commander deck
  const targets = { ramp: 10, draw: 10, removal: 8, wipe: 3, protection: 2 };
  const needs = {};
  for (const [cat, target] of Object.entries(targets)) {
    const current = categories[cat] || 0;
    needs[cat] = { current, target, deficit: Math.max(0, target - current) };
  }

  return { categories, needs, totalCards };
}

/**
 * Generate card recommendations for a Commander deck.
 *
 * @param {Object} parsed - Output of parse()
 * @param {Map} cardMap - Output of fetchCardData() with colorIdentity field
 * @param {string[]} commanders - Commander names
 * @returns {{ recommendations: Array, analysis: Object }}
 */
export function generateRecommendations(parsed, cardMap, commanders) {
  if (!parsed || !cardMap || cardMap.size === 0) {
    return { recommendations: [], analysis: null };
  }

  const colorIdentity = getColorIdentity(commanders, cardMap);
  const deckNeeds = analyzeDeckNeeds(parsed, cardMap);

  // Build set of cards already in the deck (lowercase names)
  const deckCards = new Set();
  for (const [, entry] of parsed.mainboard) deckCards.add(entry.name.toLowerCase());
  for (const [, entry] of parsed.commanders) deckCards.add(entry.name.toLowerCase());

  // Filter and score staples
  const recommendations = [];

  for (const staple of STAPLES) {
    // Skip if already in deck
    if (deckCards.has(staple.name.toLowerCase())) continue;

    // Skip if color identity doesn't match
    if (!colorMatch(staple.colors, colorIdentity)) continue;

    // Score based on deck needs
    let score = 50; // base score
    const cat = staple.category.toLowerCase();
    if (cat === 'ramp' && deckNeeds.needs.ramp?.deficit > 0) {
      score += deckNeeds.needs.ramp.deficit * 5;
    } else if (cat === 'card draw' && deckNeeds.needs.draw?.deficit > 0) {
      score += deckNeeds.needs.draw.deficit * 5;
    } else if (cat === 'removal' && deckNeeds.needs.removal?.deficit > 0) {
      score += deckNeeds.needs.removal.deficit * 5;
    } else if (cat === 'board wipe' && deckNeeds.needs.wipe?.deficit > 0) {
      score += deckNeeds.needs.wipe.deficit * 8;
    } else if (cat === 'protection' && deckNeeds.needs.protection?.deficit > 0) {
      score += deckNeeds.needs.protection.deficit * 6;
    }

    // Boost colorless staples slightly (universally useful)
    if (!staple.colors) score += 5;

    // Look up Scryfall data for price
    const data = cardMap.get(staple.name.toLowerCase());
    const priceUsd = data?.priceUsd ?? null;

    recommendations.push({
      name: staple.name,
      category: staple.category,
      reason: staple.reason,
      colors: staple.colors,
      score,
      priceUsd,
      type: data?.type || null,
      manaCost: data?.manaCost || null,
    });
  }

  // Sort by score (desc), then alphabetically
  recommendations.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return {
    recommendations,
    analysis: {
      colorIdentity: [...colorIdentity].sort(),
      ...deckNeeds,
    },
  };
}

/**
 * Get the list of all staple card names for Scryfall batch lookup.
 */
export function getStapleCardNames() {
  return STAPLES.map(s => s.name);
}
