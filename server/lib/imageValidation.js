import { crc32, inflateSync } from 'node:zlib';

export const MAX_IMAGE_COPIES = 1000;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_JOB_IMAGE_BYTES = 256 * 1024 * 1024;
const MAX_DECODED_IMAGE_BYTES = 64 * 1024 * 1024;

/** Structural checks, not a replacement for a full JPEG pixel decoder. */
export function imageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_IMAGE_BYTES) return null;
  try {
    if (buffer.length >= 45 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      return validPng(buffer) ? 'png' : null;
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return validJpeg(buffer) ? 'jpg' : null;
  } catch { /* malformed chunks, checksums, compression, or bounded inflate failure */ }
  return null;
}

function validPng(buffer) {
  let offset = 8;
  let header;
  let palette = false;
  const imageData = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > buffer.length) return false;
    if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== buffer.readUInt32BE(offset + 8 + length)) return false;
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (offset === 8 && type !== 'IHDR') return false;
    if (type === 'IHDR') {
      if (header || length !== 13) return false;
      const width = data.readUInt32BE(0), height = data.readUInt32BE(4);
      const depth = data[8], color = data[9], interlace = data[12];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
      if (!width || !height || !depths[color]?.includes(depth) || data[10] || data[11] || interlace > 1) return false;
      header = { width, height, bitsPerPixel: depth * channels[color], color, interlace };
    } else if (type === 'PLTE') {
      if (!length || length > 768 || length % 3) return false;
      palette = true;
    } else if (type === 'IDAT') {
      imageData.push(data);
    } else if (type === 'IEND') {
      if (!header || length || offset + 12 !== buffer.length || !imageData.length || (header.color === 3 && !palette)) return false;
      const passes = header.interlace
        ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
        : [[0, 0, 1, 1]];
      const rows = [];
      let expectedLength = 0;
      for (const [x, y, stepX, stepY] of passes) {
        const width = Math.max(0, Math.ceil((header.width - x) / stepX));
        const height = Math.max(0, Math.ceil((header.height - y) / stepY));
        if (!width || !height) continue;
        const rowSize = 1 + Math.ceil(width * header.bitsPerPixel / 8);
        expectedLength += rowSize * height;
        if (expectedLength > MAX_DECODED_IMAGE_BYTES) return false;
        rows.push({ rowSize, height });
      }
      const pixels = inflateSync(Buffer.concat(imageData), { maxOutputLength: expectedLength });
      if (pixels.length !== expectedLength) return false;
      let rowOffset = 0;
      for (const { rowSize, height } of rows) {
        for (let row = 0; row < height; row++, rowOffset += rowSize) {
          if (pixels[rowOffset] > 4) return false;
        }
      }
      return true;
    }
    offset += length + 12;
  }
  return false;
}

function validJpeg(buffer) {
  let offset = 2;
  let frameComponents = 0;
  let inScan = false;
  let hasScanData = false;
  let hasScan = false;
  while (offset < buffer.length) {
    if (inScan && buffer[offset] !== 0xff) {
      hasScanData = true;
      offset++;
      continue;
    }
    if (buffer[offset++] !== 0xff) return false;
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (inScan && marker === 0) { hasScanData = true; continue; }
    if (inScan && marker >= 0xd0 && marker <= 0xd7) continue;
    inScan = false;
    if (marker === 0xd9) return hasScan && hasScanData && !!frameComponents && offset === buffer.length;
    if (!marker || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > buffer.length) return false;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) return false;
      const height = buffer.readUInt16BE(offset + 3), width = buffer.readUInt16BE(offset + 5);
      frameComponents = buffer[offset + 7];
      if (!width || !height || !frameComponents || frameComponents > 4 || length !== 8 + frameComponents * 3
        || width * height * frameComponents > MAX_DECODED_IMAGE_BYTES) return false;
    } else if (marker === 0xda) {
      const components = buffer[offset + 2];
      if (!frameComponents || !components || components > frameComponents || length !== 6 + 2 * components) return false;
      hasScan = true;
      inScan = true;
    }
    offset += length;
  }
  return false;
}
