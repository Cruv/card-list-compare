# Card List Compare

Compare two MTG deck lists side-by-side and generate detailed changelogs showing cards added, removed, and quantity changes. Import directly from Archidekt or Moxfield URLs, or paste any text-format deck list.

## Features

- **Deck Comparison** - Paste, upload, or import two deck lists and instantly see what changed
- **Multi-Format Parser** - Handles Arena/MTGO exports, CSV, plain text (`4 Lightning Bolt`, `4x Lightning Bolt`), and `SB:` prefix notation
- **URL Import** - Pull decks directly from Archidekt, Moxfield, and DeckCheck links
- **Commander Detection** - Automatically identifies commanders from section headers or inline `(Commander)` tags
- **Sideboard Support** - Detects sideboards via headers, blank-line separation, or `SB:` prefixes
- **Set Code Preservation** - Captures edition/set codes from Archidekt so printings round-trip correctly
- **Deck Tracker** - Track Archidekt users and their decks to automatically build change history over time
- **Snapshot History** - Save deck versions locally or server-side, compare any two snapshots
- **Bulk Refresh** - Refresh all tracked decks from Archidekt in one click
- **Shareable Links** - Generate permanent share links for any comparison
- **Export Formats** - Copy changelogs as plain text, Reddit markdown (with `[[card]]` links), JSON, MPCFill proxy-print format, or Archidekt re-import
- **Card Image Tooltips** - Hover over any card name to see the Scryfall card image
- **Mana Cost Display** - Inline colored mana symbols pulled from Scryfall
- **Card Type Grouping** - Changelogs grouped by creature, instant, sorcery, etc.
- **Search & Filter** - Real-time card name filtering across all changelog sections
- **Change Summary Stats** - See total cards in, out, changed, and % unchanged at a glance
- **Dark / Light Mode** - Toggle between themes with localStorage persistence
- **Mobile Friendly** - Responsive layout, touch-aware tooltips, installable as PWA
- **User Accounts** - Optional registration to persist tracked decks and snapshots across devices
- **User Settings** - Change password, add email, delete account from an in-app settings panel
- **Password Reset** - Email-based password reset flow (requires SMTP configuration)
- **Admin Panel** - Manage users, toggle registration, view system info

## Quick Start with Docker

No need to clone the repo — just create two files and run:

**1. Create a `docker-compose.yml`:**

```yaml
services:
  card-list-compare:
    image: ghcr.io/cruv/card-list-compare:latest
    ports:
      - "8080:80"
    environment:
      - JWT_SECRET=CHANGE_ME  # Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
      - DB_PATH=/app/data/cardlistcompare.db
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

**2. Start it:**

```bash
docker compose up -d
# Open http://localhost:8080
```

That's it. Your database is stored in `./data/` on the host via bind mount, so it persists across container rebuilds and is easy to back up.

> **Important:** Replace `CHANGE_ME` with a real secret. Generate one with:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

## Local Development

### Prerequisites

- Node.js 20+
- npm 9+

### Frontend

```bash
# Install dependencies
npm install

# Start dev server (http://localhost:5173)
npm run dev
```

### Backend

```bash
# Install server dependencies
cd server
npm install

# Start backend (http://localhost:3001)
npm run dev
```

The Vite dev server proxies `/api` requests to the backend automatically. Both need to be running for full functionality.

### Environment Variables

Copy `.env.example` and fill in values:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | Yes (production) | Insecure fallback | Secret key for signing auth tokens. Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DB_PATH` | No | `./server/data/cardlistcompare.db` | Path to SQLite database file |
| `PORT` | No | `3001` | Express server port |
| `SMTP_HOST` | No | — | SMTP server hostname (e.g. `smtp.gmail.com`) |
| `SMTP_PORT` | No | `587` | SMTP port |
| `SMTP_USER` | No | — | SMTP username / email |
| `SMTP_PASS` | No | — | SMTP password or app-specific password |
| `SMTP_FROM` | No | `noreply@cardlistcompare.local` | From address for outgoing emails |
| `APP_URL` | No | `http://localhost:8080` | Public URL of the app (used in password reset links) |
| `PUID` | No | `1000` | User ID for file permissions in Docker |
| `PGID` | No | `1000` | Group ID for file permissions in Docker |

> **Note:** SMTP variables are only needed for password reset via email. Without them, the app works normally — users just can't reset forgotten passwords. They'll see a message explaining this if they try.

### Running Tests

```bash
# Run all tests once
npm test

# Watch mode
npm run test:watch
```

Tests cover the parser (41 tests), differ (21 tests), and formatter (42 tests) — 104 total.

### Building for Production

```bash
npm run build
```

Output goes to `dist/`. In Docker, nginx serves the frontend and proxies API requests to the Node backend.

## Usage Guide

### Comparing Two Deck Lists

1. **Paste** deck lists into the Before and After text areas, **upload** `.txt`/`.csv`/`.dec` files, or **import** from a URL
2. Click **Compare Lists** (or press **Ctrl+Enter**)
3. The changelog shows cards added (+), removed (-), and quantity changes (~)
4. Use the copy buttons to export in your preferred format

### Supported Input Formats

All of these work — mix and match freely:

```
4 Lightning Bolt                    # Simple
4x Lightning Bolt                   # With "x"
4 Lightning Bolt (M10) 123          # Arena/MTGO with set + collector number
Lightning Bolt                      # Bare name (quantity defaults to 1)
SB: 2 Fatal Push                    # Sideboard prefix
```

**CSV** with headers is also supported:

```
quantity,name,section
4,Lightning Bolt,mainboard
2,Fatal Push,sideboard
```

**Sideboard** is detected automatically from:
- A `Sideboard` or `SB` header line
- A blank line separating mainboard and sideboard
- `SB:` prefix on individual lines

**Commanders** are detected from:
- A `Commander` or `Command Zone` header
- Inline `(Commander)` tags (Deckcheck format)

Lines starting with `//` or `#` are treated as comments and ignored.

### Importing from URLs

Click the **URL** button on either deck input and paste a link:

- **Archidekt**: `https://archidekt.com/decks/123456/...`
- **Moxfield**: `https://www.moxfield.com/decks/abc123`

The deck list is fetched and loaded automatically, including commander and sideboard detection.

### Saving Snapshots

Click **Save** on either deck input to save the current list as a named snapshot. Snapshots are stored in your browser's localStorage and are available from the **Snapshots** dropdown on each input.

Use **Manage Snapshots** to view, rename, load, or delete saved snapshots.

### Deck Tracker (Requires Account)

Register an account to unlock the Deck Tracker:

1. **Track a user** - Enter an Archidekt username to start monitoring their public decks
2. **Browse and select decks** - Click "Browse Decks" to see their public decks, then click "Track" on the ones you want to follow
3. **Refresh** - Click "Refresh" on any deck (or "Refresh All") to check Archidekt for changes. If the deck changed, a new snapshot is saved automatically
4. **View changelogs** - Expand any tracked deck and click "View Latest Changelog" to see what changed between the two most recent snapshots
5. **Compare any two snapshots** - Use "Compare Snapshots..." to pick any two versions
6. **Load into Compare view** - Click "Load Before" / "Load After" to pull snapshot text into the main comparison view

### Sharing Comparisons

After comparing two lists, click **Share Link** to generate a permanent URL. The link encodes both deck lists — anyone with the link sees the same comparison. The URL is automatically copied to your clipboard.

### Export Formats

| Button | Format | Use Case |
|--------|--------|----------|
| **Copy** | Plain text changelog | Pasting into chat, notes |
| **Copy for Reddit** | Markdown with `[[card]]` links | Reddit posts (card fetcher bots will link cards) |
| **Copy JSON** | Structured JSON | Data analysis, scripts, automation |
| **Copy for MPCFill** | Simple `qty name` list of new/increased cards | Ordering proxy prints of new additions |
| **Export for Archidekt** | Archidekt text import format with set codes | Pasting back into Archidekt to preserve printings |

## Architecture

```
card-list-compare/
  src/                    # React 19 frontend (Vite 7)
    lib/                  # Core logic (parser, differ, formatter)
    components/           # UI components
    context/              # Auth context
  server/                 # Express 5 backend
    routes/               # API routes (auth, owners, decks, snapshots, share)
    middleware/            # Auth, rate limiting, validation
    lib/                  # Server-side Archidekt API client, email sender
    db.js                 # SQLite via sql.js
  nginx.conf              # Production reverse proxy config
  Dockerfile              # Multi-stage build (frontend + backend + nginx)
  docker-compose.yml      # One-command deployment
```

### Tech Stack

- **Frontend**: React 19, Vite 7, plain CSS with CSS variables, dark/light theming
- **Backend**: Express 5, ESM modules
- **Database**: SQLite via sql.js (pure JavaScript, no native compilation)
- **Auth**: JWT with bcryptjs, optional email-based password reset via Nodemailer
- **APIs**: Scryfall (card data/images), Archidekt, Moxfield, DeckCheck (deck imports)
- **Testing**: Vitest
- **Deployment**: Docker (Alpine + nginx + Node), bind-mounted data volume, PWA support

### API Rate Limits

| Endpoint Group | Limit |
|----------------|-------|
| Auth (login/register) | 20 requests / 15 minutes |
| General API | 120 requests / minute |
| Archidekt proxy | 10 requests / minute |
| Share links | 10 requests / minute |

## Docker Details

The Docker image runs nginx (frontend + reverse proxy) and the Node.js backend in a single container.

- **Port**: 80 inside the container, mapped to 8080 by default in `docker-compose.yml`
- **Data**: SQLite database stored at `/app/data/cardlistcompare.db`, bind-mounted to `./data/` on the host
- **Health check**: `GET /api/health` every 30 seconds
- **Image size**: ~180 MB (Alpine-based)

To rebuild after code changes:

```bash
docker compose up -d --build
```

To back up your data:

```bash
cp ./data/cardlistcompare.db ./backups/cardlistcompare-$(date +%Y%m%d).db
```

## License

MIT
