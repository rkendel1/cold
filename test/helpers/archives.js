// Tiny in-memory ZIP and tar.gz writers for tests (no dependencies).
const zlib = require('node:zlib');

function crc32(buf) { let c, crc = 0xffffffff; for (let i = 0; i < buf.length; i++) { c = (crc ^ buf[i]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function makeZip(files) {
  const parts = [], central = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), comp = zlib.deflateRawSync(data), nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    parts.push(lh, nm, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nm); off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
function makeTarGz(files, sha = 'a'.repeat(40)) {
  const blocks = [];
  const header = (name, size, type = '0') => { const h = Buffer.alloc(512); h.write(name, 0); h.write('0000644\0', 100); h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write(type, 156); h.write('ustar\0', 257); return h; };
  const add = (name, buf, type) => { blocks.push(header(name, buf.length, type), buf, Buffer.alloc((512 - (buf.length % 512)) % 512)); };
  add('pax_global_header', Buffer.from(`52 comment=${sha}\n`), 'g');
  for (const [n, t] of Object.entries(files)) add(`owner-repo-${sha.slice(0, 7)}/${n}`, Buffer.from(t));
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

module.exports = { makeZip, makeTarGz };
