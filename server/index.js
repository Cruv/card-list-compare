import express from 'express';
import helmet from 'helmet';
import { initDb } from './db.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { MAX_BODY_SIZE, requireJsonContentType, trimBody } from './middleware/validate.js';
import authRoutes from './routes/auth.js';
import ownerRoutes from './routes/owners.js';
import deckRoutes from './routes/decks.js';
import snapshotRoutes from './routes/snapshots.js';
import shareRoutes from './routes/share.js';
import adminRoutes from './routes/admin.js';

const app = express();
const PORT = process.env.PORT || 3001;
const startTime = Date.now();

// Warn about insecure JWT secret
if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET not set. Using insecure dev fallback. Set JWT_SECRET in production!');
}

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "https://cards.scryfall.io", "https://*.scryfall.io", "data:"],
      connectSrc: ["'self'", "https://api.scryfall.com", "https://archidekt.com", "https://www.archidekt.com"],
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

// Health check (no auth, no rate limit)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: Math.floor((Date.now() - startTime) / 1000) });
});

app.use('/api/auth', authRoutes);
app.use('/api/owners', ownerRoutes);
app.use('/api/decks', deckRoutes);
app.use('/api/decks', snapshotRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/admin', adminRoutes);

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`CardListCompare server running on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
