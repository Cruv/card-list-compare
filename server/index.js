import express from 'express';
import { initDb } from './db.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { MAX_BODY_SIZE } from './middleware/validate.js';
import authRoutes from './routes/auth.js';
import ownerRoutes from './routes/owners.js';
import deckRoutes from './routes/decks.js';
import snapshotRoutes from './routes/snapshots.js';
import shareRoutes from './routes/share.js';
import adminRoutes from './routes/admin.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Warn about insecure JWT secret
if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET not set. Using insecure dev fallback. Set JWT_SECRET in production!');
}

app.use(express.json({ limit: MAX_BODY_SIZE }));

// Global rate limit for all /api routes
app.use('/api', apiLimiter);

// Health check (no auth, no rate limit)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
