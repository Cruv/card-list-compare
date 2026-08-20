# CardListCompare — decision log

> The load-bearing "why"s. Each entry: what was decided, why, what it costs, and where it
> lives in code. These are **standing decisions** — revisit deliberately (talk to the
> owner), don't erode them incidentally. One flat file on purpose: searchable in one place.
> Mirrors the sibling app WarSlate's `docs/decisions.md` format so both repos read alike.

## D1 — sql.js for persistence (not better-sqlite3)

**Decision.** The database is **sql.js** (SQLite compiled to WASM, held fully in memory),
persisted to a single file. Not better-sqlite3, not a native module.
**Why.** Zero native build step — the image is a plain `node:22-alpine` with no compiler
toolchain, and the DB is one portable file that bind-mounts to the host for trivial backup.
**Cost.** Every write serializes the **entire** database to disk (`persist()` after each
`run()`), so there are no partial writes and no cross-statement transactions. The whole-file
rewrite is the accepted cost; it is made crash-safe by an atomic temp+fsync+rename with
`.bak` recovery (v2.40.3). See INVARIANTS.md #1 — the most dangerous code in the repo.
**Where.** `server/db.js` (`persist`, `loadDatabase`, `backupDb`, `run`); pinned by
`server/db.persist.test.js`.

## D2 — Deck text is the product's data contract

**Decision.** Decks are stored and exchanged as **plain text with embedded printing
metadata** (`4 Lightning Bolt (m10) [146] *F*`), not a structured schema. The card-line
grammar is single-sourced in `src/lib/constants.js` (`CARD_LINE_PATTERN`).
**Why.** It round-trips through every external source (Archidekt/Moxfield/paste), is
human-editable, diffable, and needs no migration when a field is added.
**Cost.** All correctness lives in one regex and the parser/differ around it; two past forks
of the regex corrupted data. Format spec: `docs/DECK_TEXT_FORMAT.md`; enforced by
`src/lib/invariants.test.js`.

## D3 — Express + a small dependency set (a deliberate divergence from WarSlate)

**Decision.** The server uses **Express 5** with a curated dependency set (helmet,
express-rate-limit, jsonwebtoken, bcryptjs, nodemailer, archiver, compression, sql.js).
This diverges from WarSlate's zero-dependency-server rule (WarSlate D1).
**Why.** This app started from the Express ecosystem and sql.js is itself load-bearing;
rewriting to Node built-ins would be a large, low-reward migration. The trade is accepted.
**Cost.** Supply-chain surface. Mitigations that this decision REQUIRES: `npm audit` is part
of the release check, dependency bumps are lockfile-only, and a **new server dependency needs
explicit justification** (prefer a Node built-in — e.g. `node:crypto` did the token hashing
in D7, `node:zlib`/compression, `archiver` only where a real zip is needed).
**Where.** `server/package.json`. Revisit only if supply-chain cost outweighs convenience.

## D4 — Version authority is APP_VERSION in code, not git tags

**Decision.** The single source of truth for the app version is `APP_VERSION` in
`src/App.jsx`, three-way-synced with `package.json` and the player-facing `WHATS_NEW` toast.
Stale `v1.x` git tags are historical and not authoritative.
**Why.** The version drives an in-app "What's new" toast keyed to `APP_VERSION`; a code
constant is what the UI reads. The sync is test-enforced, so it can't silently drift.
**Cost.** Unlike WarSlate (where the git tag is authority), tags here don't gate anything.
Lightweight release tags MAY be resumed to get pinnable GHCR images (see ROADMAP), but the
authority stays in code. **Where.** `src/App.jsx`; enforced by `invariants.test.js`.

## D5 — Publish the image on every push to main (:latest, :sha, :branch)

**Decision.** `.github/workflows/docker-publish.yml` builds and publishes to GHCR on every
push to `main`, gated on `npm test`. `:latest` tracks the default branch.
**Why.** Simple, hosted-runner CI; the household deploy pulls deliberately (no auto-pull),
so republishing `:latest` on an internal-only commit is harmless here.
**Cost.** `:latest` means "last push that passed tests," not "last deliberate release." If
that ever matters, gate `:latest`/semver tags on a `v*` tag or a release-commit condition
(one workflow line) — recorded here so the choice is explicit, not accidental.
**Where.** `.github/workflows/docker-publish.yml`.

## D6 — Lint blocks CI (backlog cleared 2026-08)

**Decision.** `npm run lint` must exit clean; CI fails on any ESLint **error**. Warnings are
allowed and visible. The ~40-error backlog that made this advisory is gone.
**Why.** A gate only works if green means green. With zero errors, any new one is a real
signal instead of noise.
**Cost.** Two rules are deliberately tuned rather than obeyed literally, both documented in
`eslint.config.js`: `react-refresh/only-export-components` allows the provider+hook and
component+helper pairs this codebase uses on purpose, and `react-hooks/set-state-in-effect`
is a **warning** because every current hit is the standard fetch-on-mount pattern
(`useEffect(() => refresh(), [refresh])`) — restructuring data fetching across the admin
panels is a project, not lint cleanup.
**Where.** `.github/workflows/docker-publish.yml`, `eslint.config.js`.

## D7 — Auth: JWT bearer tokens, bcrypt passwords, hashed email/reset tokens

**Decision.** Sessions are stateless HS256 JWTs (7-day expiry) signed with a mandatory
`JWT_SECRET`; passwords are bcrypt; email-verification and password-reset tokens are stored
as **SHA-256 hashes** (raw token emailed).
**Why.** The server refuses to start on a weak/missing secret (v2.40.3), so a defaulted
secret can't sign forgeable tokens. Hashing the email tokens means a DB read can't replay
them. Session invalidation uses `password_changed_at` vs the token `iat`.
**Cost.** Rotating `JWT_SECRET` logs everyone out (intended on a leak). Token-in-localStorage
is mitigated by the CSP (v2.40.x infra). Full model: `SECURITY.md`.
**Where.** `server/lib/jwtSecret.js`, `server/lib/tokens.js`, `server/middleware/auth.js`,
`server/routes/auth.js`.

## D8 — Collection matching is by card name, printing-agnostic

**Decision.** The "do I own this?" match (Collection → deck views) keys on the **card name**,
summed across printings and foils, front-face-normalized for DFCs and accent-insensitive.
**Why.** Owning a card is about the card, not the exact printing; a user's collection and a
deck rarely agree on printing, and DFC/accented spellings differ across sources.
**Cost.** Can't answer "do I own THIS printing" — only "do I own this card." If per-printing
ownership is ever needed, extend the index key, don't replace it.
**Where.** `src/lib/collectionMatch.js`; pinned by `collectionMatch.test.js`.
