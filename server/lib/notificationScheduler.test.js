import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { evaluatePriceAlert, sendDiscordWebhook, sendPriceAlertWebhook } from './notificationScheduler.js';

vi.mock('./sourceSync.js', () => ({ refreshArchidektDeck: vi.fn() }));

describe('evaluatePriceAlert (audit: price-alert baseline)', () => {
  it('establishes a baseline on first observation without firing', () => {
    expect(evaluatePriceAlert(null, 100, 10)).toEqual({ fire: false, newBaseline: 100 });
  });

  it('fires and advances the baseline when the change meets the threshold', () => {
    expect(evaluatePriceAlert(100, 115, 10)).toEqual({ fire: true, newBaseline: 115 });
    expect(evaluatePriceAlert(100, 80, 10)).toEqual({ fire: true, newBaseline: 80 });
  });

  it('ignores a $0 reading (Scryfall outage) instead of alerting and resetting the baseline', () => {
    // Empty decks must not alert or establish a price baseline.
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

describe('price alert snapshots', () => {
  let dir, db, deck, processSingleDeck;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'clc-price-alert-'));
    vi.stubEnv('DB_PATH', join(dir, 'test.db'));
    vi.resetModules();
    db = await import('../db.js');
    await db.initDb();
    ({ processSingleDeck } = await import('./notificationScheduler.js'));
    const { refreshArchidektDeck } = await import('./sourceSync.js');
    db.run("INSERT INTO users (username, password_hash) VALUES ('u', 'h')");
    db.run("INSERT INTO tracked_owners (user_id, archidekt_username) VALUES (1, 'u')");
    db.run(`INSERT INTO tracked_decks
      (id, user_id, tracked_owner_id, archidekt_deck_id, deck_name, discord_webhook_url, price_alert_threshold,
       price_alert_baseline, last_known_price, last_known_budget_price)
      VALUES (1, 1, 1, 42, 'Test deck', 'https://discord.invalid/fixture', 5, 40, 40, 40)`);
    deck = db.get('SELECT * FROM tracked_decks WHERE id = 1');
    const deckText = '1 Rat Colony\n1 Relentless Rats';
    const snapshotId = db.run('INSERT INTO deck_snapshots (tracked_deck_id, deck_text) VALUES (?, ?)', [1, deckText]).lastInsertRowid;
    refreshArchidektDeck.mockResolvedValue({ changed: true, deckText, sourceSync: { currentSnapshotId: String(snapshotId) } });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('keeps the last total and alert baseline when one card has no price', async () => {
    const transport = vi.fn(async (url) => url.startsWith('https://api.scryfall.com')
      ? Response.json({ data: [{ name: 'Rat Colony', prices: { usd: '10.00' } }] })
      : new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', transport);
    await processSingleDeck(deck);

    expect(db.get('SELECT last_known_price, price_alert_baseline FROM tracked_decks WHERE id = 1'))
      .toEqual({ last_known_price: 40, price_alert_baseline: 40 });
    expect(db.all('SELECT notification_type FROM notification_log'))
      .toEqual([{ notification_type: 'deck_change' }]);
    expect(transport.mock.calls.filter(([url]) => url.startsWith('https://discord.invalid'))).toHaveLength(1);
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


describe('Proxy Balboa Discord messages', () => {
  let transport;

  beforeEach(() => {
    transport = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', transport);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('puts the deck and event before the voice, with complete details, a direct link and no implicit pings', async () => {
    expect(await sendDiscordWebhook('https://discord.invalid/fixture', '@everyone deck', '["Commander"]', {
      added: ['1 Sol Ring'], removed: ['2 Island'], changed: ['Plains (+2)'],
    }, 42)).toBe(true);
    const payload = JSON.parse(transport.mock.calls[0][1].body);
    expect(payload.username).toBe('Proxy Balboa');
    const [headline, voice] = payload.content.split('\n');
    expect(headline).toBe('Deck updated · @\u200beveryone deck');
    expect(voice).toContain("Figured I oughta tell ya, y'know?");
    expect(payload.content).not.toMatch(/champ|round/i);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0].title).toBe('Deck Updated: @everyone deck');
    expect(payload.embeds[0].description).toBe('**Commander** has a new saved version. Review the changes below or open the deck in CLC.');
    expect(payload.embeds[0].description).not.toContain('Archidekt');
    expect(payload.embeds[0].fields.map(field => [field.name, field.value])).toEqual([
      ['Cards In (+1)', '1 Sol Ring'], ['Cards Out (-1)', '2 Island'], ['Qty Changed (~1)', 'Plains (+2)'],
    ]);
    expect(payload.embeds[0].url).toMatch(/#library\/42$/);
  });

  it.each([
    { current: 125, delta: 25, direction: 'increased', mode: 'cheapest', modeLabel: 'cheapest printings', signed: '+$25.00' },
    { current: 75, delta: -25, direction: 'decreased', mode: 'specific', modeLabel: 'your printings', signed: '$-25.00' },
  ])('puts the exact $direction price movement before the voice', async ({ current, delta, direction, mode, modeLabel, signed }) => {
    expect(await sendPriceAlertWebhook('https://discord.invalid/fixture', 'Sauron', '[]', current, 100, delta, mode, 9)).toBe(true);
    const payload = JSON.parse(transport.mock.calls[0][1].body);
    expect(payload.username).toBe('Proxy Balboa');
    const [headline, voice] = payload.content.split('\n');
    expect(headline).toBe(`Deck price ${direction} by $25.00 · Sauron`);
    expect(voice).toBe("Hey, the numbers changed on us. I got 'em right here for ya.");
    expect(payload.content).not.toMatch(/champ|round/i);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0].description).toContain(`${direction} by **$25.00** (${modeLabel})`);
    expect(payload.embeds[0].fields.map(field => field.value)).toEqual(['$100.00', `$${current.toFixed(2)}`, signed]);
    expect(payload.embeds[0].url).toMatch(/#library\/9$/);
  });

  it('states when card details are unavailable and retains the library fallback', async () => {
    expect(await sendDiscordWebhook('https://discord.invalid/fixture', 'Sauron', '[]', null)).toBe(true);
    const payload = JSON.parse(transport.mock.calls[0][1].body);
    expect(payload.embeds[0].description).toBe('**Sauron** has a new saved version. Card-level details are unavailable; open the deck in CLC to review it.');
    expect(payload.embeds[0].fields).toBeUndefined();
    expect(payload.embeds[0].url).toMatch(/#library$/);
  });

  it.each([undefined, 0, -1, 2.5, Number.MAX_SAFE_INTEGER + 1, '9', '9?redirect=https://example.invalid'])('does not interpolate invalid deck ID %s into the price alert link', async (deckId) => {
    expect(await sendPriceAlertWebhook('https://discord.invalid/fixture', 'Sauron', '[]', 125, 100, 25, 'specific', deckId)).toBe(true);
    const payload = JSON.parse(transport.mock.calls[0][1].body);
    expect(payload.embeds[0].url).toMatch(/#library$/);
  });

  it('keeps unusual deck names from becoming extra push-preview lines or message markup', async () => {
    const deckName = 'Deck\n@everyone <@123> **extra**';
    expect(await sendDiscordWebhook('https://discord.invalid/fixture', deckName, '[]', null, 1)).toBe(true);
    const payload = JSON.parse(transport.mock.calls[0][1].body);
    expect(payload.content.split('\n')).toHaveLength(2);
    expect(payload.content.split('\n')[0]).toBe('Deck updated · Deck @\u200beveryone ‹@\u200b123› \\*\\*extra\\*\\*');
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0].url).toMatch(/#library\/1$/);
  });
});
