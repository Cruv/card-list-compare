# Card List Compare

Compare two MTG deck lists side-by-side and generate detailed changelogs showing cards added, removed, and quantity changes. Import directly from Archidekt, Moxfield, or DeckCheck URLs, or paste any text-format deck list.

## Supported Architectures

The image supports `linux/amd64`. Published to GitHub Container Registry.

| Architecture | Available |
|:---:|:---:|
| x86-64 | &#10003; |

## Application Setup

Access the web UI at `http://<your-ip>:8080`.

The first user to register becomes the admin. Additional registration can be toggled on/off from the admin panel.

To enable password reset via email, configure the SMTP environment variables below.

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
| `SMTP_HOST` | No | &mdash; | SMTP server for password reset emails |
| `SMTP_PORT` | No | `587` | SMTP port |
| `SMTP_USER` | No | &mdash; | SMTP username |
| `SMTP_PASS` | No | &mdash; | SMTP password or app-specific password |
| `SMTP_FROM` | No | &mdash; | From address for outgoing emails |
| `TZ` | No | `UTC` | Container timezone ([tz database name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)), e.g. `America/New_York` |
| `APP_URL` | No | &mdash; | Public URL of the app (used in reset email links) |

> SMTP variables are only needed for password reset via email. Without them, the app works normally — users just can't reset forgotten passwords.

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

## Features

- **Deck comparison** &mdash; paste, upload, or import two deck lists and instantly see what changed
- **Multi-format parser** &mdash; Arena/MTGO exports, CSV, plain text, `SB:` prefix notation
- **URL import** &mdash; pull decks from Archidekt, Moxfield, and DeckCheck links
- **Set code preservation** &mdash; captures edition codes from Archidekt so printings round-trip
- **Deck tracker** &mdash; track Archidekt users/decks with automatic snapshot history
- **Card image tooltips** &mdash; hover any card name to see the Scryfall image
- **Mana cost display** &mdash; inline colored mana symbols from Scryfall
- **Card type grouping** &mdash; changelogs grouped by creature, instant, sorcery, etc.
- **Search & filter** &mdash; real-time card name filtering across all sections
- **Export formats** &mdash; plain text, Reddit markdown, MPCFill, JSON, Archidekt re-import
- **Dark / light mode** &mdash; theme toggle with localStorage persistence
- **Share links** &mdash; generate shareable URLs for any comparison
- **Mobile friendly** &mdash; responsive layout, touch-aware tooltips, installable as PWA
- **User accounts** &mdash; registration, login, password reset via email
- **Admin panel** &mdash; manage users, toggle registration, view system info

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
  context/       # Auth and theme providers
  lib/           # Parser, differ, formatter, API client, Scryfall
server/
  routes/        # Express API routes (auth, decks, snapshots, admin)
  middleware/     # Rate limiting, validation, auth
  lib/           # Server-side deck fetching
  db.js          # SQLite via sql.js
nginx.conf       # Production reverse proxy config
Dockerfile       # Multi-stage build
docker-compose.yml
```

| Layer | Tech |
|:---:|---|
| Frontend | React 19, Vite 7, CSS variables |
| Backend | Express 5, Node 22 |
| Database | SQLite via sql.js |
| Auth | JWT + bcryptjs, Nodemailer |
| APIs | Scryfall, Archidekt, Moxfield, DeckCheck |
| Deployment | Docker (Alpine + nginx + Node) |

### API Rate Limits

| Endpoint Group | Limit |
|:---:|---|
| Auth (login/register) | 20 requests / 15 minutes |
| General API | 120 requests / minute |
| Archidekt proxy | 10 requests / minute |
| Share links | 10 requests / minute |

## License

MIT
