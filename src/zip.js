// Copied from Society src/zip.js: dependency-free stored (uncompressed) ZIP writer for the Emergency Dump.
let crcTable = null;

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buffer) {
  if (!crcTable) crcTable = makeCrcTable();
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u16(value) {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16LE(value >>> 0, 0);
  return b;
}

function u32(value) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

export function buildStoredZip(textFiles) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const entries = [];

  for (const filename of Object.keys(textFiles).sort()) {
    const name = Buffer.from(filename, "utf8");
    const data = Buffer.from(String(textFiles[filename]), "utf8");
    const crc = crc32(data);
    const header = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x0021),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name
    ]);
    localParts.push(header, data);
    entries.push({ name, crc, size: data.length, offset });
    offset += header.length + data.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const entry of entries) {
    const part = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x0021),
      u32(entry.crc), u32(entry.size), u32(entry.size), u16(entry.name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(entry.offset), entry.name
    ]);
    centralParts.push(part);
    centralSize += part.length;
  }

  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralSize), u32(centralOffset), u16(0)
  ]);
  return Buffer.concat([...localParts, ...centralParts, end]);
}
