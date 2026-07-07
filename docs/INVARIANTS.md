# Invariants

Rules that keep CardListCompare correct but that the code cannot express on its
own. Each entry says what the rule is, why it exists, where it lives (by symbol
name — line numbers rot), and what breaks when it's violated.

**Normative hierarchy:** anything machine-checkable is enforced by
`src/lib/invariants.test.js` — those entries here are one-line pointers. This
document is the normative home only for knowledge that can't be a test. The
"anchor integrity" test asserts every symbol cited here still exists; if you
rename one, update this doc and the test's anchor table in the same change.

---

## 1. sql.js persistence — the most dangerous thing in this repo

The database is **sql.js** (SQLite compiled to WASM, held fully in memory) —
**not** better-sqlite3, despite what older notes said.

- The `run()` helper in `server/db.js` calls `persist()` after **every** write
  statement. `persist()` (`export function persist`) serializes the **entire
  database** with `db.export()` and `writeFileSync`s it to `DB_PATH`.
- There is **no temp-file + rename**: a crash mid-write can corrupt the DB file.
  Copying the file while the server is running risks catching a partial write —
  back up by stopping the container or copy-then-verify.
- Writes made directly via `getDb().run(...)` **bypass persistence entirely**
  and are silently lost on restart unless some later helper call persists them.
  Always write through the `run()` helper (`export function run`).
- There are no cross-statement transactions. A loop of N `run()` calls does N
  full-file rewrites — that's a known cost, accepted for simplicity.

**Do not "optimize" `persist()`** (debounce, batch, async) without adding an
atomic write (write temp, fsync, rename) first. A perf pass here is one bug away
from losing user data.

## 2. Card-line regex is single-sourced — never fork it

`CARD_LINE_PATTERN` in `src/lib/constants.js` (= `LINE_PATTERNS` first entry) is
the only card-line regex. `server/lib/enrichDeckText.js` imports it and indexes
groups directly (`cn = m[4] || m[5]`, `foil = m[6]`). Two past forks both caused
real bugs (collection import corruption, fixed v2.40.1; enrichment drift,
unified v2.40.2). Enforced by the single-source and behavior-pin tests in
`src/lib/invariants.test.js`; format spec in [DECK_TEXT_FORMAT.md](DECK_TEXT_FORMAT.md).

## 3. Parser contract: `displayName`, flat commanders, composite keys

Entries expose `displayName` (never `.name`); `parsed.commanders` is a flat
string array; map keys come from `cardKey` (bare lowercase name, or
`name|collectorNumber`). Enforced by the "parser entry contract" tests. Past
production crashes (v2.17.0, v2.18.1) came from server routes assuming
`entry.name` or destructuring commanders as Map entries.

## 4. Differ pipeline order: DFC normalization first

In `src/lib/differ.js` `diffSection()`, `normalizeDFCKeys()` must run before
`buildNameIndex()` and the composite-key remapping / `collapseCompositeKeys()`
passes.

- **Why:** the name index is built from map keys; DFC renames
  (`"sheoldred // the true scriptures"` → `"sheoldred"`) change those keys. Index
  first and the remap operates on stale keys.
- **Breaks when:** double-faced cards show as remove+add pairs instead of
  matching — while simple-deck tests keep passing. A source-order tripwire test
  guards this.

## 5. Scryfall dual keying and DFC front-face aliasing (client)

`collectCardIdentifiers` in `src/lib/scryfall.js` emits **both** a composite-key
identifier (`{set, collector_number}` → exact printing artwork) and a bare-name
identifier (`{name}` → type/mana data) per card. Results are stored under both
keys, and DFC names are normalized to their front face for the query, with
results aliased back to every original `//` name that mapped there.

- **Why:** UI lookups try `name|collector` first, then bare name; both must
  resolve. Scryfall's API doesn't accept full `A // B` names on all endpoints.
- **Breaks when:** card tooltips show generic artwork for specific printings, or
  DFC cards lose images/types entirely.
- Client `src/lib/scryfall.js` and `server/lib/scryfall.js` are **intentionally
  different** (browser cache + sessionStorage vs server batch fetch). Keep them
  conceptually aligned (e.g. if name normalization changes) but do not merge or
  literally sync them.

## 6. Enrichment carry-forward (server)

`server/lib/enrichDeckText.js` rebuilds snapshot text line-by-line:
keep lines that already have full metadata → else apply the previous snapshot's
metadata via `buildMetadataLookup` (which stores an **ordered array of printings
per name**) → else Scryfall → else pass through unchanged (enrichment is
non-fatal by design).

- Multi-printing expansion distributes a new quantity across the previous
  printings in stored order, remainder to the first printing. It assumes
  `buildMetadataLookup` preserves the previous snapshot's line order — don't
  sort or dedupe it.
- Foil merges as `lineIsFoil || printing.isFoil` in the single-printing case;
  multi-printing expansion uses each stored printing's own foil status (an
  incoming line's `*F*` is dropped there — known quirk, not an accident to fix
  in passing).

## 7. `archidektToText()` is mirrored client/server

`archidektToText` in `src/lib/fetcher.js` and in `server/lib/deckToText.js` must
produce identical `text` and `commanders` (client additionally returns `stats`).
Enforced by the mirror test in `src/lib/invariants.test.js`.

## 8. Dockerfile ships `src/lib` to the server

The production image copies a hardcoded list of shared lib files
(`COPY src/lib/... ` in `Dockerfile`). Server code importing a `src/lib` file not
on that list works in dev and crashes the container at startup. Enforced —
including dynamic imports and transitive dependencies — by the COPY-closure test.

## 9. Auth/session rules

In `server/middleware/auth.js`:

- Session invalidation is stateless: `requireAuth` rejects JWTs whose `iat`
  predates the user's `password_changed_at`. That timestamp is stored without a
  timezone and **must be parsed with a `+ 'Z'` UTC suffix** — dropping the `Z`
  shifts the comparison by the server's UTC offset and either kills every
  session or none.
- Auth state (suspension, password-changed) is cached for ~5 seconds to avoid a
  DB hit per request. After changing a user's password or suspension, call
  `invalidateAuthCache(userId)` — or `invalidateAllAuthCache()` after bulk
  mutations (e.g. emergency suspend-all) — or the change takes effect only
  after the TTL.
- Suspension is checked on **every** authenticated request, not just at login.

## 10. DB migrations pattern

In `server/db.js`: new tables use `CREATE TABLE IF NOT EXISTS`; new columns use
`ALTER TABLE ... ADD COLUMN` wrapped in try/catch (sql.js has no
`IF NOT EXISTS` for columns — the catch **is** the idempotency mechanism);
indexes are created separately (never add UNIQUE via ALTER); data backfills run
after the column exists. Follow the existing examples verbatim.

## 11. Server middleware order

In `server/index.js`, order is load-bearing:
`trust proxy` → `compression` → `helmet` (CSP) → `express.json` (body limit) →
`/api` content-type + trim guards → `/api` rate limiter → routes.

- `trust proxy` must precede the rate limiter or every client behind nginx
  shares one IP bucket.
- helmet must precede routes or responses ship without CSP.
- `/api/health` is registered after the limiter — it is rate-limited too.
- `decks.js` and `snapshots.js` are **both mounted at `/api/decks`** — route
  paths must not collide across the two files; check both before adding a route.
- Startup order: `initDb()` → `initDownloadQueue()` → `listen` →
  `startNotificationScheduler()`.

## 12. UI stacking order (z-index ladder)

`CardOverlay` (fullscreen card image) 1000 > `WhatsNewModal` 300 > main overlays
(Timeline/Comparison/Mpc/PriceHistory/Recommendations) and Toast 200 >
`ConfirmModal` 150 > card tooltip / `NameModal` 100. New overlays slot in at 200;
only the tap-to-view card image may sit above everything (exception: the
accessibility skip-link `.sr-only-focusable:focus` sits at 9999 by design).

Also: `DeckLibrary.jsx` **imports `UserSettings.css`** and reuses its
`.user-settings-*` / `.settings-page` classes — restyling Settings restyles the
Deck Library too. (The JSX component copies are separate; the CSS is shared.)

## 13. External APIs break without warning

Both recent emergency releases were third-party API renames (MPC Autofill:
`v2.39.6`/`v2.39.7`). History of breakage: **MPC Autofill** (field renames),
**Archidekt** (format changes), **Moxfield** (blocks requests → user-facing
"export and paste instead" fallbacks). Integration points: `src/lib/fetcher.js`,
`src/lib/scryfall.js`, `server/lib/scryfall.js`, `server/routes/mpcautofill.js`,
and the dev-proxy list in `vite.config.js`. Breakage presents as import failures
or missing card data with our code unchanged — suspect the API first, and fix by
reading their current response shape, not by guessing.

## 14. Release bookkeeping

`APP_VERSION` and `WHATS_NEW` in `src/App.jsx` drive the user-facing what's-new
toast; `package.json` version must equal `APP_VERSION` (enforced by test). The
protocol lives in [CLAUDE.md](../CLAUDE.md); the `/release` skill executes it.
WHATS_NEW is **replaced** each release (git log is the historical record).

---

## Coupling table — "if you touch X, also update Y"

| You touched | Also update | Enforced by |
| --- | --- | --- |
| `CARD_LINE_PATTERN` (constants.js) | behavior pins in invariants.test.js + [DECK_TEXT_FORMAT.md](DECK_TEXT_FORMAT.md); check group indexing in enrichDeckText.js | pattern tests |
| `archidektToText` (fetcher.js) | `archidektToText` (deckToText.js) | mirror test |
| Parser entry shape / `cardKey` | differ, formatter, all server routes, [DECK_TEXT_FORMAT.md](DECK_TEXT_FORMAT.md) | contract tests |
| New `src/lib` import in `server/**` | Dockerfile `COPY src/lib/...` line | COPY-closure test |
| Password/suspension writes | call `invalidateAuthCache(userId)` (bulk ops: `invalidateAllAuthCache()`) | — (review) |
| New external API host | helmet CSP (`server/index.js`) + vite proxy (`vite.config.js`); nginx only if a new server-side path is proxied | — (review) |
| `APP_VERSION` | `WHATS_NEW` + `package.json` version | version tests |
| User-visible feature change | Guide section in `src/components/GuidePage.jsx` (`SECTIONS`) | — (release protocol) |
| Anything in this doc's symbols | anchor table in `src/lib/invariants.test.js` | anchor test |

---

## Appendix: durable design rationale

Why things are the way they are — context for changes, not rules.

1. **Metadata lives in deck text, not schema** — snapshots are self-contained
   strings; no migrations needed for new metadata; export/import round-trips are
   trivially lossless.
2. **Composite map keys** (`name|collector`) let one card name hold multiple
   printings as distinct entries (nine Nazgul artworks) while bare names remain
   the fallback identity.
3. **Enrichment is graceful, never fatal** — if Scryfall is down or a card is
   unknown, the original line passes through. Deck data is never held hostage by
   a third-party API.
4. **Carry-forward before Scryfall** — refreshing a deck reuses the previous
   snapshot's printings, preserving user artwork choices and avoiding API churn.
5. **Archidekt text export mimics Archidekt's native format**
   (`1x Name (set) cn *F* [Commander{top}]`) because Archidekt only supports
   text paste — there is no CSV import.
6. **Session invalidation via `password_changed_at`,** not a token blacklist —
   stateless, survives restarts, one indexed column.
7. **Account lockout state is in the DB,** not the rate limiter — survives
   restarts, works across instances.
8. **Denormalized audit log** stores admin/target usernames at write time so
   history stays readable after account deletion.
9. **Admin sort columns are whitelisted** via an explicit map — the only
   accepted defense for ORDER BY injection.
10. **Hash-based routing** (`useHashRoute`: `#admin`, `#settings`, `#guide`,
    `#library`, `#library/{deckId}`, `#share/{id}`, `#deck/{id}`) avoids a
    router dependency and server-side route handling entirely.
11. **Snapshot pruning is synchronous** after every INSERT (no cron) and never
    deletes locked snapshots; lock count is capped to prevent abuse.
12. **Registration is a three-mode enum** (`open`/`invite`/`closed`) in
    `server_settings`, with legacy boolean values auto-migrated.
13. **DeckLibrary and UserSettings are separate pages** with intentionally
    duplicated JSX components (but shared CSS) — independent evolution beats
    DRY here.
14. **`package.json` version was stale (2.16.1) for 23 minor releases**; since
    v2.40.0 it is synced with `APP_VERSION` and test-enforced.
15. **No component/route test culture** — Vitest runs in node env (no jsdom).
    Core logic (parser/differ/formatter/enrichment) is tested; UI and routes
    are verified manually via the runbook in [CLAUDE.md](../CLAUDE.md).
