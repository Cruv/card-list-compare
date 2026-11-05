/** Discord-only settings: the browser and receipt history never receive the webhook. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printError } from './printQueuePlan.js';

export function discordUserId(value) {
  if (typeof value !== 'string' || (value !== '' && (!/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) >= 2n ** 64n))) {
    throw printError('Discord user ID must be empty or a valid numeric user ID');
  }
  return value;
}
export function discordSettings(body) {
  if (typeof body.enabled !== 'boolean') throw printError('Discord enabled must be true or false');
  const userId = discordUserId(body.userId);
  const url = body.webhookUrl;
  const match = typeof url === 'string' && /^https:\/\/discord\.com\/api\/webhooks\/([1-9][0-9]{0,19})\/[A-Za-z0-9_-]{1,256}$/.exec(url);
  if (body.enabled ? !match || BigInt(match[1]) >= 2n ** 64n : url !== '' || userId !== '') {
    throw printError('Use a canonical https://discord.com/api/webhooks/id/token URL, or empty settings to disconnect');
  }
  return { enabled: body.enabled, webhookUrl: url, userId };
}

function encryptionKey(create) {
  const directory = dirname(process.env.DB_PATH || fileURLToPath(new URL('../data/cardlistcompare.db', import.meta.url)));
  const path = join(directory, '.print-station-notifications-key');
  let fd;
  try {
    if (create) {
      mkdirSync(directory, { recursive: true });
      try {
        fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        writeFileSync(fd, randomBytes(32)); fsyncSync(fd); closeSync(fd); fd = undefined;
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Private key permissions');
    const key = readFileSync(fd);
    if (key.length !== 32) throw new Error('Invalid key');
    return key;
  } catch {
    throw printError('Discord settings encryption key is unavailable; check the private key beside the database', 503);
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function sealDiscordUrl(url, commandId) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(true), iv);
  cipher.setAAD(Buffer.from('CLC Discord command:' + commandId));
  const ciphertext = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(item => item.toString('base64')).join('.');
}
export function openDiscordUrl(value, commandId) {
  try {
    const pieces = value.split('.').map(item => Buffer.from(item, 'base64'));
    if (pieces.length !== 3 || pieces[0].length !== 12 || pieces[1].length !== 16) throw new Error('Invalid ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(false), pieces[0]);
    decipher.setAAD(Buffer.from('CLC Discord command:' + commandId)); decipher.setAuthTag(pieces[1]);
    return Buffer.concat([decipher.update(pieces[2]), decipher.final()]).toString('utf8');
  } catch { throw printError('Saved Discord settings could not be decrypted; reconnect Discord from Print Station', 503); }
}
export function discordTelemetry(value) {
  if (value == null) return { supported: false, configured: false, managed: false, revision: null, userId: '', lastTest: null };
  const validRevision = revision => typeof revision === 'string' && /^(?:local|[a-zA-Z0-9][a-zA-Z0-9_-]{7,127})$/.test(revision);
  if (typeof value !== 'object' || Array.isArray(value)
    || ['supported', 'configured', 'managed'].some(key => typeof value[key] !== 'boolean')
    || (value.revision !== null && !validRevision(value.revision))) throw printError('Invalid Discord notification status');
  const userId = discordUserId(value.userId);
  let lastTest = null;
  if (value.lastTest != null) {
    const test = value.lastTest;
    if (!test || !validRevision(test.commandId) || !validRevision(test.revision)
      || !['confirmed', 'unconfirmed'].includes(test.status) || typeof test.at !== 'string'
      || test.at.length > 40 || !Number.isFinite(Date.parse(test.at))) throw printError('Invalid Discord test status');
    lastTest = { commandId: test.commandId, revision: test.revision, status: test.status, at: new Date(test.at).toISOString() };
  }
  return { supported: value.supported, configured: value.configured, managed: value.managed, revision: value.revision, userId, lastTest };
}
