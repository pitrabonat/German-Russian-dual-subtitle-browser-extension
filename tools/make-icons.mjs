// Draws the extension icon (two subtitle bars on a dark rounded square) and writes PNG files.
// No image library needed: shapes are rasterised with 4x supersampling and encoded by hand.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icons');
mkdirSync(out, { recursive: true });

// Shapes on a 32-unit canvas: [x, y, width, height, radius, r, g, b]
const SHAPES = [
  [0, 0, 32, 32, 7.5, 0x1d, 0x1f, 0x26],
  [6, 9, 20, 5, 2.5, 0xff, 0xff, 0xff],
  [9, 18, 14, 5, 2.5, 0xff, 0xd9, 0x8a],
];

function inside(px, py, [x, y, w, h, r]) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function render(size) {
  const SS = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = ((x + (sx + 0.5) / SS) / size) * 32;
          const py = ((y + (sy + 0.5) / SS) / size) * 32;
          let hit = null;
          for (const shape of SHAPES) if (inside(px, py, shape)) hit = shape;
          if (hit) { r += hit[5]; g += hit[6]; b += hit[7]; a += 255; }
        }
      }
      const n = SS * SS;
      const covered = a / 255;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = covered ? Math.round(r / covered) : 0;
      raw[o + 1] = covered ? Math.round(g / covered) : 0;
      raw[o + 2] = covered ? Math.round(b / covered) : 0;
      raw[o + 3] = Math.round(a / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [16, 32, 48, 128]) writeFileSync(join(out, `${size}.png`), render(size));
console.log('icons written to assets/icons');
