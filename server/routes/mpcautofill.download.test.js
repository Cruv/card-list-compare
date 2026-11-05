import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { inflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { ZipArchive } from 'archiver';
import express from 'express';

const services = vi.hoisted(() => ({ downloadImages: vi.fn() }));
vi.mock('../lib/mpcautofill.js', async importOriginal => ({ ...(await importOriginal()), ...services }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, res, next) => {
  if (req.headers.authorization !== 'Bearer fixture-user') return res.status(401).json({ error: 'Authentication required' });
  req.user = { userId: 1 };
  next();
} }));
vi.mock('../middleware/rateLimit.js', () => ({ mpcLimiter: (_req, _res, next) => next() }));

let server, origin;
beforeEach(async () => {
  vi.clearAllMocks();
  const app = express();
  app.use(express.json());
  app.use('/api/mpc', (await import('./mpcautofill.js')).default);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  vi.restoreAllMocks();
});

function download(cards, { authenticated = true } = {}) {
  return fetch(`${origin}/api/mpc/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer fixture-user' } : {}) },
    body: JSON.stringify({ cards }),
  });
}

// Decode the actual ZIP response independently of Archiver. Checking only the
// presence of a filename can pass for an incomplete or corrupt streamed archive.
function zipEntries(bytes) {
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  expect(bytes.readUInt16LE(end + 20)).toBe(0);
  const count = bytes.readUInt16LE(end + 10);
  expect(bytes.readUInt16LE(end + 8)).toBe(count);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  expect(directoryStart + directorySize).toBe(end);
  const entries = [];
  let cursor = directoryStart;
  for (let i = 0; i < count; i++) {
    expect(bytes.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28);
    const extraSize = bytes.readUInt16LE(cursor + 30);
    const commentSize = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8');
    expect(bytes.readUInt32LE(local)).toBe(0x04034b50);
    expect(bytes.readUInt16LE(local + 8)).toBe(method);
    const localNameSize = bytes.readUInt16LE(local + 26);
    const localExtraSize = bytes.readUInt16LE(local + 28);
    expect(bytes.subarray(local + 30, local + 30 + localNameSize).toString('utf8')).toBe(name);
    const dataStart = local + 30 + localNameSize + localExtraSize;
    expect(dataStart + compressedSize).toBeLessThanOrEqual(directoryStart);
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    expect([0, 8]).toContain(method);
    const contents = method === 8 ? inflateRawSync(compressed) : compressed;
    expect(contents.length).toBe(size);
    entries.push({ name, contents });
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  expect(cursor).toBe(directoryStart + directorySize);
  return entries;
}

describe('MPC image ZIP download', () => {
  it('streams a complete ZIP with exact image bytes, numbered safe names and one image per identifier', async () => {
    const front = { name: "Malakir Rebirth / Front's Art", quantity: 2, identifier: 'front-art', extension: 'png' };
    const back = { name: 'Malakir Mire (back)', quantity: 2, identifier: 'back-art', extension: 'jpg' };
    const frontBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 1, 2, 3]);
    const backBytes = Buffer.from([0xff, 0xd8, 0xff, 0, 3, 2, 1, 0xd9]);
    services.downloadImages.mockResolvedValue([
      { name: front.name, extension: 'png', buffer: frontBytes },
      { name: back.name, extension: 'jpg', buffer: backBytes },
    ]);

    const response = await download([front, { ...front, quantity: 99 }, { name: 'No artwork yet' }, back]);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/zip');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="mpc-card-images.zip"');
    expect(services.downloadImages).toHaveBeenCalledExactlyOnceWith([front, back]);
    expect(zipEntries(Buffer.from(await response.arrayBuffer()))).toEqual([
      { name: '001_Malakir_Rebirth_Fronts_Art.png', contents: frontBytes },
      { name: '002_Malakir_Mire_back.jpg', contents: backBytes },
    ]);
  });

  it('rejects unauthenticated downloads before fetching any images', async () => {
    const response = await download([{ name: 'Sol Ring', identifier: 'art' }], { authenticated: false });
    expect(response.status).toBe(401);
    expect(services.downloadImages).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 'cards array is required'],
    [[], 'cards array is required'],
    [[{ name: 'Sol Ring' }], 'No cards with valid identifiers'],
  ])('rejects unusable artwork input without starting a ZIP', async (cards, message) => {
    const response = await download(cards);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
    expect(services.downloadImages).not.toHaveBeenCalled();
  });

  it('returns an upstream failure instead of an empty successful ZIP', async () => {
    services.downloadImages.mockResolvedValue([]);
    const response = await download([{ name: 'Sol Ring', identifier: 'art' }]);
    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'Failed to download any images. The image service may be unavailable.' });
  });

  it('returns a JSON error when downloading fails before the ZIP response starts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    services.downloadImages.mockRejectedValue(new Error('Synthetic unavailable image service'));
    const response = await download([{ name: 'Sol Ring', identifier: 'art' }]);
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'Failed to download card images.' });
  });

  it.each(['error', 'warning'])('closes a failed streamed ZIP on an archive %s and aborts remaining work', async event => {
    let reportError;
    const reported = new Promise(resolve => { reportError = resolve; });
    vi.spyOn(console, 'error').mockImplementation((_message, error) => reportError(error));
    services.downloadImages.mockResolvedValue([{ name: 'Sol Ring', extension: 'png', buffer: randomBytes(1024 * 1024) }]);
    const abort = vi.spyOn(ZipArchive.prototype, 'abort');
    const finalize = ZipArchive.prototype.finalize;
    const failure = new Error(`Synthetic archive ${event}`);
    vi.spyOn(ZipArchive.prototype, 'finalize').mockImplementation(function () {
      this.once('data', () => queueMicrotask(() => this.emit(event, failure)));
      return finalize.call(this);
    });

    // Depending on how far the HTTP headers got, failure rejects fetch itself or
    // body consumption. Neither outcome may look like a complete ZIP download.
    await expect((async () => {
      const response = await download([{ name: 'Sol Ring', identifier: 'art' }]);
      await response.arrayBuffer();
    })()).rejects.toThrow();
    expect(await reported).toBe(failure);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('aborts archive work when the client disconnects during a download', async () => {
    let reportError;
    const reported = new Promise(resolve => { reportError = resolve; });
    vi.spyOn(console, 'error').mockImplementation((_message, error) => reportError(error));
    const abort = vi.spyOn(ZipArchive.prototype, 'abort');
    // Incompressible bytes keep the real archive streaming after the first HTTP
    // chunk, so destroying the client exercises an in-progress response.
    services.downloadImages.mockResolvedValue([{ name: 'Sol Ring', extension: 'png', buffer: randomBytes(4 * 1024 * 1024) }]);
    await new Promise((resolve, reject) => {
      const request = httpRequest(`${origin}/api/mpc/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-user' },
      }, response => {
        expect(response.statusCode).toBe(200);
        response.once('data', () => { response.destroy(); request.destroy(); resolve(); });
        response.once('error', reject);
      });
      request.once('error', reject);
      request.end(JSON.stringify({ cards: [{ name: 'Sol Ring', identifier: 'art' }] }));
    });
    expect(await reported).toMatchObject({ code: 'ERR_STREAM_PREMATURE_CLOSE' });
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
