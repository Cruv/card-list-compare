import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import { initDb, persist, backupDb } from './db.js';
import { getJwtSecret } from './lib/jwtSecret.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { MAX_BODY_SIZE, requireJsonContentType, trimBody } from './middleware/validate.js';
import authRoutes from './routes/auth.js';
import ownerRoutes from './routes/owners.js';
import deckRoutes from './routes/decks.js';
import snapshotRoutes from './routes/snapshots.js';
import shareRoutes from './routes/share.js';
import sharedDeckRoutes from './routes/shared-decks.js';
import adminRoutes from './routes/admin.js';
import collectionRoutes from './routes/collection.js';
import mpcRoutes from './routes/mpcautofill.js';
import { startNotificationScheduler } from './lib/notificationScheduler.js';
import { initDownloadQueue } from './lib/downloadQueue.js';

const app = express();
const PORT = process.env.PORT || 3001;
const startTime = Date.now();

// Resolve the JWT secret eagerly so a missing/weak secret is fatal at boot
// (in production) rather than silently signing forgeable tokens per-request.
try {
  getJwtSecret();
} catch (err) {
  console.error('FATAL:', err.message);
  process.exit(1);
}

// Trust first proxy (nginx/reverse proxy) for correct IP in rate limiting
app.set('trust proxy', 1);

// Gzip compression for API responses (before routes, after trust proxy)
app.use(compression({ level: 6, threshold: 512 }));

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "https://cards.scryfall.io", "https://*.scryfall.io", "https://drive.google.com", "data:"],
      connectSrc: ["'self'", "https://api.scryfall.com", "https://archidekt.com", "https://www.archidekt.com", "https://mpcfill.com"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use(express.json({ limit: MAX_BODY_SIZE }));

// Input sanitization on /api routes
app.use('/api', requireJsonContentType);
app.use('/api', trimBody);

// Global rate limit for all /api routes
app.use('/api', apiLimiter);

// Health check (no auth; rate-limited by the global /api limiter above)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: Math.floor((Date.now() - startTime) / 1000) });
});

app.use('/api/auth', authRoutes);
app.use('/api/owners', ownerRoutes);
app.use('/api/decks', deckRoutes);
app.use('/api/decks', snapshotRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/shared-deck', sharedDeckRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/collection', collectionRoutes);
app.use('/api/mpc', mpcRoutes);

async function start() {
  await initDb();
  initDownloadQueue();
  app.listen(PORT, () => {
    console.log(`CardListCompare server running on port ${PORT}`);
    startNotificationScheduler();
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// Graceful shutdown: flush the in-memory DB and snapshot a backup before exit.
// (Data safety does not depend on this firing — persist() is atomic per write —
// but a clean stop refreshes the .bak. Effective once the container forwards
// signals to node; the entrypoint still needs a signal-forwarding init.)
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, flushing database before exit...`);
  try {
    persist();
    backupDb();
  } catch (err) {
    console.error('Error during shutdown flush:', err.message);
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
