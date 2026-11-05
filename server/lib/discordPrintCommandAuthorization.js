/** Reauthorize a queued Discord request without trusting client-supplied origin flags. */
import { createHash } from 'node:crypto';
import { get } from '../db.js';

export const DISCORD_PRINT_SETTINGS_KEY = 'discord_print_bot';
export function discordPrintRequestKey(interactionId) {
  const hash = createHash('sha256').update(`CLC Discord interaction:${interactionId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function discordPrintCommandRejection(command) {
  // Other station commands and older databases have no Discord origin record.
  if (!get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'discord_print_interactions'")) return null;
  const interaction = get('SELECT application_id, settings_revision FROM discord_print_interactions WHERE command_request_key = ? AND requester_id = ?', [command.request_key, command.requester_id]);
  if (!interaction) return null;
  let settings;
  try { settings = JSON.parse(get('SELECT value FROM server_settings WHERE key = ?', [DISCORD_PRINT_SETTINGS_KEY])?.value || 'null'); } catch { settings = null; }
  const admin = get('SELECT is_admin, suspended FROM users WHERE id = ?', [command.requester_id]);
  if (!settings || settings.applicationId !== interaction.application_id || settings.revision !== interaction.settings_revision
    || settings.clcUserId !== command.requester_id || !admin?.is_admin || admin.suspended) {
    return 'Discord command connection or linked administrator authorization changed';
  }
  return null;
}
