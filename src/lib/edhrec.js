/**
 * EDHREC curated card lists for Commander format.
 *
 * Banned list: https://edhrec.com/banned
 * Game Changers: https://edhrec.com/top/game-changers
 *
 * These are hardcoded to avoid external API dependencies.
 * Update periodically when the Commander Rules Committee announces changes.
 */

// All cards currently banned in Commander (lowercase)
export const COMMANDER_BANNED = new Set([
  // September 2024
  'dockside extortionist',
  'jeweled lotus',
  'mana crypt',
  'nadu, winged wisdom',
  // September 2021
  'golos, tireless pilgrim',
  // July 2020
  'hullbreacher',
  // April 2020
  'flash',
  // July 2019
  'iona, shield of emeria',
  'paradox engine',
  // April 2017
  'leovold, emissary of trest',
  // October 2016
  'prophet of kruphix',
  // September 2014
  'erayo, soratami ascendant',
  'rofellos, llanowar emissary',
  // February 2014
  'sylvan primordial',
  // April 2013
  'trade secrets',
  // September 2012
  'primeval titan',
  // June 2012
  'griselbrand',
  'sundering titan',
  // December 2010
  'emrakul, the aeons torn',
  // June 2010
  'channel',
  'tolarian academy',
  // June 2009
  'fastbond',
  // March 2009
  'tinker',
  // December 2008
  'time vault',
  // September 2008
  'karakas',
  // June 2008
  'limited resources',
  // February 2008
  'recurring nightmare',
  // May 2006
  "yawgmoth's bargain",
  // December 2005
  'shahrazad',
  // April 2005
  'balance',
  'library of alexandria',
  'upheaval',
  'falling star',
  // Power 9
  'ancestral recall',
  'black lotus',
  'mox emerald',
  'mox jet',
  'mox pearl',
  'mox ruby',
  'mox sapphire',
  'time walk',
  // Ante cards
  'amulet of quoz',
  'bronze tablet',
  'contract from below',
  'darkpact',
  'demonic attorney',
  'jeweled bird',
  'rebirth',
  'tempest efreet',
  'timmerian fiends',
]);

// EDHREC Game Changers — cards that dramatically warp Commander games (lowercase)
// Cards that "dramatically warp commander games, whether having players run away
// with resources, shift in ways many players dislike, cause people to not be able
// to play the game, really efficiently search for their strongest cards, or
// commanders that tend to be only built in ways that take away from more casual games."
export const GAME_CHANGERS = new Set([
  'rhystic study',
  'cyclonic rift',
  'smothering tithe',
  'demonic tutor',
  'ancient tomb',
  'fierce guardianship',
  'the one ring',
  "teferi's protection",
  "jeska's will",
  'vampiric tutor',
  'enlightened tutor',
  'mystical tutor',
  'farewell',
  'chrome mox',
  'mana vault',
  'worldly tutor',
  'force of will',
  'crop rotation',
  'gamble',
  'orcish bowmasters',
  'mox diamond',
  "bolas's citadel",
  'seedborn muse',
  "thassa's oracle",
  'underworld breach',
  'field of the dead',
  "gaea's cradle",
  'opposition agent',
  'imperial seal',
  'necropotence',
  'drannith magistrate',
  'consecrated sphinx',
  'grim monolith',
  "lion's eye diamond",
  'narset, parter of veils',
  'aura shards',
  'notion thief',
  'ad nauseam',
  'tergrid, god of fright',
  'natural order',
  'grand arbiter augustin iv',
  'intuition',
  'gifts ungiven',
  'glacial chasm',
  'survival of the fittest',
  "serra's sanctum",
  "mishra's workshop",
  'braids, cabal minion',
  'the tabernacle at pendrell vale',
  'humility',
  'coalition victory',
  'panoptic mirror',
  'biorhythm',
]);

/**
 * Check if a card is banned in Commander.
 * @param {string} name — card name
 * @returns {boolean}
 */
export function isBannedInCommander(name) {
  if (!name) return false;
  return COMMANDER_BANNED.has(name.toLowerCase());
}

/**
 * Check if a card is an EDHREC Game Changer.
 * @param {string} name — card name
 * @returns {boolean}
 */
export function isGameChanger(name) {
  if (!name) return false;
  return GAME_CHANGERS.has(name.toLowerCase());
}
