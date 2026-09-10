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
  build has no inline scripts), external images limited to Scryfall + Google Drive (MPC art),
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
ambiguous physical outcomes require reconciliation. Manual DFC backs need explicit refeed.

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

Print history retains private snapshot/art details after artifact expiry. Account deletion
purges its jobs/files, but active physical submissions must first be reconciled. Legacy
database backups retain their historical content. Paper/color/cutter correctness still
requires physical validation; see [docs/PRINT_WORKFLOW.md](docs/PRINT_WORKFLOW.md).

## When you change auth or security

Update this file in the same commit (it is in CLAUDE.md's doc-sync table), and ship the
change with its regression test.
