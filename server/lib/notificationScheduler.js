import { all, get, run } from '../db.js';
import { fetchDeck } from './archidekt.js';
import { archidektToText } from './deckToText.js';
import { enrichDeckText } from './enrichDeckText.js';
import { pruneSnapshots } from './pruneSnapshots.js';
import { isEmailConfigured, sendEmail, getAppUrl } from './email.js';
import { parse } from '../../src/lib/parser.js';
import { computeDiff } from '../../src/lib/differ.js';

let intervalHandle = null;

const MAX_CARDS_PER_SECTION = 8;

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
        await sendDeckChangeEmail(deck.email, deck.username, deck.deck_name, deck.id, changeSummary);
      }

      // Send Discord webhook notification
      if (deck.discord_webhook_url) {
        await sendDiscordWebhook(deck.discord_webhook_url, deck.deck_name, deck.commanders, changeSummary);
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
    }
  } catch (err) {
    console.error(`[Discord] Webhook error for deck "${deckName}":`, err.message);
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
        run('UPDATE tracked_decks SET last_refreshed_at = datetime("now") WHERE id = ?', [deck.id]);
      } else {
        run('INSERT INTO deck_snapshots (tracked_deck_id, deck_text) VALUES (?, ?)', [deck.id, enrichedText]);
        pruneSnapshots(deck.id);
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
