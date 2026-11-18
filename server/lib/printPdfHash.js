import crypto from 'node:crypto';
import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';

const fingerprint = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

export function printFileFingerprint(path) {
  const stat = lstatSync(path, { bigint: true });
  return stat.isFile() ? fingerprint(stat) : null;
}

export function openVerifiedPrintPdf(path, expectedFingerprint) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || fingerprint(stat) !== expectedFingerprint) {
      throw Object.assign(new Error('PDF artifact changed before streaming'), { code: 'ESTALE' });
    }
    return createReadStream(path, { fd });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function hashFile(path, expectedSize) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size !== BigInt(expectedSize)) return null;
    const hash = crypto.createHash('sha256');
    const bytes = Buffer.alloc(1024 * 1024);
    let count = 0, isPdf = false;
    while (count < expectedSize) {
      const read = readSync(fd, bytes, 0, Math.min(bytes.length, expectedSize - count), null);
      if (read === 0) return null;
      if (count === 0) isPdf = bytes.subarray(0, Math.min(read, 5)).equals(Buffer.from('%PDF-'));
      hash.update(bytes.subarray(0, read));
      count += read;
    }
    const key = fingerprint(stat);
    if (fingerprint(fstatSync(fd, { bigint: true })) !== key) return null;
    return { hash: hash.digest('hex'), isPdf, fingerprint: key };
  } finally { closeSync(fd); }
}

if (!isMainThread) parentPort.on('message', ({ path, expectedSize }) => {
  try { parentPort.postMessage({ result: hashFile(path, expectedSize) }); }
  catch (error) { parentPort.postMessage({ error: { message: error.message, code: error.code } }); }
});

// One reader bounds disk contention and chunk memory across generation, claims
// and downloads. Keep it warm across a job's artifacts and release it when idle.
let worker;
let idleTimer;
let pending = Promise.resolve();

async function verify(path, expectedSize) {
  clearTimeout(idleTimer);
  if (!worker) {
    worker = new Worker(new URL(import.meta.url), { execArgv: [] });
    const instance = worker;
    const forget = () => { if (worker === instance) worker = undefined; };
    instance.on('error', forget);
    instance.on('exit', forget);
  }
  const instance = worker;
  instance.ref();
  try {
    const message = await new Promise((resolve, reject) => {
      const cleanup = () => {
        instance.off('message', onMessage);
        instance.off('error', onError);
        instance.off('exit', onExit);
      };
      const onMessage = value => { cleanup(); resolve(value); };
      const onError = error => { cleanup(); reject(error); };
      const onExit = () => onError(new Error('PDF verification worker exited'));
      instance.on('message', onMessage);
      instance.on('error', onError);
      instance.on('exit', onExit);
      try { instance.postMessage({ path, expectedSize }); }
      catch (error) { onError(error); }
    });
    if (message.error) throw Object.assign(new Error(message.error.message), { code: message.error.code });
    return message.result;
  } finally {
    if (worker === instance) {
      instance.unref();
      idleTimer = setTimeout(() => {
        worker = undefined;
        void instance.terminate();
      }, 250).unref();
    }
  }
}

export function hashPrintPdf(path, expectedSize) {
  const result = pending.then(() => verify(path, expectedSize));
  pending = result.catch(() => {});
  return result;
}
