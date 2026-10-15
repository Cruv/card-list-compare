// Claude Code PostToolUse hook: after an Edit/Write to a file that has a
// mirrored twin elsewhere in the repo, remind the agent about the coupling.
// Exit code 2 routes the stderr reminder back to the agent; it does not undo
// the edit or require approval/retesting after every tool call. Any other outcome is
// silent. Never blocks work: malformed stdin exits 0.
import { readFileSync } from 'node:fs';

const TWINS = [
  [/(^|[\\/])src[\\/]lib[\\/]constants\.js$/i,
   'Shared card grammar: check the affected consumers/capture groups in docs/INVARIANTS.md and docs/DECK_TEXT_FORMAT.md when semantics change. CONTRIBUTING.md owns verification scope and evidence reuse.'],
  [/(^|[\\/])server[\\/]lib[\\/]enrichDeckText\.js$/i,
   'Enrichment consumes the shared card grammar. See docs/INVARIANTS.md for capture-group coupling; CONTRIBUTING.md owns verification scope and evidence reuse.'],
  [/(^|[\\/])src[\\/]lib[\\/]fetcher\.js$/i,
   'Archidekt text output has a server counterpart in server/lib/deckToText.js. Check semantic parity under docs/INVARIANTS.md; CONTRIBUTING.md owns verification scope and evidence reuse.'],
  [/(^|[\\/])server[\\/]lib[\\/]deckToText\.js$/i,
   'Archidekt text output has a client counterpart in src/lib/fetcher.js. Check semantic parity under docs/INVARIANTS.md; CONTRIBUTING.md owns verification scope and evidence reuse.'],
  [/(^|[\\/])Dockerfile$/i,
   'Shared server imports must ship in the production image, including transitive imports. See the COPY-closure invariant in docs/INVARIANTS.md and scoped checks in CONTRIBUTING.md.'],
  [/(^|[\\/])server[\\/]db\.js$/i,
   'sql.js persistence: preserve helper/transaction writes, atomic temp+fsync+rename and exportDatabase() pragmas. Direct raw writes bypass persistence. Read docs/INVARIANTS.md #1; CONTRIBUTING.md scopes data/migration checks.'],
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
