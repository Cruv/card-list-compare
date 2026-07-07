// Claude Code PostToolUse hook: after an Edit/Write to a file that has a
// mirrored twin elsewhere in the repo, remind the agent about the coupling.
// Exit code 2 routes the stderr message back to the agent (the edit has
// already happened — this is a reminder, not a gate). Any other outcome is
// silent. Never blocks work: malformed stdin exits 0.
import { readFileSync } from 'node:fs';

const TWINS = [
  [/(^|[\\/])src[\\/]lib[\\/]constants\.js$/i,
   'INVARIANT: CARD_LINE_PATTERN is the single-sourced card-line regex, consumed by parser.js AND server/lib/enrichDeckText.js (which indexes groups directly: cn = m[4]||m[5], foil = m[6]). If the pattern changed, update the behavior pins and docs/DECK_TEXT_FORMAT.md, then run: npx vitest run src/lib/invariants.test.js'],
  [/(^|[\\/])server[\\/]lib[\\/]enrichDeckText\.js$/i,
   'INVARIANT: enrichDeckText consumes the shared CARD_LINE_PATTERN from src/lib/constants.js — never declare a local card-line regex (past forks corrupted data). Group indexing: cn = m[4]||m[5], foil = m[6]. Run: npx vitest run src/lib/invariants.test.js'],
  [/(^|[\\/])src[\\/]lib[\\/]fetcher\.js$/i,
   'INVARIANT: archidektToText() is mirrored in server/lib/deckToText.js — text/commanders output must stay identical. Run: npx vitest run src/lib/invariants.test.js'],
  [/(^|[\\/])server[\\/]lib[\\/]deckToText\.js$/i,
   'INVARIANT: archidektToText() mirrors src/lib/fetcher.js — text/commanders output must stay identical. Run: npx vitest run src/lib/invariants.test.js'],
  [/(^|[\\/])Dockerfile$/i,
   'INVARIANT: the "COPY src/lib/..." line must ship every src/lib file the server imports (including transitive imports like parser.js -> constants.js). Run: npx vitest run src/lib/invariants.test.js'],
  [/(^|[\\/])server[\\/]db\.js$/i,
   'CAUTION: db.js is sql.js — run() persists the WHOLE db file per statement; direct getDb().run() writes are lost; no atomic write. See docs/INVARIANTS.md #1 before changing persistence or adding migrations.'],
];

let filePath = '';
try {
  filePath = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.file_path || '';
} catch {
  process.exit(0);
}

// Vendored copies (e.g. sql.js ships its own Dockerfile) are not our twins.
if (/[\\/]node_modules[\\/]/i.test(filePath)) process.exit(0);

for (const [re, msg] of TWINS) {
  if (re.test(filePath)) {
    console.error(msg);
    process.exit(2);
  }
}
process.exit(0);
