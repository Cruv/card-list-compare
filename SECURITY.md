# Security

CardListCompare is a self-hosted, multi-user web app (a household of a few players). This
document is the application's security model — the properties future changes must preserve.
Report issues privately to the repository owner.

## Deployment model

- **Intended deployment:** behind a reverse proxy on a private network / trusted LAN, or a
  personal server the owner controls. It is **not** hardened for hostile public internet
  exposure. If you expose it publicly, put it behind HTTPS and your own auth/proxy layer.
- The container runs nginx (port 80) in front of the Node backend (port 3001). nginx serves
  the SPA, sets security headers + CSP, and proxies `/api/*` to the backend and to external
  deck sources (Archidekt, Moxfield, etc.). The DB is a single sql.js file bind-mounted to
  the host (`./data`).
- **`trust proxy` is set to 1** — the backend trusts exactly one proxy hop (nginx). nginx
  overwrites `X-Forwarded-For` with the real client address, so per-IP rate limiting works
  and clients can't spoof their IP. Do not add more proxy hops without revisiting this.

## Required configuration

- **`JWT_SECRET` is mandatory.** In production the server refuses to start if it is unset,
  shorter than 16 chars, or a known placeholder (`change-me-in-production`, etc.), and
  the container refuses to start (Compose management commands still work without it).
  Generate one: `openssl rand -hex 32`. A weak
  secret would let anyone forge admin tokens. Rotating the secret invalidates all sessions.
  (`server/lib/jwtSecret.js`)

## Authentication & sessions

- **Passwords:** bcrypt (`bcryptjs`), never stored or logged in plaintext.
- **Sessions:** stateless HS256 JWT bearer tokens, 7-day expiry, signed with `JWT_SECRET`.
  Sent as `Authorization: Bearer …`; the client keeps the token in `localStorage`.
- **Invalidation:** `requireAuth` re-checks the user each request (short TTL cache) for
  suspension and compares the token's `iat` against `password_changed_at`, so a password
  change or suspend invalidates existing sessions. Admin status is always re-read from the
  DB, never trusted from the token alone. (`server/middleware/auth.js`)
- **Brute force:** login locks an account for 15 min after repeated failures; `authLimiter`
  caps auth endpoints per IP.
- **Email/reset tokens:** stored as **SHA-256 hashes** — the raw token is emailed and lookups
  hash the incoming value, so a DB read (or the admin backup) can't replay a live token.
  Reset tokens are single-use and expire in 1h; verification tokens in 24h.
  (`server/lib/tokens.js`, `server/routes/auth.js`)

## Rate limiting

Per-IP limiters (`server/middleware/rateLimit.js`): a global `/api` limiter, a strict auth
limiter (login/register/forgot/reset), and per-integration limiters (Archidekt, MPC, share
creation). They depend on the `X-Forwarded-For` handling above to key on the real client IP.
Email sends are additionally capped at 10/user/hour.
The nginx/Vite import proxies to external deck sites bypass Express and its limiters;
the global limit applies to requests actually handled by the Node backend.

## Browser hardening

- **CSP** on document responses (nginx): `default-src 'self'`, `script-src 'self'` (the Vite
  build has no inline scripts), external images limited to Scryfall + Google Drive (MPC art).
  Image-only `blob:` URLs allow private artwork fetched with the signed-in user’s credentials;
  `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`. This is the main mitigation
  for the token-in-localStorage exposure. Adding a new external resource host means updating
  the CSP in `nginx.conf` (two places: server block + `= /index.html`).
- Other headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy`.
- Stored user content (deck names, nicknames, card names) is rendered through React (escaped);
  email templates HTML-escape interpolated values.

## Share links

Comparison and tracked-deck share links are unauthenticated, guessable only by their random
id. Anyone with the link can read that comparison/deck (read-only). Tracked-deck links can
be revoked by their owner; comparison links currently have no owner-side revocation.
Neither link type has configurable expiry (see ROADMAP).

## Admin surface

The first registered user (`id = 1`) is auto-promoted on the next backend startup; restart
the backend after the first registration. Admin routes are gated by
`requireAdmin` (re-checks `is_admin` from the DB). The admin backup endpoint exports the full
DB — protect admin credentials accordingly; the token hashing above limits what a leaked
backup exposes.

## Image downloads and household printing

Image ZIP status and download routes require the owning user and matching deck ID.
Completed ZIPs expire after 24 hours; download and cleanup checks normalize stored UTC
timestamps. Scryfall ZIPs are published only after all requested copies/faces are available;
non-image and structurally invalid responses are rejected. Legacy ZIP jobs without these
completeness checks require regeneration. These checks do not attest that the selected art
or household print recipe is correct. Local dependency directories and `.env` files are
excluded from Docker builds.

Native collection routes have been removed. Legacy collection data remains in the database
and its backups for a future deliberate transfer to ManaSync; no new cross-app access or
inventory integration is introduced by that removal.

PDF plans, jobs, manifests and downloads require the owning user. Queue submission also
requires administrator status or an explicit `PRINT_ALLOWED_USER_IDS` grant. A separate
`PRINT_STATION_TOKEN` authenticates the station protocol; it cannot create jobs, change
decks or act as a JWT. Use a separate random value of at least 32 characters, protect the
Mac token file, and rotate it on both ends together. Keep the station API behind HTTPS or
a trusted local network; do not place the token in URLs or source control.

Print manifests freeze input text, artwork and file hashes. Source images are size-limited
and decoded before generation. Upstream code is fetched from the fixed Silhouette repository,
installed as the unprivileged service user, and activated only after validation. Generation
uses argument arrays with closed stdin, bounded subprocesses and no user-provided commands.
The native station chooses its printer/options locally, verifies artifacts and records
submission intent before spooling. Replayed requests do not authorize repeated submissions;
ambiguous physical outcomes require reconciliation. Manual DFC backs need explicit refeed
for the exact pending back pass, after that artifact's fronts have completed. Stale or
wrong-artifact confirmations cannot release a later batch.
New DFC packets preserve an immutable front/back pair for one physical sheet. The printed
job/packet label, download metadata and reload prompt identify that same artifact; backs
still require completed fronts and an explicit operator reload acknowledgement. Existing
multi-sheet PDFs are retained with their original pairing and require matching the old PDF.

Flip alerts never authorize printing. The Mac stores an attempt for each job/artifact/channel
before requesting a local notification or sending an optional Discord webhook. Retries and
restarts cannot produce repeated pings; delivery failures leave the job waiting. Notification
text uses fixed AppleScript with arguments, and alert errors cannot change printer state.
Discord credentials stay in the private local config, outside station telemetry and logs.
Only canonical HTTPS Discord webhook URLs are accepted, redirects are refused, and
allowed mentions contain only the explicitly configured Discord user ID. Enabling the
webhook shares the deck name, job/packet identity and CLC station link with its channel;
no PDF, card artwork, station credential or automatic resume action is sent.

The [Mac companion](companion/mac/README.md) requires a private user-owned token/config
and state directory. Downloads stay on the configured server origin and reject redirects.
It uses fixed native command paths and argument arrays, verifies PDF hashes before sending,
and preserves local submission receipts across restarts. Keep the state directory and CUPS
job history for recovery. Its example leaves physical-proof flags disabled; tests and the
local dry-run command never submit to a real printer.

Station management is a separate user-authenticated surface: administrators or explicitly
authorized household users can read live status/events and request pause, unpause or a
specific manual DFC refeed. Update checks, version changes and rollback require administrator
status. The browser never receives the station token. The Mac polls outbound for a fixed
allowlist of controls; commands cannot contain executable paths, printer options, arbitrary
URLs or scripts. Local proof flags remain local. Refeed commands bind the job and artifact,
and commands expire and carry durable idempotency receipts. Software version changes cannot
proceed while the local ledger contains an active, uncertain or awaiting-refeed batch.
Telemetry is bounded and credential-redacted; only authorized household operators see it.

The managed installer bundles a pinned standalone Python runtime and preserves its upstream
license/source metadata. Version updates use only stable GitHub assets from the fixed
`Cruv/card-list-compare` publisher, with no station credential attached to those downloads.
They validate GitHub asset SHA-256 values, a matching release manifest, bounded archive
contents and contained links, per-file checksums and a no-print startup self-check. The
publisher remains trusted to distribute executable updates; checksum validation is not
Developer-ID signing or notarization. Packages do not remove macOS quarantine. CLC users
cannot provide an update URL or replace the printer recipe. Version rollback preserves
current credentials and submission records rather than restoring an old state backup.

Print history retains private snapshot/art details after artifact expiry. Account deletion
purges its jobs/files, but active physical submissions must first be reconciled. Legacy
database backups retain their historical content. Paper/color/cutter correctness still
requires physical validation; see [docs/PRINT_WORKFLOW.md](docs/PRINT_WORKFLOW.md).

## When you change auth or security

Update this file in the same commit (it is in CLAUDE.md's doc-sync table), and ship the
change with its regression test.

## ManaSync bridge and integration access

- CLC integration tokens are revocable, per user, stored as SHA-256 hashes, and scoped to
  `decks:read` and optionally `decks:propose` or `decks:create`. They cannot access normal account settings,
  administrator endpoints, or the outbound ManaSync bridge. Existing login-token deck reads
  remain compatible. Token use rechecks the owning account and revocation on every request.
- New-deck creation is a separate, unchecked grant in account settings. Existing tokens do
  not gain it on upgrade. The request pins the instance and account, and commits the manual
  deck, digital snapshot, and immutable receipt in one transaction. The owner and operation ID
  identify replay across token rotation; changed payloads conflict. A deleted deck cannot be
  recreated by replaying its receipt. Creation does not set paper state or change holdings.
- Native source tracking uses the same explicit `decks:create` grant and account pins.
  It saves an immutable intent before fetching a canonical provider URL, reuses an existing
  owner-scoped source identity, and reconciles observations without replacing paper history
  or divergent local edits. Provider requests use fixed HTTPS endpoints, bounded reads, and
  no redirects; inaccessible or unsupported lists retain the last saved state.
- Outbound ManaSync credentials are kept only server-side, encrypted with AES-256-GCM using
  a separate CLC key. `MANASYNC_BRIDGE_KEY` accepts a base64 encoded 32-byte key; otherwise CLC
  creates `.manasync-bridge-key` with mode 0600 beside `DB_PATH`. Back up this file separately
  with the database. Losing it prevents replaying saved credentials. Never share signing
  secrets, database files, or encryption keys between CLC and ManaSync.
- Each user chooses a server-reachable HTTP(S) ManaSync URL. Custom domains, ports, LAN
  addresses, and reverse-proxy base paths do not require an origin allowlist. Scheme-less
  addresses default to HTTPS. URL credentials, query strings, fragments, and redirects are
  rejected; credentials are sent only to the configured endpoint and never forwarded through
  a redirect. The integration context must verify the account and dedicated scopes before
  the connection is saved.
- Connection validation uses ManaSync's explicit authenticated account and actor ID, and
  requires a dedicated token with exactly `inventory:read` and `proxies:write`. Account names,
  imported binder labels, and deck ownership names do not map accounts.
- New print confirmations include the account/actor/backend displayed to the user. A changed
  connection returns a conflict before persistence or delivery. Each saved reporting operation
  then freezes its operation UUID, command, encrypted token, backend, and expected account.
  `X-ManaSync-User` protects every mapped request. Replacing credentials pauses older reports;
  CLC reads their owner-scoped historical receipt and current holdings without replaying old
  acquisitions through the replacement actor. Only valid server receipts mark delivery complete.
- Confirmed increments and correction commands are scoped to the CLC user. Proxy adjustments
  and moves use reviewed lot revisions; conflicts require another read and explicit review.
  Server-side token scopes also prevent changing real inventory. Disconnecting pauses delivery
  while retaining encrypted credentials on outstanding operations for reconciliation.
  Suspension also pauses all ManaSync requests and retry workers without discarding queued
  operations. Every remote request checks current account status, including between artwork
  uploads; reinstatement resumes the same saved IDs, credentials, and payloads.
- Every database export, including admin statistics and downloads, restores SQLite foreign-key
  enforcement; exports during a transaction are rejected. Deleting an account cascades its
  connections, print operations, decks, proposals, and tokens, preventing reused user IDs from
  inheriting saved credentials.
- Archidekt reconciliation decisions require an authenticated owner session. Integration
  read/propose/create tokens cannot accept source changes. Each decision pins the candidate
  revision and current digital snapshot/hash, and stores an immutable per-owner operation
  receipt. Replays recover the same result; changed requests or stale reviews conflict.
  Source text remains separate from current snapshots until an authorized decision or a
  source-only update can apply it. Source reviews never modify remote Archidekt decks.

- Native-batch artwork reporting uses owner-scoped manifest and private image routes. Source
  paths, symlinks, image structure, sizes, and hashes are checked before files are retained.
  Confirmation items freeze card identity plus front/back hashes. Artwork upload receipts
  must match the original account-owned paths before the immutable pending plan is sent.
  Artifact creation, spooler completion, staging, and face uploads do not acquire holdings.
- Native pending plans are pinned to the selected account and backend. Confirm and dismiss
  actions use one immutable operation ID/payload and the reviewed ManaSync pending revision.
  ManaSync commits quantity decisions and proxy acquisition atomically; CLC synchronizes
  owner-scoped results from either app. Token rotation permits new decisions in the same
  account while already saved decisions keep their original actor for exact replay.
