// Regex patterns for parsing MTG card list lines
// Tried in order — first match wins

export const LINE_PATTERNS = [
  // "4 Lightning Bolt (M10) [227] *F*" — full metadata with set code, collector number, foil
  // Group 1: quantity, Group 2: card name, Group 3: set code, Group 4: collector number (bracketed), Group 5: foil tag
  // Trailing bare number (?:\s+\d+)? handles Arena/MTGO format "4 Lightning Bolt (M10) 123"
  /^(\d+)\s*x?\s+(.+?)(?:\s+\(([A-Za-z0-9]+)\))?(?:\s+\[(\d+)\])?(\s+\*F\*)?(?:\s+\d+)?\s*$/,

  // CSV: "4,Lightning Bolt" or "4,"Lightning Bolt""
  /^(\d+)\s*,\s*"?([^"]+)"?\s*$/,

  // Simple: "4 Lightning Bolt" or "4x Lightning Bolt"
  /^(\d+)\s*x?\s+(.+)$/i,
];

export const SIDEBOARD_HEADER = /^\s*(sideboard|sb)\s*[:.]?\s*$/i;
export const MAINBOARD_HEADER = /^\s*(mainboard|main|deck)\s*[:.]?\s*$/i;
export const COMMANDER_HEADER = /^\s*(commander|commanders|command zone)\s*[:.]?\s*$/i;
export const SB_PREFIX = /^\s*SB:\s*/i;
export const COMMENT_LINE = /^\s*(\/\/|#)/;
