import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { evaluatePriceAlert } from './notificationScheduler.js';

describe('evaluatePriceAlert (audit: price-alert baseline)', () => {
  it('establishes a baseline on first observation without firing', () => {
    expect(evaluatePriceAlert(null, 100, 10)).toEqual({ fire: false, newBaseline: 100 });
  });

  it('fires and advances the baseline when the change meets the threshold', () => {
    expect(evaluatePriceAlert(100, 115, 10)).toEqual({ fire: true, newBaseline: 115 });
    expect(evaluatePriceAlert(100, 80, 10)).toEqual({ fire: true, newBaseline: 80 });
  });

  it('ignores a $0 reading (Scryfall outage) instead of alerting and resetting the baseline', () => {
    // computeDeckPrices yields 0 when Scryfall returns nothing. Alerting on it
    // would send "decreased by $250", store 0, then "increased by $250" on recovery.
    const outage = evaluatePriceAlert(250, 0, 10);
    expect(outage).toEqual({ fire: false, newBaseline: 250 }); // baseline preserved
    // …so the recovery reading compares against the real baseline and stays quiet.
    expect(evaluatePriceAlert(outage.newBaseline, 251, 10)).toEqual({ fire: false, newBaseline: 250 });
  });

  it('treats a 0 baseline as not-yet-established rather than a real price', () => {
    expect(evaluatePriceAlert(0, 412, 10)).toEqual({ fire: false, newBaseline: 412 });
  });

  it('holds the baseline when under threshold, so gradual change accumulates', () => {
    // Each step is under $10, but they accumulate against the SAME baseline until
    // the total crosses the threshold — which the old last_known_price reset broke.
    let baseline = 100;
    for (const price of [104, 107, 109]) {
      const r = evaluatePriceAlert(baseline, price, 10);
      expect(r.fire).toBe(false);
      baseline = r.newBaseline;
      expect(baseline).toBe(100); // unchanged
    }
    const final = evaluatePriceAlert(baseline, 111, 10);
    expect(final.fire).toBe(true); // 111 - 100 = 11 >= 10
  });
});

describe('canSendEmail rate limit (audit: dead SQL comparison)', () => {
  let dir;
  let db;
  let canSendEmail;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'clc-notif-'));
    process.env.DB_PATH = join(dir, 'test.db');
    vi.resetModules();
    db = await import('../db.js');
    await db.initDb();
    ({ canSendEmail } = await import('./notificationScheduler.js'));
    db.run("INSERT INTO users (username, password_hash) VALUES ('u', 'h')");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DB_PATH;
  });

  function logEmail(ago) {
    db.run(
      `INSERT INTO notification_log (user_id, notification_type, channel, subject, created_at)
       VALUES (1, 'deck_change', 'email', 's', datetime('now', ?))`,
      [ago]
    );
  }

  it('counts only emails within the last hour', () => {
    for (let i = 0; i < 9; i++) logEmail('-5 minutes');
    expect(canSendEmail(1)).toBe(true); // 9 < 10
    logEmail('-5 minutes');
    expect(canSendEmail(1)).toBe(false); // 10 -> limited
  });

  it('ignores emails older than an hour', () => {
    for (let i = 0; i < 20; i++) logEmail('-2 hours');
    expect(canSendEmail(1)).toBe(true); // all outside the window
  });
});
