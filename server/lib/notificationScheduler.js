import { all, get, run } from '../db.js';
import { fetchDeck } from './archidekt.js';
import { archidektToText } from './deckToText.js';
import { enrichDeckText } from './enrichDeckText.js';
import { pruneSnapshots } from './pruneSnapshots.js';
import { isEmailConfigured, sendEmail, getAppUrl } from './email.js';

let intervalHandle = null;

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
           u.email, u.username, d.commanders, d.discord_webhook_url
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

      // Changes detected — create snapshot
      run('INSERT INTO deck_snapshots (tracked_deck_id, deck_text) VALUES (?, ?)', [deck.id, enrichedText]);
      pruneSnapshots(deck.id);

      const cmdsJson = commanders && commanders.length > 0 ? JSON.stringify(commanders) : null;
      if (cmdsJson) {
        run('UPDATE tracked_decks SET last_refreshed_at = datetime("now"), deck_name = ?, commanders = ?, last_notified_at = datetime("now") WHERE id = ?',
          [apiData.name || deck.deck_name, cmdsJson, deck.id]);
      } else {
        run('UPDATE tracked_decks SET last_refreshed_at = datetime("now"), deck_name = ?, last_notified_at = datetime("now") WHERE id = ?',
          [apiData.name || deck.deck_name, deck.id]);
      }

      // Send notification email (if email notifications enabled and email configured)
      if (deck.notify_on_change && deck.email && isEmailConfigured()) {
        await sendDeckChangeEmail(deck.email, deck.username, deck.deck_name, deck.id);
      }

      // Send Discord webhook notification
      if (deck.discord_webhook_url) {
        await sendDiscordWebhook(deck.discord_webhook_url, deck.deck_name, deck.commanders);
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

async function sendDiscordWebhook(webhookUrl, deckName, commandersJson) {
  try {
    let commanders = [];
    try { commanders = commandersJson ? JSON.parse(commandersJson) : []; } catch { /* ignore */ }
    const cmdLabel = commanders.length > 0 ? commanders.join(' / ') : deckName;
    const appUrl = getAppUrl();

    const body = {
      embeds: [{
        title: `Deck Updated: ${deckName}`,
        description: `**${cmdLabel}** has been updated on Archidekt. A new snapshot has been saved.`,
        color: 0x3b82f6,
        footer: { text: 'Card List Compare' },
        timestamp: new Date().toISOString(),
        ...(appUrl ? { url: `${appUrl}#settings` } : {}),
      }],
    };

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`[Discord] Webhook failed (${res.status}) for deck "${deckName}"`);
    }
  } catch (err) {
    console.error(`[Discord] Webhook error for deck "${deckName}":`, err.message);
  }
}

async function sendDeckChangeEmail(email, username, deckName, deckId) {
  const appUrl = getAppUrl();
  const settingsUrl = `${appUrl}#settings`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #333;">Deck Updated</h2>
      <p>Hi ${username},</p>
      <p>Your tracked deck <strong>${deckName}</strong> has changed on Archidekt.</p>
      <p>A new snapshot has been saved automatically. View the timeline to see what changed.</p>
      <p>
        <a href="${settingsUrl}" style="display: inline-block; padding: 12px 24px; background: #3b82f6; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600;">
          View Timeline
        </a>
      </p>
      <p style="color: #666; font-size: 13px;">You're receiving this because you enabled notifications for this deck. You can turn them off in your <a href="${settingsUrl}">Settings</a>.</p>
      <p style="color: #999; font-size: 11px;">Card List Compare</p>
    </div>
  `;
  return sendEmail(email, `Deck Updated: ${deckName}`, html);
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
      scheduleNext(); // Re-schedule with potentially updated interval
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
