import rateLimit from 'express-rate-limit';

// Strict limiter for auth endpoints (login/register)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// General API limiter
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Limiter for Archidekt-hitting routes (refresh, browse decks)
export const archidektLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 Archidekt calls per minute
  message: { error: 'Too many Archidekt requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Limiter for MPC Autofill API calls
export const mpcLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 MPC API calls per minute
  message: { error: 'Too many MPC Autofill requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Limiter for Scryfall image downloads (heavy resource usage)
export const scryfallDownloadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 3, // 3 downloads per 5 minutes per user
  message: { error: 'Too many image download requests. Please wait a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Limiter for share creation
export const shareLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many share links created. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false,
});
