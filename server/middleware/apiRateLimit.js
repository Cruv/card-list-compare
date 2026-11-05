import rateLimit from 'express-rate-limit';
import { apiLimiter } from './rateLimit.js';
import { requireStationToken } from '../lib/printQueue.js';

// This is intentionally the native protocol namespace, not the browser's
// /print-station-management endpoints. Run while mounted at /api, before parsing.
function authenticatedStationRequest(req) {
  if (!/^\/print-station(?:\/|$)/.test(req.path)) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  try {
    // Reuse the route's timing-safe, rotation-aware credential check. Do not
    // trust a URL, a user JWT, or a client-supplied station ID to select a budget.
    requireStationToken(header.slice(7));
    return true;
  } catch {
    return false;
  }
}

export function createApiRateLimiter({ general = apiLimiter, stationMax = 240, windowMs = 60_000 } = {}) {
  const station = rateLimit({
    windowMs,
    max: stationMax,
    keyGenerator: () => 'household', // One bounded budget across IPs and token rotation.
    message: { error: 'Too many print-station requests. Wait for the request window to reset before retrying the same operation.' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  return (req, res, next) => (authenticatedStationRequest(req) ? station : general)(req, res, next);
}

export default createApiRateLimiter();
