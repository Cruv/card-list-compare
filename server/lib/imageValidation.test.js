import { describe, expect, it } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';
import { imageFormat, MAX_IMAGE_BYTES, MAX_JOB_IMAGE_BYTES, MAX_IMAGE_COPIES } from './imageValidation.js';

function chunk(type, bytes) {
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length);
  result.write(type, 4, 'ascii');
  bytes.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, bytes.length + 8)), bytes.length + 8);
  return result;
}
function png({ width = 1, height = 1, pixels = Buffer.from([0, 255]), compressed, interlace = 0 } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[12] = interlace; // 8-bit grayscale
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', compressed || deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
// A 1x1 grayscale image encoded by the macOS image codec; metadata removed.
const JPEG = Buffer.from('/9j/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/90ABAAB/9oACAEBAAA/AP38r//Z', 'base64');

describe('bounded image structural validation', () => {
  it('accepts valid PNG, Adam7 PNG, and a real JPEG', () => {
    expect(imageFormat(png())).toBe('png');
    expect(imageFormat(png({ interlace: 1 }))).toBe('png');
    expect(imageFormat(JPEG)).toBe('jpg');
  });
  it('rejects a PNG with valid chunk CRCs but invalid compressed bytes', () => {
    expect(imageFormat(png({ compressed: Buffer.from('not a zlib stream') }))).toBeNull();
  });
  it('rejects incorrect PNG row lengths and invalid filter bytes', () => {
    expect(imageFormat(png({ pixels: Buffer.from([0]) }))).toBeNull();
    expect(imageFormat(png({ pixels: Buffer.from([5, 255]) }))).toBeNull();
  });
  it('bounds decompression by the declared row size and rejects huge image dimensions', () => {
    expect(imageFormat(png({ compressed: deflateSync(Buffer.alloc(1024 * 1024)) }))).toBeNull();
    expect(imageFormat(png({ width: 0xffffffff, height: 0xffffffff }))).toBeNull();
  });
  it('rejects empty JPEG, missing scan bytes, missing EOI, and invalid frame dimensions', () => {
    expect(imageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(imageFormat(JPEG.subarray(0, JPEG.length - 2))).toBeNull();
    const noPixels = Buffer.concat([JPEG.subarray(0, JPEG.length - 5), JPEG.subarray(-2)]);
    expect(imageFormat(noPixels)).toBeNull();
    const zeroWidth = Buffer.from(JPEG);
    zeroWidth.writeUInt16BE(0, 9);
    expect(imageFormat(zeroWidth)).toBeNull();
  });
  it('keeps documented production limits explicit', () => {
    expect(MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024);
    expect(MAX_JOB_IMAGE_BYTES).toBe(256 * 1024 * 1024);
    expect(MAX_IMAGE_COPIES).toBe(1000);
  });
});
