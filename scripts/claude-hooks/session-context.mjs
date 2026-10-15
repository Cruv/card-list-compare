// Advisory session facts; procedural authority is AGENTS.md -> CONTRIBUTING.md.
// Neutralizes two failure modes without loading history or running verification:
//   1. versioning from stale knowledge — print APP_VERSION + package.json so a new ship
//      bumps from the real current version;
//   2. mistaking a parallel session's WIP for breakage — print the dirty file count.
// Zero-dependency; must never fail the session (all calls are try/caught).
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const sh = (cmd) => {
  try { return execSync(cmd, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
};

let appVersion = "?";
try {
  const m = readFileSync("src/App.jsx", "utf8").match(/const APP_VERSION = '([\d.]+)';/);
  if (m) appVersion = m[1];
} catch { /* ignore */ }

let pkg = "?";
try { pkg = JSON.parse(readFileSync("package.json", "utf8")).version; } catch { /* ignore */ }

const lastRelease = sh("git log --oneline -20 --grep='^v[0-9]' -E").split("\n")[0] || "(none found)";
const head = sh("git log --oneline -1") || "(no commits)";
const dirty = sh("git status --porcelain").split("\n").filter(Boolean);
const dirtyNote = dirty.length
  ? `dirty: ${dirty.length} file(s) — ${dirty.slice(0, 5).map((l) => l.slice(3)).join(", ")}${dirty.length > 5 ? ", …" : ""}`
  : "working tree clean";

const additionalContext =
  `CardListCompare context at session start — APP_VERSION: ${appVersion} | package.json: ${pkg} | ` +
  `last release commit: ${lastRelease} | HEAD: ${head} | ${dirtyNote}. ` +
  `Follow AGENTS.md and the task-relevant CONTRIBUTING.md sections. These facts are advisory; ` +
  `preserve foreign edits and reuse checks whose inputs remain valid.`;

console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
