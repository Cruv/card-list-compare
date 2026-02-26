# Card List Compare

Compare two MTG deck lists side-by-side and generate detailed changelogs showing cards added, removed, and quantity changes. Import directly from Archidekt, Moxfield, or DeckCheck URLs, or paste any text-format deck list. Track your Archidekt decks with automatic snapshot history, interactive timelines, deck analytics, and cross-deck overlap analysis.

## Supported Architectures

The image supports `linux/amd64`. Published to GitHub Container Registry.

| Architecture | Available |
|:---:|:---:|
| x86-64 | &#10003; |

## Application Setup

Access the web UI at `http://<your-ip>:8080`.

The first user to register becomes the admin. Registration can be set to open, invite-only, or closed from the admin panel. In invite mode, existing users with invite permission can generate invite codes for new users.

To enable password reset and email verification, configure the SMTP environment variables below.

## Usage

### docker-compose (recommended)

Create a `docker-compose.yml` anywhere on your host:

```yaml
---
services:
  card-list-compare:
    image: ghcr.io/cruv/card-list-compare:latest
    container_name: card-list-compare
    environment:
      - PUID=1000
      - PGID=1000
      - JWT_SECRET=CHANGE_ME
      - DB_PATH=/app/data/cardlistcompare.db
      - TZ=America/New_York #optional
      - SMTP_HOST=smtp.example.com #optional
      - SMTP_PORT=587 #optional
      - SMTP_USER=you@example.com #optional
      - SMTP_PASS=your-app-password #optional
      - SMTP_FROM=noreply@example.com #optional
      - APP_URL=http://localhost:8080 #optional
    volumes:
      - ./data:/app/data
    ports:
      - 8080:80
    restart: unless-stopped
```

Then start with:

```bash
docker compose up -d
```

### docker cli

```bash
docker run -d \
  --name=card-list-compare \
  -e PUID=1000 \
  -e PGID=1000 \
  -e JWT_SECRET=CHANGE_ME \
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
| `JWT_SECRET` | **Yes** | `change-me-in-production` | Secret for signing auth tokens. Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DB_PATH` | No | `/app/data/cardlistcompare.db` | Path to SQLite database file |
| `SMTP_HOST` | No | &mdash; | SMTP server for emails (password reset, email verification) |
| `SMTP_PORT` | No | `587` | SMTP port |
| `SMTP_USER` | No | &mdash; | SMTP username |
| `SMTP_PASS` | No | &mdash; | SMTP password or app-specific password |
| `SMTP_FROM` | No | &mdash; | From address for outgoing emails |
| `TZ` | No | `UTC` | Container timezone ([tz database name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)), e.g. `America/New_York` |
| `APP_URL` | No | &mdash; | Public URL of the app (used in email links) |

> SMTP variables are only needed for password reset and email verification. Without them, the app works normally &mdash; users just can't reset forgotten passwords or verify their email.

### Volume Mappings

| Volume | Function |
|:---:|---|
| `/app/data` | SQLite database storage. Bind mount to persist across container rebuilds. |

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
cp ./data/cardlistcompare.db ./backups/cardlistcompare-$(date +%Y%m%d).db
```

Admins can also download a database backup directly from the admin dashboard.

## Features

### Deck Comparison

- **Side-by-side diff** &mdash; paste, upload, or import two deck lists and instantly see cards added, removed, quantity changes, and printing swaps
- **Multi-format parser** &mdash; Arena/MTGO exports, CSV, plain text, `SB:` prefix notation, with set codes `(M10)`, collector numbers `[227]`, and foil `*F*` markers
- **URL import** &mdash; pull decks from Archidekt, Moxfield, DeckCheck, TappedOut, and Deckstats links with metadata coverage feedback
- **Card type grouping** &mdash; changelogs grouped by Creature, Instant, Sorcery, Artifact, Enchantment, Land, Planeswalker, Battle
- **Search & filter** &mdash; real-time card name filtering across all sections
- **Share links** &mdash; generate shareable URLs for any comparison
- **Keyboard shortcuts** &mdash; Ctrl+Enter to compare

### Printing Metadata

- **Full round-trip preservation** &mdash; set codes, collector numbers (including promos like `136p`, `DDO-20`), and foil status survive import &rarr; diff &rarr; export
- **Cross-source carry-forward** &mdash; comparing an Archidekt snapshot against a DeckCheck/plain text import? The export inherits printing metadata from the richer source automatically
- **Multi-printing support** &mdash; cards that allow multiples (Nazgul, Hare Apparent, etc.) with different artworks diff correctly across printings
- **Double-faced card matching** &mdash; "Sheoldred // The True Scriptures" correctly matches "Sheoldred" across deck sources
- **Server-side enrichment** &mdash; plain text deck imports are enriched with printing metadata via Scryfall, with carry-forward from previous snapshots
- **Printing badges** &mdash; set code, collector number, and foil indicator displayed inline on card entries

### Deck Library

- **Deck tracker** &mdash; track Archidekt users and decks with automatic snapshot history
- **Deck pages** &mdash; full-page view per deck with tabs for Snapshots, Changelog, Timeline, Full Deck, Analytics, and Settings
- **Grid layout** &mdash; deck cards in a responsive grid showing name, commander, price, tags, and last updated date
- **Interactive timeline** &mdash; clickable snapshot history with changes tab (what changed) and full deck tab (complete list at that point)
- **Snapshot comparison** &mdash; compare any two snapshots of the same deck in an in-page overlay
- **Paper tracking** &mdash; mark a snapshot as your physical deck, compare paper version vs latest digital changes
- **Deck overlap matrix** &mdash; see how many cards are shared across all your decks
- **Tags & organization** &mdash; user-defined tags, deck notes, pinning, and filter-by-tag
- **Collapsible owner groups** &mdash; decks grouped by Archidekt username with search filtering
- **Snapshot management** &mdash; lock important snapshots to prevent auto-pruning, configurable snapshot limits
- **Auto-refresh** &mdash; schedule automatic Archidekt checks per deck (6h, 12h, or 24h intervals)
- **Deck sharing** &mdash; generate public share links for tracked decks with snapshot comparison

### Deck Analytics

- **Price checking** &mdash; fetch current Scryfall prices with per-card breakdown, total, and top-10 most expensive cards
- **Budget prices** &mdash; cheapest printing totals alongside owned printing totals, with savings calculation
- **Price history** &mdash; smooth SVG chart showing deck value over time across snapshots
- **Price alerts** &mdash; set thresholds to be notified when deck price crosses a target
- **Power level** &mdash; heuristic estimate (1&ndash;10 scale) based on fast mana, tutors, combo enablers, and mana curve
- **Mana curve** &mdash; CMC distribution visualization and comparison between snapshots
- **Color distribution** &mdash; color identity breakdown with official Scryfall mana symbols
- **Card type breakdown** &mdash; summary of creature, spell, land, and artifact counts

### Proxy Printing

- **MPC Autofill integration** &mdash; search the MPC Autofill database for proxy-quality art for every card in your deck
- **Per-card art overrides** &mdash; browse and select alternative artwork; overrides persist per deck and sync to server
- **Advanced filters** &mdash; DPI range, language, source priority, tag includes/excludes, fuzzy search toggle
- **Cardstock selection** &mdash; Standard Smooth, Superior Smooth, Smooth, Linen, Plastic
- **XML & ZIP export** &mdash; download XML for the MPC Autofill browser extension, or download a ZIP of all card images
- **Scryfall image downloads** &mdash; download a ZIP of all Scryfall card images for a deck (background job with progress tracking)
- **DFC auto-pairing** &mdash; double-faced cards automatically include both front and back face images

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
- **Tabletop Simulator** &mdash; TTS JSON deck import with Scryfall images, proper zones, and commander placement

### Card Recommendations

- **Staple suggestions** &mdash; category-based recommendations: Ramp, Card Draw, Removal, Board Wipe, Protection, Lands, Recursion
- **Color-aware** &mdash; suggestions filtered by deck color identity
- **EDHREC badges** &mdash; Commander-banned cards flagged with red "BANNED" badge, high-impact cards with gold "Game Changer" badge
- **Search & filter** &mdash; search within suggestions, filter by category

### User Accounts & Security

- **Three registration modes** &mdash; open, invite-only, or closed
- **Invite code system** &mdash; users with invite permission can generate codes with configurable max uses and expiry
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
- **Mobile friendly** &mdash; responsive layout, touch-aware tooltips, installable as PWA
- **Performance** &mdash; client and server-side Scryfall caching, batched database queries, mana symbol prefetching

## Building from Source

If you want to develop locally or build the image yourself:

```bash
git clone https://github.com/Cruv/card-list-compare.git
cd card-list-compare

# Frontend
npm install
npm run dev

# Backend (separate terminal)
cd server && npm install && npm run dev
```

The Vite dev server proxies `/api` requests to the Express backend automatically.

### Running Tests

```bash
npm test          # Run all tests once
npm run test:watch  # Watch mode
```

### Building the Docker Image

```bash
docker compose up -d --build
```

## Architecture

```
src/
  components/    # React UI components
  components/admin/  # Admin panel sections
  context/       # Auth, theme, and settings providers
  lib/           # Parser, differ, formatter, API client, Scryfall
server/
  routes/        # Express API routes (auth, decks, snapshots, admin)
  middleware/     # Rate limiting, validation, auth, security
  lib/           # Scryfall client, deck enrichment, Archidekt conversion, snapshot pruning
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
| APIs | Scryfall, Archidekt, Moxfield, DeckCheck |
| Deployment | Docker (Alpine + nginx + Node) |

### API Rate Limits

| Endpoint Group | Limit |
|:---:|---|
| Auth (login/register) | 10 requests / 15 minutes |
| General API | 120 requests / minute |
| Archidekt proxy | 10 requests / minute |
| Share links | 10 requests / minute |

## License

MIT
