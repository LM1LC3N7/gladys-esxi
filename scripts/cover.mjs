// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-teal gradient, a
// server with its drive bays and lights, and the virtual machines it runs as
// small windows above it (three running, one stopped). Plain Node (zlib), no
// dependency, no logo.
// Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [10, 18, 28];
const TEAL = [16, 80, 96];
const WHITE = [234, 242, 248];
const GREEN = [70, 210, 120];
const DIM = [70, 90, 110];
const SCREEN = [30, 120, 150];
const LINK = [110, 190, 220];

/** A rounded box centred on (cx, cy): its signed distance. */
function box(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance from (x, y) to the segment (ax, ay)-(bx, by). */
function segment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

const SERVER = [400, 390];
// The VMs: [cx, cy, running].
const VMS = [
  [190, 140, true],
  [330, 120, true],
  [470, 120, true],
  [610, 140, false],
];

function pixel(x, y) {
  let color = mix(DARK, TEAL, (x / WIDTH) * 0.45 + (y / HEIGHT) * 0.55);
  // The links from the server to its VMs.
  for (const [vx, vy] of VMS) {
    const d = segment(x, y, SERVER[0], SERVER[1] - 70, vx, vy + 48);
    color = mix(color, LINK, smooth(1.5, d) * 0.6);
  }
  // The server: a rack unit with drive bays and lights.
  const body = box(x, y, SERVER[0], SERVER[1], 230, 70, 16);
  color = mix(color, WHITE, smooth(0, body) * 0.95);
  color = mix(color, DARK, smooth(-6, body) * 0.9);
  for (let i = 0; i < 6; i += 1) {
    const bay = box(x, y, SERVER[0] - 150 + i * 44, SERVER[1], 16, 40, 4);
    color = mix(color, DIM, smooth(0, bay) * 0.9);
  }
  for (const [i, ly] of [-30, 0, 30].entries()) {
    const light = i < 2 ? GREEN : DIM;
    color = mix(color, light, smooth(7, Math.hypot(x - (SERVER[0] + 175), y - (SERVER[1] + ly))));
  }
  // The VMs: windows with a title bar and a state light.
  for (const [vx, vy, on] of VMS) {
    const frame = box(x, y, vx, vy, 58, 46, 8);
    color = mix(color, WHITE, smooth(0, frame) * 0.92);
    const screen = box(x, y, vx, vy + 8, 50, 32, 4);
    color = mix(color, on ? SCREEN : DIM, smooth(0, screen) * 0.95);
    color = mix(color, on ? GREEN : DIM, smooth(6, Math.hypot(x - (vx + 42), y - (vy - 36))));
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
