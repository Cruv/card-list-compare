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
  `docker compose` fails fast without it. Generate one: `openssl rand -hex 32`. A weak
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
id. Anyone with the link can read that comparison/deck (read-only). They currently have no
expiry or owner-side revocation — treat a shared link as public until that lands (see ROADMAP).

## Admin surface

The first registered user (`id = 1`) is auto-promoted to admin. Admin routes are gated by
`requireAdmin` (re-checks `is_admin` from the DB). The admin backup endpoint exports the full
DB — protect admin credentials accordingly; the token hashing above limits what a leaked
backup exposes.

## When you change auth or security

Update this file in the same commit (it is in CLAUDE.md's doc-sync table), and ship the
change with its regression test.
