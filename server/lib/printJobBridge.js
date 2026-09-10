import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, statSync, realpathSync, existsSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { get, run, transaction } from '../db.js';
import { BridgeError, cardIdentity, listQueue, remote, artworkCard, connectionFor } from './manasyncBridge.js';
import { ownedPrintManifest, PRINT_JOBS_DIR, assertPrintStorageCapacity } from './printQueue.js';
import { imageFormat, MAX_IMAGE_BYTES } from './imageValidation.js';
import { MAX_PRINT_COPIES } from './printQueuePlan.js';

const dataDir = dirname(process.env.DB_PATH || fileURLToPath(new URL('../data/cardlistcompare.db', import.meta.url)));
export const BRIDGE_ARTWORK_DIR = join(dataDir, 'manasync-artwork');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const mime = format => format === 'png' ? 'image/png' : 'image/jpeg';
const fail = (message, status = 409) => { throw new BridgeError(message, status); };

function deterministicId(userId, jobId, key) {
  const bytes = createHash('sha256').update(JSON.stringify(['clc-print-art-v1', userId, jobId, key])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // UUIDv8: deterministic application-defined identity.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function imageRecord(image, face) {
  if (!image || !/^[a-f0-9]{64}$/.test(image.sha256) || !['png', 'jpg'].includes(image.format)
    || !Number.isSafeInteger(image.size) || image.size < 1 || image.size > MAX_IMAGE_BYTES
    || !['scryfall', 'saved-mpc'].includes(image.source) || typeof image.identifier !== 'string'
    || image.identifier.length > 200 || image.face !== face) fail('The print manifest contains invalid source artwork.');
  return { sha256: image.sha256, size: image.size, format: image.format, source: image.source, identifier: image.identifier };
}

function verifiedBytes(path, image) {
  let size;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) fail('Saved print artwork is not a regular image.');
    size = stat.size;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    fail('Saved print artwork is missing. Retain its source files before native print expiry.', 410);
  }
  if (size !== image.size || size > MAX_IMAGE_BYTES) fail('Saved print artwork size no longer matches its immutable manifest.');
  const bytes = readFileSync(path);
  if (hash(bytes) !== image.sha256 || imageFormat(bytes) !== image.format) fail('Saved print artwork checksum or image verification failed.');
  return bytes;
}

function retainedPath(userId, image) {
  if (!Number.isSafeInteger(userId) || userId < 1 || !/^[a-f0-9]{64}$/.test(image.sha256) || !['png','jpg'].includes(image.format)) {
    fail('Invalid retained artwork identity.');
  }
  return join(BRIDGE_ARTWORK_DIR, String(userId), `${image.sha256}.${image.format}`);
}

function retainImage(userId, jobId, original) {
  const image = imageRecord(original, original.face);
  const target = retainedPath(userId, image);
  if (existsSync(target)) { verifiedBytes(target, image); return; }
  const root = resolve(PRINT_JOBS_DIR, jobId);
  const source = typeof original.fileName === 'string' ? resolve(root, original.fileName) : '';
  if (!source.startsWith(root + sep)) fail('Invalid source artwork path in the print manifest.');
  let actual;
  try { actual = realpathSync(source); }
  catch { fail('Native print artwork has expired or is missing. Stage it before expiring the print job.', 410); }
  if (!actual.startsWith(realpathSync(root) + sep)) fail('Source artwork escapes its print job directory.');
  const bytes = verifiedBytes(actual, image);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp`;
  try {
    const fd = openSync(temporary, 'w', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
}

/** Freeze actual native-job faces before expiry; this only stages confirmation plans. */
export function stagePrintJob(userId, jobId) {
  const job = get('SELECT * FROM print_jobs WHERE id = ? AND user_id = ?', [jobId, userId]);
  if (!job) fail('Print job not found.', 404);
  const manifest = ownedPrintManifest(userId, job.tracked_deck_id, jobId);
  if (manifest.jobId !== jobId || manifest.requesterId !== userId || !Array.isArray(manifest.copies)
    || !manifest.copies.length || manifest.copies.length > MAX_PRINT_COPIES
    || manifest.copies.length !== manifest.plan?.totalCopies) fail('Print manifest copies do not match this owned print job.');
  const groups = new Map();
  for (const copy of manifest.copies) {
    const front = imageRecord(copy.front, 'front');
    const back = copy.back ? imageRecord(copy.back, 'back') : null;
    const card = cardIdentity({ name: copy.displayName, setCode: copy.setCode, collectorNumber: copy.collectorNumber,
      scryfallId: uuid(copy.scryfallId) ? copy.scryfallId : copy.front.source === 'scryfall' && uuid(copy.front.identifier) ? copy.front.identifier : null,
      oracleId: uuid(copy.oracleId) ? copy.oracleId : null, finish: 'nonfoil', language: 'en' });
    const key = JSON.stringify([card, front.sha256, back?.sha256 || null]);
    const previous = groups.get(key);
    if (previous) previous.quantity += 1;
    else groups.set(key, { id: deterministicId(userId, jobId, key), card, quantity: 1,
      artwork: { jobId, manifestSha256: job.manifest_sha256, front, ...(back ? { back } : {}) },
      originals: [copy.front, ...(copy.back ? [copy.back] : [])] });
  }
  const staged = [...groups.values()];
  const missing = new Map();
  for (const item of staged) for (const original of item.originals) {
    const target = retainedPath(userId,original);
    if (!existsSync(target)) missing.set(target,original.size);
  }
  if (missing.size) assertPrintStorageCapacity([...missing.values()].reduce((sum,bytes) => sum+bytes,0));
  let replayed = true;
  // Image writes precede the DB commit. A failure can leave harmless hash-addressed
  // files, but cannot publish queue rows pointing at partially copied artwork.
  for (const item of staged) {
    const previous = get('SELECT * FROM manasync_print_items WHERE id = ?', [item.id]);
    if (previous) {
      if (previous.user_id !== userId || previous.print_job_id !== jobId || previous.card_json !== JSON.stringify(item.card)
        || previous.quantity !== item.quantity || previous.artwork_json !== JSON.stringify(item.artwork)) fail('This print job staging identity conflicts with an existing queue item.');
    } else replayed = false;
    for (const original of item.originals) retainImage(userId, jobId, original);
  }
  transaction(() => {
    const deck = get('SELECT id FROM tracked_decks WHERE id = ? AND user_id = ?', [job.tracked_deck_id, userId]);
    for (const item of staged) {
      run(`INSERT OR IGNORE INTO manasync_print_items
        (id,user_id,deck_id,card_json,quantity,created_at,print_job_id,artwork_json) VALUES (?,?,?,?,?,?,?,?)`,
      [item.id,userId,deck?.id || null,JSON.stringify(item.card),item.quantity,new Date().toISOString(),jobId,JSON.stringify(item.artwork)]);
      // Previously confirmed native batches keep their original acquisition outbox.
      // Publishing them again as new plans would allow the same copies to be counted twice.
      if (!get('SELECT id FROM manasync_print_operations WHERE item_id=? AND pending_id IS NULL',[item.id])) {
        const previous = get('SELECT cancelled FROM manasync_print_items WHERE id=?',[item.id]);
        run(`INSERT OR IGNORE INTO manasync_pending_proxy_plans(item_id,user_id,status,created_at) VALUES (?,?,?,?)`,
          [item.id,userId,previous.cancelled ? 'dismissed' : 'local',new Date().toISOString()]);
      }
    }
  });
  return { jobId, manifestSha256: job.manifest_sha256, replayed,
    items: listQueue(userId).filter(item => item.printJobId === jobId) };
}

export function ownedQueueArtwork(userId, itemId, face) {
  if (!['front','back'].includes(face)) fail('Artwork face not found.', 404);
  const item = get('SELECT * FROM manasync_print_items WHERE id = ? AND user_id = ?', [itemId,userId]);
  const image = item?.artwork_json && JSON.parse(item.artwork_json)[face];
  if (!image) fail('Artwork not found.', 404);
  const path = retainedPath(userId, image);
  const bytes = verifiedBytes(path, image);
  return { bytes, contentType: mime(image.format), sha256: image.sha256 };
}

/** Replay content-addressed uploads before replaying the original acquire bytes. */
export async function uploadOperationArtwork(operation) {
  const payload = JSON.parse(operation.payload_json);
  const requested = payload.command?.input?.card?.proxyArtwork;
  if (!requested) return;
  const item = get('SELECT * FROM manasync_print_items WHERE id = ? AND user_id = ?', [operation.item_id,operation.user_id]);
  if (!item?.artwork_json || JSON.stringify(artworkCard(item, operation.account_id).proxyArtwork) !== JSON.stringify(requested)) {
    fail('The operation artwork differs from its frozen print job. Keep this confirmation for review.');
  }
  const uploaded = new Set();
  for (const face of ['front','back']) {
    if (!requested[face]) continue;
    const image = JSON.parse(item.artwork_json)[face];
    if (uploaded.has(image.sha256)) continue;
    const connection = connectionFor(operation.user_id);
    if (!connection?.connected || connection.actor_id !== operation.actor_id || connection.account_id !== operation.account_id || connection.base_url !== operation.base_url) {
      fail('Connection changed during artwork upload. Reconnect the original account before retrying this confirmation.');
    }
    const bytes = verifiedBytes(retainedPath(operation.user_id, image), image);
    let response;
    try { response = await remote(operation, `/api/v1/proxy-art/${image.sha256}`, { method: 'PUT', body: bytes, contentType: mime(image.format) }); }
    catch (error) {
      if ([404,405].includes(error.status)) throw new BridgeError('ManaSync does not support proxy artwork uploads. Update ManaSync, then retry this original confirmation.', 503);
      throw error;
    }
    if (response.sha256 !== image.sha256 || response.url !== requested[face] || response.contentType !== mime(image.format) || response.bytes !== image.size) {
      fail('ManaSync returned an invalid proxy artwork receipt; acquisition was not sent.', 502);
    }
    uploaded.add(image.sha256);
  }
}
