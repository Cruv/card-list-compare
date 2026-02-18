import { all, get, run } from '../db.js';
import { fetchDeck } from './archidekt.js';
import { archidektToText } from './deckToText.js';
import { enrichDeckText } from './enrichDeckText.js';
import { pruneSnapshots } from './pruneSnapshots.js';
import { isEmailConfigured, sendEmail, getAppUrl } from './email.js';
import { parse } from '../../src/lib/parser.js';
import { computeDiff } from '../../src/lib/differ.js';
import { computeDeckPrices } from './priceCalculator.js';

let intervalHandle = null;

const MAX_CARDS_PER_SECTION = 8;
const MAX_EMAILS_PER_HOUR = 10; // per user

/**
 * Build a human-readable change summary from a diff result.
 * Returns { added: ['2x Lightning Bolt', ...], removed: [...], changed: [...] }
 */
function buildChangeSummary(diff) {
  const added = [];
  const removed = [];
  const changed = [];

  for (const section of [diff.mainboard, diff.sideboard]) {
    for (const card of section.cardsIn) {
      added.push(`${card.quantity}x ${card.name}`);
    }
    for (const card of section.cardsOut) {
      removed.push(`${card.quantity}x ${card.name}`);
    }
    for (const card of section.quantityChanges) {
      if (card.delta > 0) {
        changed.push(`${card.name} (+${card.delta})`);
      } else {
        changed.push(`${card.name} (${card.delta})`);
      }
    }
  }

  return { added, removed, changed };
}

function truncateList(items, max = MAX_CARDS_PER_SECTION) {
  if (items.length <= max) return items;
  const shown = items.slice(0, max);
  shown.push(`…and ${items.length - max} more`);
  return shown;
}

/**
 * Check if a user has exceeded the email rate limit.
 * Returns true if under the limit (OK to send), false if rate-limited.
 */
function canSendEmail(userId) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = get(
    `SELECT COUNT(*) as count FROM notification_log
     WHERE user_id = ? AND channel = 'email' AND created_at > ?`,
    [userId, oneHourAgo]
  );
  return (row?.count || 0) < MAX_EMAILS_PER_HOUR;
}

/**
 * Log a notification to the notification_log table.
 */
function logNotification(userId, deckId, type, channel, subject, details) {
  run(
    `INSERT INTO notification_log (user_id, tracked_deck_id, notification_type, channel, subject, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, deckId, type, channel, subject || null, typeof details === 'string' ? details : JSON.stringify(details)]
  );
}

/**
 * Check all decks with notifications enabled for changes.
 * For each deck that has changed, create a snapshot and send an email.
 */
async function checkDecksForChanges() {
  // Check global setting
  const enabled = get("SELECT value FROM server_settings WHERE key = 'notifications_enabled'");
  if (enabled?.value === 'false') return;

  // Get all decks with notifications enabled (email or Discord webhook)
  const decks = all(`
    SELECT d.id, d.archidekt_deck_id, d.deck_name, d.user_id,
           u.email, u.username, d.commanders, d.discord_webhook_url,
           d.last_known_price, d.last_known_budget_price,
           d.price_alert_threshold, d.price_alert_mode, d.notify_on_change
    FROM tracked_decks d
    JOIN users u ON d.user_id = u.id
    WHERE u.suspended = 0
      AND (
        (d.notify_on_change = 1 AND u.email IS NOT NULL AND u.email != '' AND u.email_verified = 1)
        OR (d.discord_webhook_url IS NOT NULL AND d.discord_webhook_url != '')
      )
  `);

  if (decks.length === 0) return;

  console.log(`[Notifications] Checking ${decks.length} decks for changes...`);
  let changed = 0;
  let errors = 0;

  for (const deck of decks) {
    try {
      const apiData = await fetchDeck(deck.archidekt_deck_id);
      const { text, commanders } = archidektToText(apiData);

      const latest = get(
        'SELECT deck_text FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at DESC LIMIT 1',
        [deck.id]
      );

      let enrichedText = text;
      try { enrichedText = await enrichDeckText(text, latest?.deck_text || null); } catch { /* non-fatal */ }

      if (latest && latest.deck_text === enrichedText) {
        // No changes — update last_refreshed_at only
        run('UPDATE tracked_decks SET last_refreshed_at = datetime("now") WHERE id = ?', [deck.id]);
        continue;
      }

      // Changes detected — compute structured diff for card-level detail
      let changeSummary = null;
      try {
        if (latest?.deck_text) {
          const parsedBefore = parse(latest.deck_text);
          const parsedAfter = parse(enrichedText);
          const diff = computeDiff(parsedBefore, parsedAfter);
          changeSummary = buildChangeSummary(diff);
        }
      } catch {
        // Non-fatal — fall back to generic notification
      }

      // Create snapshot
      run('INSERT INTO deck_snapshots (tracked_deck_id, deck_text) VALUES (?, ?)', [deck.id, enrichedText]);
      pruneSnapshots(deck.id);

      // Auto-stamp prices on new snapshot (non-fatal)
      let priceResult = null;
      try { priceResult = await computeDeckPrices(deck.id, enrichedText); } catch { /* Scryfall may be down */ }

      const cmdsJson = commanders && commanders.length > 0 ? JSON.stringify(commanders) : null;
      if (cmdsJson) {
        run('UPDATE tracked_decks SET last_refreshed_at = datetime("now"), deck_name = ?, commanders = ?, last_notified_at = datetime("now") WHERE id = ?',
          [apiData.name || deck.deck_name, cmdsJson, deck.id]);
      } else {
        run('UPDATE tracked_decks SET last_refreshed_at = datetime("now"), deck_name = ?, last_notified_at = datetime("now") WHERE id = ?',
          [apiData.name || deck.deck_name, deck.id]);
      }

      // Send deck change notification email (if email notifications enabled and email configured)
      if (deck.notify_on_change && deck.email && isEmailConfigured() && canSendEmail(deck.user_id)) {
        const sent = await sendDeckChangeEmail(deck.email, deck.username, deck.deck_name, deck.id, changeSummary);
        if (sent) {
          logNotification(deck.user_id, deck.id, 'deck_change', 'email',
            `Deck Updated: ${deck.deck_name}`,
            changeSummary ? { added: changeSummary.added.length, removed: changeSummary.removed.length, changed: changeSummary.changed.length } : null
          );
        }
      }

      // Send Discord webhook notification
      if (deck.discord_webhook_url) {
        const sent = await sendDiscordWebhook(deck.discord_webhook_url, deck.deck_name, deck.commanders, changeSummary);
        if (sent) {
          logNotification(deck.user_id, deck.id, 'deck_change', 'discord',
            `Deck Updated: ${deck.deck_name}`,
            changeSummary ? { added: changeSummary.added.length, removed: changeSummary.removed.length, changed: changeSummary.changed.length } : null
          );
        }
      }

      // Check price alert threshold
      if (priceResult && deck.price_alert_threshold) {
        await checkPriceAlert(deck, priceResult);
      }

      changed++;

      // Rate-limit: small delay between Archidekt API calls
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`[Notifications] Failed to check deck ${deck.id}:`, err.message);
      errors++;
    }
  }

  if (changed > 0 || errors > 0) {
    console.log(`[Notifications] Done: ${changed} changed, ${errors} errors out of ${decks.length} decks`);
  }
}

/**
 * Check if a deck's price change exceeds its alert threshold and send notifications.
 */
async function checkPriceAlert(deck, priceResult) {
  const previousPrice = deck.last_known_price;
  if (previousPrice == null || previousPrice === 0) return; // No baseline to compare

  const mode = deck.price_alert_mode || 'specific';
  const currentPrice = mode === 'cheapest' ? priceResult.budgetPrice : priceResult.totalPrice;
  const prevPrice = mode === 'cheapest' ? (deck.last_known_budget_price ?? previousPrice) : previousPrice;

  const delta = currentPrice - prevPrice;
  if (Math.abs(delta) < deck.price_alert_threshold) return; // Under threshold

  const direction = delta > 0 ? 'increased' : 'decreased';
  const subject = `Price Alert: ${deck.deck_name} ${direction} by $${Math.abs(delta).toFixed(2)}`;

  // Send email alert
  if (deck.notify_on_change && deck.email && isEmailConfigured() && canSendEmail(deck.user_id)) {
    const sent = await sendPriceAlertEmail(deck.email, deck.username, deck.deck_name, currentPrice, prevPrice, delta, mode);
    if (sent) {
      logNotification(deck.user_id, deck.id, 'price_alert', 'email', subject,
        { previousPrice: prevPrice, currentPrice, delta: Math.round(delta * 100) / 100, mode });
    }
  }

  // Send Discord webhook alert
  if (deck.discord_webhook_url) {
    const sent = await sendPriceAlertWebhook(deck.discord_webhook_url, deck.deck_name, deck.commanders, currentPrice, prevPrice, delta, mode);
    if (sent) {
      logNotification(deck.user_id, deck.id, 'price_alert', 'discord', subject,
        { previousPrice: prevPrice, currentPrice, delta: Math.round(delta * 100) / 100, mode });
    }
  }
}

async function sendPriceAlertEmail(email, username, deckName, currentPrice, previousPrice, delta, mode) {
  const appUrl = getAppUrl();
  const libraryUrl = `${appUrl}#library`;
  const direction = delta > 0 ? 'increased' : 'decreased';
  const directionColor = delta > 0 ? '#f44336' : '#4caf50';
  const modeLabel = mode === 'cheapest' ? 'cheapest printings' : 'your printings';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #333;">Price Alert</h2>
      <p>Hi ${username},</p>
      <p>Your tracked deck <strong>${deckName}</strong> has ${direction} in value.</p>
      <div style="background: #f8f9fa; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px 16px; margin: 16px 0;">
        <div style="margin-bottom: 8px;">
          <strong>Previous:</strong> $${previousPrice.toFixed(2)}
        </div>
        <div style="margin-bottom: 8px;">
          <strong>Current:</strong> $${currentPrice.toFixed(2)}
        </div>
        <div style="color: ${directionColor}; font-weight: 600; font-size: 16px;">
          ${delta > 0 ? '+' : ''}$${delta.toFixed(2)} (${modeLabel})
        </div>
      </div>
      <p>
        <a href="${libraryUrl}" style="display: inline-block; padding: 12px 24px; background: #3b82f6; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600;">
          View Deck
        </a>
      </p>
      <p style="color: #666; font-size: 13px;">You're receiving this because you set a price alert for this deck. You can change the threshold in your <a href="${libraryUrl}">Deck Library</a>.</p>
      <p style="color: #999; font-size: 11px;">Card List Compare</p>
    </div>
  `;
  return sendEmail(email, `Price Alert: ${deckName} ${direction} by $${Math.abs(delta).toFixed(2)}`, html);
}

async function sendPriceAlertWebhook(webhookUrl, deckName, commandersJson, currentPrice, previousPrice, delta, mode) {
  try {
    const appUrl = getAppUrl();
    const direction = delta > 0 ? 'increased' : 'decreased';
    const modeLabel = mode === 'cheapest' ? 'cheapest printings' : 'your printings';
    const color = delta > 0 ? 0xf44336 : 0x4caf50;

    const body = {
      embeds: [{
        title: `Price Alert: ${deckName}`,
        description: `Deck value has ${direction} by **$${Math.abs(delta).toFixed(2)}** (${modeLabel}).`,
        color,
        fields: [
          { name: 'Previous', value: `$${previousPrice.toFixed(2)}`, inline: true },
          { name: 'Current', value: `$${currentPrice.toFixed(2)}`, inline: true },
          { name: 'Change', value: `${delta > 0 ? '+' : ''}$${delta.toFixed(2)}`, inline: true },
        ],
        footer: { text: 'Card List Compare' },
        timestamp: new Date().toISOString(),
        ...(appUrl ? { url: `${appUrl}#library` } : {}),
      }],
    };

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`[Discord] Price alert webhook failed (${res.status}) for deck "${deckName}"`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[Discord] Price alert webhook error for deck "${deckName}":`, err.message);
    return false;
  }
}

async function sendDiscordWebhook(webhookUrl, deckName, commandersJson, changeSummary) {
  try {
    let commanders = [];
    try { commanders = commandersJson ? JSON.parse(commandersJson) : []; } catch { /* ignore */ }
    const cmdLabel = commanders.length > 0 ? commanders.join(' / ') : deckName;
    const appUrl = getAppUrl();

    const fields = [];
    if (changeSummary) {
      if (changeSummary.added.length > 0) {
        fields.push({
          name: `Cards In (+${changeSummary.added.length})`,
          value: truncateList(changeSummary.added).join('\n'),
          inline: true,
        });
      }
      if (changeSummary.removed.length > 0) {
        fields.push({
          name: `Cards Out (-${changeSummary.removed.length})`,
          value: truncateList(changeSummary.removed).join('\n'),
          inline: true,
        });
      }
      if (changeSummary.changed.length > 0) {
        fields.push({
          name: `Qty Changed (~${changeSummary.changed.length})`,
          value: truncateList(changeSummary.changed).join('\n'),
          inline: true,
        });
      }
    }

    const body = {
      embeds: [{
        title: `Deck Updated: ${deckName}`,
        description: changeSummary
          ? `**${cmdLabel}** has been updated on Archidekt.`
          : `**${cmdLabel}** has been updated on Archidekt. A new snapshot has been saved.`,
        color: 0x3b82f6,
        fields: fields.length > 0 ? fields : undefined,
        footer: { text: 'Card List Compare' },
        timestamp: new Date().toISOString(),
        ...(appUrl ? { url: `${appUrl}#library` } : {}),
      }],
    };

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`[Discord] Webhook failed (${res.status}) for deck "${deckName}"`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[Discord] Webhook error for deck "${deckName}":`, err.message);
    return false;
  }
}

async function sendDeckChangeEmail(email, username, deckName, deckId, changeSummary) {
  const appUrl = getAppUrl();
  const libraryUrl = `${appUrl}#library`;

  // Build card-level detail HTML if available
  let changeDetailHtml = '';
  if (changeSummary) {
    const sections = [];
    if (changeSummary.added.length > 0) {
      sections.push(`
        <div style="margin-bottom: 8px;">
          <strong style="color: #4caf50;">Added (${changeSummary.added.length}):</strong>
          <div style="color: #4caf50; font-size: 13px; padding-left: 8px;">${truncateList(changeSummary.added).join('<br>')}</div>
        </div>
      `);
    }
    if (changeSummary.removed.length > 0) {
      sections.push(`
        <div style="margin-bottom: 8px;">
          <strong style="color: #f44336;">Removed (${changeSummary.removed.length}):</strong>
          <div style="color: #f44336; font-size: 13px; padding-left: 8px;">${truncateList(changeSummary.removed).join('<br>')}</div>
        </div>
      `);
    }
    if (changeSummary.changed.length > 0) {
      sections.push(`
        <div style="margin-bottom: 8px;">
          <strong style="color: #ff9800;">Changed (${changeSummary.changed.length}):</strong>
          <div style="color: #ff9800; font-size: 13px; padding-left: 8px;">${truncateList(changeSummary.changed).join('<br>')}</div>
        </div>
      `);
    }
    if (sections.length > 0) {
      changeDetailHtml = `
        <div style="background: #f8f9fa; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px 16px; margin: 16px 0;">
          ${sections.join('')}
        </div>
      `;
    }
  }

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #333;">Deck Updated</h2>
      <p>Hi ${username},</p>
      <p>Your tracked deck <strong>${deckName}</strong> has changed on Archidekt.</p>
      ${changeDetailHtml || '<p>A new snapshot has been saved automatically.</p>'}
      <p>
        <a href="${libraryUrl}" style="display: inline-block; padding: 12px 24px; background: #3b82f6; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600;">
          View Timeline
        </a>
      </p>
      <p style="color: #666; font-size: 13px;">You're receiving this because you enabled notifications for this deck. You can turn them off in your <a href="${libraryUrl}">Deck Library</a>.</p>
      <p style="color: #999; font-size: 11px;">Card List Compare</p>
    </div>
  `;
  return sendEmail(email, `Deck Updated: ${deckName}`, html);
}

/**
 * Check price alerts for all decks with thresholds set.
 * Runs independently of deck change detection — catches market price shifts.
 */
async function checkPriceAlerts() {
  const enabled = get("SELECT value FROM server_settings WHERE key = 'notifications_enabled'");
  if (enabled?.value === 'false') return;

  const decks = all(`
    SELECT d.id, d.deck_name, d.user_id, d.commanders,
           d.last_known_price, d.last_known_budget_price,
           d.price_alert_threshold, d.price_alert_mode,
           d.notify_on_change, d.discord_webhook_url,
           u.email, u.username
    FROM tracked_decks d
    JOIN users u ON d.user_id = u.id
    WHERE u.suspended = 0
      AND d.price_alert_threshold IS NOT NULL
      AND d.price_alert_threshold > 0
      AND d.last_known_price IS NOT NULL
      AND (
        (d.notify_on_change = 1 AND u.email IS NOT NULL AND u.email != '' AND u.email_verified = 1)
        OR (d.discord_webhook_url IS NOT NULL AND d.discord_webhook_url != '')
      )
  `);

  if (decks.length === 0) return;

  let alerts = 0;

  for (const deck of decks) {
    const snap = get(
      'SELECT deck_text FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at DESC LIMIT 1',
      [deck.id]
    );
    if (!snap?.deck_text) continue;

    try {
      const previousPrice = deck.last_known_price;
      const previousBudgetPrice = deck.last_known_budget_price;

      const priceResult = await computeDeckPrices(deck.id, snap.deck_text);
      if (!priceResult) continue;

      const mode = deck.price_alert_mode || 'specific';
      const currentPrice = mode === 'cheapest' ? priceResult.budgetPrice : priceResult.totalPrice;
      const prevPrice = mode === 'cheapest' ? (previousBudgetPrice ?? previousPrice) : previousPrice;

      const delta = currentPrice - prevPrice;
      if (Math.abs(delta) < deck.price_alert_threshold) continue;

      await checkPriceAlert(deck, priceResult);
      alerts++;

      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`[PriceAlerts] Failed for deck ${deck.id}:`, err.message);
    }
  }

  if (alerts > 0) {
    console.log(`[PriceAlerts] ${alerts} alert(s) triggered`);
  }
}

/**
 * Auto-refresh decks that have auto_refresh_hours set.
 * Only refreshes decks whose last_refreshed_at is older than their interval.
 */
async function autoRefreshScheduledDecks() {
  const decks = all(`
    SELECT d.id, d.archidekt_deck_id, d.deck_name, d.auto_refresh_hours, d.last_refreshed_at
    FROM tracked_decks d
    JOIN users u ON d.user_id = u.id
    WHERE u.suspended = 0
      AND d.auto_refresh_hours IS NOT NULL
  `);

  if (decks.length === 0) return;

  let refreshed = 0;
  const now = Date.now();

  for (const deck of decks) {
    if (deck.last_refreshed_at) {
      const lastRefresh = new Date(deck.last_refreshed_at + 'Z').getTime();
      const intervalMs = deck.auto_refresh_hours * 60 * 60 * 1000;
      if (now - lastRefresh < intervalMs) continue;
    }

    try {
      const apiData = await fetchDeck(deck.archidekt_deck_id);
      const { text, commanders } = archidektToText(apiData);

      const latest = get(
        'SELECT deck_text FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at DESC LIMIT 1',
        [deck.id]
      );

      let enrichedText = text;
      try { enrichedText = await enrichDeckText(text, latest?.deck_text || null); } catch { /* non-fatal */ }

      if (latest && latest.deck_text === enrichedText) {
        // No changes — still stamp prices if snapshot has none yet
        try { await computeDeckPrices(deck.id, enrichedText); } catch { /* non-fatal */ }
        run('UPDATE tracked_decks SET last_refreshed_at = datetime("now") WHERE id = ?', [deck.id]);
      } else {
        run('INSERT INTO deck_snapshots (tracked_deck_id, deck_text) VALUES (?, ?)', [deck.id, enrichedText]);
        pruneSnapshots(deck.id);
        // Auto-stamp prices on new snapshot
        try { await computeDeckPrices(deck.id, enrichedText); } catch { /* non-fatal */ }
        const cmdsJson = commanders && commanders.length > 0 ? JSON.stringify(commanders) : null;
        if (cmdsJson) {
          run('UPDATE tracked_decks SET last_refreshed_at = datetime("now"), deck_name = ?, commanders = ? WHERE id = ?',
            [apiData.name || deck.deck_name, cmdsJson, deck.id]);
        } else {
          run('UPDATE tracked_decks SET last_refreshed_at = datetime("now"), deck_name = ? WHERE id = ?',
            [apiData.name || deck.deck_name, deck.id]);
        }
        refreshed++;
      }

      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`[AutoRefresh] Failed for deck ${deck.id}:`, err.message);
    }
  }

  if (refreshed > 0) {
    console.log(`[AutoRefresh] ${refreshed} deck(s) updated`);
  }
}

/**
 * Start the notification check scheduler.
 * Reads the interval from server_settings and runs on a setInterval.
 */
export function startNotificationScheduler() {
  if (intervalHandle) return; // Already running

  function getIntervalMs() {
    const setting = get("SELECT value FROM server_settings WHERE key = 'notification_check_interval_hours'");
    const hours = parseInt(setting?.value || '6', 10);
    return Math.max(1, hours) * 60 * 60 * 1000; // min 1 hour
  }

  function scheduleNext() {
    const ms = getIntervalMs();
    intervalHandle = setTimeout(async () => {
      try {
        await checkDecksForChanges();
      } catch (err) {
        console.error('[Notifications] Scheduler error:', err.message);
      }
      try {
        await autoRefreshScheduledDecks();
      } catch (err) {
        console.error('[AutoRefresh] Scheduler error:', err.message);
      }
      try {
        await checkPriceAlerts();
      } catch (err) {
        console.error('[PriceAlerts] Scheduler error:', err.message);
      }
      scheduleNext();
    }, ms);
  }

  console.log('[Notifications] Scheduler started');
  scheduleNext();
}

export function stopNotificationScheduler() {
  if (intervalHandle) {
    clearTimeout(intervalHandle);
    intervalHandle = null;
  }
}
