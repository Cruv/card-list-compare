# Card List Compare

Compare two MTG deck lists side-by-side and generate detailed changelogs showing cards added, removed, quantity changes, and printing swaps. Import from supported deck sites or paste a text list. Track Archidekt decks with snapshot history, paper-deck baselines, analytics, and proxy image exports.

CLC generates Silhouette v6 PDFs from full deck snapshots or version differences, with separate ordinary and double-faced batches. Authorized household users can queue finished PDFs through the [native Mac companion](companion/mac/README.md), which uses the installed Epson driver and verified local settings. Collection and purchase management belong to the planned ManaSync companion; CLC has no native collection feature. See [Home printing workflow](docs/PRINT_WORKFLOW.md).

## Supported Architectures

The image supports `linux/amd64`. Published to GitHub Container Registry.

| Architecture | Available |
|:---:|:---:|
| x86-64 | &#10003; |

## Application Setup

Access the web UI at `http://<your-ip>:8080`.

On a fresh installation, register the first account, restart the backend/container once, then reload the page or sign in again to receive admin access. The startup migration promotes user ID 1. Registration can be set to open, invite-only, or closed from the admin panel. In invite mode, existing users with invite permission can generate invite codes for new users.

To enable password reset, email verification, and deck/price email alerts, configure the SMTP environment variables below. Use the app's reachable public URL for `APP_URL` so emailed links open correctly on other devices.

## Usage

### docker-compose (recommended)

Create a `docker-compose.yml` anywhere on your host. Generate a signing secret and save its output as `JWT_SECRET=<generated value>` in a `.env` file beside it:

```bash
openssl rand -hex 32
```

Keep the `.env` file private. Production startup rejects missing, short, or known placeholder secrets.

```yaml
---
services:
  card-list-compare:
    image: ghcr.io/cruv/card-list-compare:latest
    container_name: card-list-compare
    environment:
      - PUID=1000
      - PGID=1000
      - JWT_SECRET=${JWT_SECRET:-}
      - DB_PATH=/app/data/cardlistcompare.db
      - TZ=America/New_York #optional
      # Optional email settings:
      # - SMTP_HOST=smtp.example.com
      # - SMTP_PORT=587
      # - SMTP_USER=you@example.com
      # - SMTP_PASS=your-app-password
      # - SMTP_FROM=noreply@example.com
      # - APP_URL=https://clc.example.com
    volumes:
      - ./data:/app/data
    ports:
      - 8080:80
    restart: unless-stopped
    stop_grace_period: 30s
```

Then start with:

```bash
docker compose up -d
```

The image includes a background Silhouette Card Maker runtime. On startup it checks the
latest upstream main and keeps a validated installation, dependencies and wheel cache in
`./data/silhouette-card-maker/`. If an update fails, it retains its last compatible version.
Without a usable cache on an offline first boot, the web app remains available and PDF
generation stays unavailable. Set `PRINT_ENABLED=false` to disable runtime preparation.
Allow at least 2 GiB of memory for 600 PPI sheet generation. Use the Printing tab in a tracked deck; see [operations](docs/OPERATIONS.md#silhouette-runtime).

### docker cli

Export `JWT_SECRET` in your shell with a strong, stable value before running this command. Docker CLI does not automatically read Compose's `.env` file; keep the same secret when recreating the container.

```bash
docker run -d \
  --name=card-list-compare \
  -e PUID=1000 \
  -e PGID=1000 \
  -e JWT_SECRET \
  -e DB_PATH=/app/data/cardlistcompare.db \
  -e TZ=America/New_York \
  -v ./data:/app/data \
  -p 8080:80 \
  --restart unless-stopped \
  ghcr.io/cruv/card-list-compare:latest
```

## Parameters

Container configuration is done through environment variables and volume mappings passed at runtime.

### Ports

| Parameter | Function |
|:---:|---|
| `80` | Web UI and API |

### Environment Variables

| Env | Required | Default | Function |
|:---:|:---:|:---:|---|
| `PUID` | No | `1000` | User ID for file permissions |
| `PGID` | No | `1000` | Group ID for file permissions |
| `JWT_SECRET` | **Yes, in production** | None | Strong, stable secret for signing auth tokens (at least 16 characters; use 32 random bytes). Generate with `openssl rand -hex 32`. Weak values are rejected in every environment. |
| `DB_PATH` | No | `/app/data/cardlistcompare.db` | Path to SQLite database file |
| `PRINT_ENABLED` | No | `true` | Prepare/update the cached PDF runtime at startup |
| `PRINT_STATION_TOKEN` | For physical printing | None | Separate random station credential, at least 32 characters; blank disables queue requests |
| `PRINT_ALLOWED_USER_IDS` | No | Administrators only | Comma-separated user IDs allowed to queue physical printing |
| `PRINT_STORAGE_MAX_MB` | No | `10240` | Retained print-job storage quota in MiB |
| `SMTP_HOST` | No | &mdash; | SMTP server for password reset, verification, and deck/price alerts |
| `SMTP_PORT` | No | `587` | SMTP port |
| `SMTP_USER` | No | &mdash; | SMTP username |
| `SMTP_PASS` | No | &mdash; | SMTP password or app-specific password |
| `SMTP_FROM` | No | `noreply@cardlistcompare.local` | From address for outgoing emails; configure a valid sender for your mail service |
| `TZ` | No | `UTC` | Container timezone ([tz database name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)), e.g. `America/New_York` |
| `APP_URL` | No | `http://localhost:8080` | Public URL of the app (used in email links) |
| `IMAGE_CACHE_DIR` | No | Beside `DB_PATH`, under `image-cache/` | Persistent Scryfall image cache directory |
| `DOWNLOADS_DIR` | No | Beside `DB_PATH`, under `downloads/` | Temporary generated image ZIP directory |

> Email requires `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASS`. Without them, deck comparison, tracking, image downloads, and Discord webhook notifications still work, but password reset, verification, and email alerts are unavailable. Deck/price email alerts also require a verified address and enabled deck notifications.

### Volume Mappings

| Volume | Function |
|:---:|---|
| `/app/data` | Database, recovery backup, image cache, and generated ZIPs. Bind mount to persist across container rebuilds. |

## User / Group Identifiers

When using volumes, permissions issues can occur between the host OS and the container. We avoid this issue by allowing you to specify the user `PUID` and group `PGID`.

Ensure any volume directories on the host are owned by the same user you specify:

```bash
mkdir -p ./data && chown 1000:1000 ./data
```

## Updating

```bash
# Pull the latest image
docker compose pull

# Recreate the container
docker compose up -d

# (Optional) Remove old images
docker image prune
```

## Backing Up

The SQLite database is stored in your mounted `./data/` directory. Back it up with:

```bash
mkdir -p ./backups
cp ./data/cardlistcompare.db ./backups/cardlistcompare-$(date +%Y%m%d).db
```

Admins can also download a database backup directly from the admin dashboard.

The server rewrites the database atomically (temporary file, fsync, rename), so copying the live database is safe on the supported local filesystem. A `.bak` recovery copy is refreshed at startup and graceful shutdown. Keep independent backups; `.bak` is not a versioned backup history. For restoration and integrity checks, see [Operations](docs/OPERATIONS.md).

## Features

### Deck Comparison

- **Side-by-side diff** &mdash; paste, upload, or import two deck lists and instantly see cards added, removed, quantity changes, and printing swaps
- **Multi-format parser** &mdash; Arena/MTGO exports, CSV, plain text, `SB:` prefix notation, with set codes `(M10)`, collector numbers `[227]`, and foil `*F*` markers
- **URL import** &mdash; pull decks from Archidekt, Moxfield, DeckCheck, TappedOut, Deckstats, MTGGoldfish, and TCGPlayer links with metadata coverage feedback (subject to source availability and access restrictions)
- **Card type grouping** &mdash; changelogs grouped by Creature, Instant, Sorcery, Artifact, Enchantment, Land, Planeswalker, Battle
- **Search & filter** &mdash; real-time card name filtering across all sections
- **Share links** &mdash; generate shareable URLs for any comparison
- **Keyboard shortcuts** &mdash; Ctrl+Enter to compare

### Household PDFs

- **Whole deck or changes** — choose exact snapshots, default to the paper baseline, include sideboards optionally, and review physical copy counts.
- **Silhouette Card Maker v6** — actual upstream generation at 600 PPI, Letter, standard cards, 1 mm crop, three registration marks and seven cards per sheet.
- **Chosen artwork** — exact Scryfall printings or saved MPC fronts/backs. Use **Save art for home PDFs** in the MPC overlay to freeze all displayed matches.
- **Complete batches** — separate ordinary fronts and alternating DFC front/back PDFs; every required face must validate before publication.
- **Durable jobs** — downloads, manifests, progress, errors, request deduplication, owner access, scoped station claims and submission reconciliation.
- **Household queue** — administrators or explicitly allowed users can request printing. The Mac owns its Epson driver and verified local recipe; DFC backs require manual reload and resume.

Defaults: 250 physical copies per job, 1 GiB per PDF, seven-day retention for ready/terminal artifacts and a 10 GiB retained-job quota. Active print jobs are protected from expiry. ManaSync inventory checks, drying, lamination and cutting tracking are outside this release.

Install the [Mac companion](companion/mac/README.md) on the printer host separately from
Docker. It uses Python 3.9+ and native CUPS commands, with a scoped token file and local
SQLite receipts. It explicitly prints landscape Letter at actual size. Its dry run prints
nothing; normal operation requires a configured Epson
queue and accepted color/geometry proof. DFC backs remain blocked until manual reload and
resume. The optional LaunchAgent starts it at login; sleeping Macs leave jobs queued.

### Printing Metadata

- **Printing metadata** &mdash; import and export set codes, collector numbers (including promos like `136p`, `DDO-20`), and foil markers
- **Cross-source carry-forward** &mdash; comparing an Archidekt snapshot against a DeckCheck/plain text import? The export inherits printing metadata from the richer source automatically
- **Multi-printing support** &mdash; preserve separate quantities by card name, set, collector number, and foil status, including identical collector numbers from different sets
- **Double-faced card matching** &mdash; reconcile full DFC names and front-face names, including comparisons where only one side has printing metadata
- **Server-side enrichment** &mdash; plain text deck imports are enriched with printing metadata via Scryfall, with carry-forward from previous snapshots
- **Printing badges** &mdash; set code, collector number, and foil indicator displayed inline on card entries

Set changes with the same collector number and foil-only changes are included in the comparison. Exact printing lookups do not silently substitute generic artwork or prices when that printing is unavailable. The Printing tab uses a dedicated physical-copy plan that aggregates included zones, ignores finish-only swaps, and lets you keep or replace changed printings.

### Deck Library

- **Deck tracker** &mdash; track Archidekt users and decks with automatic snapshot history
- **Deck pages** &mdash; full-page view per deck with tabs for Snapshots, Changelog, Timeline, Full Deck, Printing, Analytics, and Settings
- **Grid layout** &mdash; deck cards in a responsive grid showing name, commander, price, tags, and last updated date
- **Interactive timeline** &mdash; clickable snapshot history with changes tab (what changed) and full deck tab (complete list at that point)
- **Snapshot comparison** &mdash; compare any two snapshots of the same deck in an in-page overlay
- **Paper tracking** &mdash; mark a snapshot as your physical deck, compare paper version vs latest digital changes
- **Deck overlap matrix** &mdash; see how many cards are shared across all your decks
- **Tags & organization** &mdash; user-defined tags, deck notes, pinning, and filter-by-tag
- **Collapsible owner groups** &mdash; decks grouped by Archidekt username with search filtering
- **Snapshot management** &mdash; lock important snapshots to prevent auto-pruning, configurable snapshot limits
- **Auto-refresh** &mdash; configure per-deck Archidekt refresh intervals of 6h, 12h, 24h, 48h, or one week; due decks are processed on the server's scheduler cycle
- **Change notifications** &mdash; optional verified-email and Discord webhook alerts, with notification history in the library
- **Deck sharing** &mdash; generate public share links for tracked decks with snapshot comparison

### ManaSync integration direction

Collection management, purchased/received cards, proxy inventory, storage locations, and deck allocations belong to ManaSync. CLC's collection tab, ownership badges, and collection API have been removed. Existing collection database rows remain in backups; no migration or export to ManaSync has shipped. CLC will consult ManaSync through an agreed integration for future buy/proxy decisions. See [ManaSync context](docs/MANASYNC_INTEGRATION.md).

### Deck Analytics

- **Price checking** &mdash; fetch current Scryfall prices with per-card breakdown, total, and top-10 most expensive cards
- **Budget prices** &mdash; cheapest printing totals alongside selected printing totals, with savings calculation
- **Price history** &mdash; smooth SVG chart showing deck value over time across snapshots
- **Price alerts** &mdash; set a dollar-change threshold for specific or cheapest printings; notify when value moves that far from the alert baseline, through configured email/Discord channels
- **Power level** &mdash; heuristic estimate (1&ndash;10 scale) based on fast mana, tutors, combo enablers, and mana curve
- **Mana curve** &mdash; CMC distribution visualization and comparison between snapshots
- **Color distribution** &mdash; color identity breakdown with official Scryfall mana symbols
- **Card type breakdown** &mdash; summary of creature, spell, land, and artifact counts

### Proxy Image Preparation

- **MPC Autofill integration** &mdash; search the MPC Autofill database for proxy-quality art for every card in your deck
- **Per-card art overrides** &mdash; browse and select alternative artwork; overrides persist per deck and sync to server
- **Advanced filters** &mdash; DPI range, language, source priority, tag includes/excludes, fuzzy search toggle
- **Cardstock selection** &mdash; Standard Smooth, Superior Smooth, Smooth, Linen, Plastic
- **XML & ZIP export** &mdash; download XML for the MPC Autofill desktop tool, or download a ZIP of matched card images
- **Scryfall image downloads** &mdash; queue a ZIP containing every requested physical copy and required face; missing cards, missing faces, or failed image downloads prevent completion and identify what failed
- **Image progress** &mdash; counts image files consistently, including repeated copies and both DFC faces; cached images count toward the same total
- **DFC image retrieval** &mdash; paired Scryfall front/back files share a copy number; household PDFs preserve the corresponding page/slot pairing

These exports prepare assets for the next printing step. Scryfall ZIPs created before completeness checks must be regenerated. MPC ZIPs still contain unique selected images rather than one image per physical copy and may be partial when an image source fails; MPC XML/ZIP exports still need an explicit copy-and-face adapter. For household printing, use the dedicated Printing tab: it generates validated Silhouette PDFs and exposes the native Mac station queue. Local Epson driver/color settings still require a physical proof. See [Home printing workflow](docs/PRINT_WORKFLOW.md).

### Card Display

- **Card image tooltips** &mdash; hover any card name to see the Scryfall image (exact printing artwork when metadata is available)
- **Official mana symbols** &mdash; inline Scryfall SVG mana symbols with idle-priority prefetching
- **Printing badges** &mdash; set code, collector number, and foil marker shown after card names

### Export Formats

- **Archidekt text** &mdash; native Archidekt format with full printing metadata and commander tags
- **Reddit markdown** &mdash; formatted for Reddit posts
- **MPCFill** &mdash; for MakePlayingCards proxy printing
- **Plain text changelog** &mdash; human-readable diff summary
- **JSON** &mdash; structured diff data
- **Full deck text** &mdash; raw deck list from any snapshot
- **Tabletop Simulator** &mdash; TTS JSON import as one deck, ordered commanders, mainboard, then sideboard, with Scryfall images

### Card Recommendations

- **Staple suggestions** &mdash; category-based recommendations: Ramp, Card Draw, Removal, Board Wipe, Protection, Lands, Recursion
- **Color-aware** &mdash; suggestions filtered by deck color identity
- **Commander badges** &mdash; locally maintained lists flag banned cards with a red "BANNED" badge and Game Changers with a gold badge; these are not a live rules or EDHREC feed
- **Search & filter** &mdash; search within suggestions, filter by category

### User Accounts & Security

- **Three registration modes** &mdash; open, invite-only, or closed
- **Invite code system** &mdash; users with invite permission can generate codes with configurable max uses; existing expiry is enforced, but the UI does not configure expiry
- **Email verification** &mdash; verify email addresses for password reset eligibility
- **Password complexity enforcement** &mdash; shared validation with live client-side feedback
- **Session management** &mdash; 7-day JWT tokens, automatic invalidation on password change
- **Brute-force protection** &mdash; account lockout after 5 failed login attempts (15-minute cooldown)
- **Security headers** &mdash; helmet with Content-Security-Policy, strict referrer policy

### Admin Panel

- **Dashboard** &mdash; user stats, active users, server health (uptime, memory), recent audit log
- **User management** &mdash; search, sort, paginate users; suspend/unsuspend, promote/demote, force-logout, reset passwords, unlock locked accounts
- **Audit log** &mdash; all admin actions logged with timestamps, filterable by action type
- **Registration settings** &mdash; toggle between open/invite/closed, configure snapshot limits
- **Invite management** &mdash; view all invite codes across users, grant/revoke invite permissions
- **Share moderation** &mdash; view and manage shared comparison links
- **Maintenance tools** &mdash; database backup download, expired token cleanup, audit log cleanup, emergency lockdown, user CSV export

### General

- **In-app guide** &mdash; comprehensive how-to documentation, feature walkthrough, and FAQ accessible to all users
- **Dark / light mode** &mdash; theme toggle with localStorage persistence
- **Mobile friendly** &mdash; responsive layout, touch-aware tooltips, installable as PWA on HTTPS or localhost; network access is required for API features
- **Performance** &mdash; client and server-side Scryfall caching, batched database queries, mana symbol prefetching

## Building from Source

Use Node 22+. Install both dependency trees before running tests or the backend:

```bash
git clone --branch main https://github.com/Cruv/card-list-compare.git
cd card-list-compare
npm ci
npm --prefix server ci

# Frontend
npm run dev

# Backend (separate terminal)
cd server
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to Express on port 3001. Development data defaults to `server/data/`. With `JWT_SECRET` unset outside production, the backend creates a random development secret in `.jwt-dev-secret` beside the database; it survives restarts when that directory is writable. An explicitly supplied weak secret still prevents startup.

The npm backend scripts do not load `.env` automatically. For optional SMTP or explicit environment settings, export them in the backend shell, or use Node's environment-file support from the repository root:

```bash
node --env-file=.env --watch server/index.js
```

Copy `.env.example` to `.env` and configure it before using that command. For admin access on a fresh database, follow the restart step in Application Setup. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

### Running Tests

```bash
npm test            # Client/server unit and invariant tests
npm run test:watch  # Watch mode
npm run lint        # Required: zero ESLint errors; warnings are allowed
npm run build       # Production frontend build
npm audit           # Frontend dependency audit
npm --prefix server audit  # Server dependency audit
```

### Building the Docker Image

Set a strong `JWT_SECRET` in the repository-root `.env` first (see `.env.example`).

```bash
docker compose up -d --build
```

## Architecture

```
src/
  components/    # React UI components
  components/admin/  # Admin panel sections
  context/       # Auth, theme, and settings providers
  lib/           # Parser, differ, exports, API client, Scryfall, card identity
server/
  routes/        # Auth, decks, snapshots, shares, admin, MPC Autofill
  middleware/     # Rate limiting, validation, auth, security
  lib/           # Enrichment, prices, notifications, image cache/download queue, auth helpers
  db.js          # sql.js migrations and atomic persistence
nginx.conf       # Production reverse proxy config
Dockerfile       # Multi-stage build
docker-compose.yml
```

| Layer | Tech |
|:---:|---|
| Frontend | React 19, Vite 7, CSS variables |
| Backend | Express 5, Node 22 |
| Database | SQLite via sql.js |
| Auth | JWT + bcryptjs, helmet, Nodemailer |
| APIs / imports | Scryfall, MPC Autofill, Archidekt, Moxfield, DeckCheck, TappedOut, Deckstats, MTGGoldfish, TCGPlayer |
| Deployment | Docker (Alpine + nginx + Node) |

### API Rate Limits

| Endpoint Group | Limit |
|:---:|---|
| Auth (login/register) | 10 requests / 15 minutes |
| General API | 120 requests / minute |
| Authenticated Archidekt browse/refresh routes | 10 requests / minute |
| MPC search, alternates, XML, and image download | 15 requests / minute |
| Share creation | 10 requests / minute |

These Express limits are per IP. Production's nginx import proxies bypass Express and remain subject to the upstream providers' limits. The background Scryfall image queue accepts at most two pending jobs per user and twenty overall, processes one at a time, and expires completed ZIPs after 24 hours. Each image job allows up to 1,000 physical copies, 20 MiB per source image and 256 MiB of unique image buffers; oversized inputs fail without publishing a partial ZIP.

## Project Documentation

- [Contributing](CONTRIBUTING.md) and [coding conventions](CLAUDE.md)
- [Decisions](docs/DECISIONS.md), [invariants](docs/INVARIANTS.md), and [deck text format](docs/DECK_TEXT_FORMAT.md)
- [Operations](docs/OPERATIONS.md) and [security](SECURITY.md)
- [Roadmap](docs/ROADMAP.md), [home printing workflow](docs/PRINT_WORKFLOW.md), and [ManaSync integration context](docs/MANASYNC_INTEGRATION.md)

## License

MIT
