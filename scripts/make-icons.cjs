// Draws the extension icon (a white "C" ring on Cold's teal) as PNGs, with no image tooling needed.
const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib");
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size), cx = (size - 1) / 2, R = size * 0.46, ring = size * 0.12;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4, dx = x - cx, dy = y - cx, d = Math.hypot(dx, dy);
      const inBadge = Math.max(Math.abs(dx), Math.abs(dy)) <= R + size * 0.04 && (Math.abs(dx) < R - size * 0.0 || true);
      const corner = Math.hypot(Math.max(Math.abs(dx) - (R - size * 0.18), 0), Math.max(Math.abs(dy) - (R - size * 0.18), 0)) <= size * 0.22;
      const badge = inBadge && corner;
      const inRing = d <= size * 0.30 && d >= size * 0.30 - ring && !(dx > size * 0.04 && Math.abs(dy) < size * 0.16);   // the gap makes it a "C"
      const px = badge ? (inRing ? [255, 255, 255, 255] : [31, 94, 107, 255]) : [0, 0, 0, 0];
      raw.set(px, i);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const out = path.join(__dirname, "../extension/icons");
fs.mkdirSync(out, { recursive: true });
for (const s of [16, 48, 128]) fs.writeFileSync(path.join(out, `icon${s}.png`), png(s));
console.log("Wrote extension/icons");
