// Regex patterns for parsing MTG card list lines
// Tried in order — first match wins

export const LINE_PATTERNS = [
  // "4 Lightning Bolt (M10) [227] *F*" — full metadata with set code, collector number, foil
  // Group 1: quantity, Group 2: card name, Group 3: set code,
  // Group 4: bracketed collector number [227] or [136p] or [DDO-20],
  // Group 5: bare collector number (only after set code) e.g. "227" or "136p",
  // Group 6: foil tag
  // Collector numbers can be alphanumeric with hyphens (e.g. 136p, DDO-20, 2022-3)
  // Bare collector numbers are nested inside the set code group to avoid
  // matching card name words when no set code is present.
  /^(\d+)\s*x?\s+(.+?)(?:\s+\(([A-Za-z0-9]+)\)(?:\s+\[([\w-]+)\]|\s+([\w-]+))?)?(\s+\*F\*)?\s*$/,

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
