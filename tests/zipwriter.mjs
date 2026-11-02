// Test-only ZIP writer. It can produce the odd archives the reader must handle:
// stored and deflated entries, ZIP64 fields, encryption flags and wrong CRCs.

import { deflateRawSync, crc32 } from 'node:zlib';

const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/**
 * entries: [{ name, data, method = 8, compressed, encrypted, crc, size, zip64 }]
 * - compressed: raw deflate bytes to store instead of compressing data
 * - crc / size: override the declared values
 * - zip64: write 64-bit size and offset fields for this entry
 * Returns { buffer, ranges } where ranges maps each name to its byte range.
 */
export function makeZip(entries, { zip64 = false, comment = '' } = {}) {
  const chunks = [];
  const central = [];
  const ranges = new Map();
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data ?? '');
    const method = e.method ?? 8;
    const body = e.compressed ?? (method === 8 ? deflateRawSync(data) : data);
    const crc = e.crc ?? crc32(data);
    const size = e.size ?? data.length;
    const wide = Boolean(e.zip64);
    const flags = 0x800 | (e.encrypted ? 0x1 : 0);
    const localExtra = wide ? Buffer.concat([u16(1), u16(16), u64(size), u64(body.length)]) : Buffer.alloc(0);

    const local = Buffer.concat([
      u32(0x04034b50), u16(wide ? 45 : 20), u16(flags), u16(method), u16(0), u16(0x21),
      u32(crc), u32(wide ? 0xffffffff : body.length), u32(wide ? 0xffffffff : size),
      u16(name.length), u16(localExtra.length), name, localExtra,
    ]);
    ranges.set(e.name, { start: offset, end: offset + local.length + body.length });
    chunks.push(local, body);

    const centralExtra = wide
      ? Buffer.concat([u16(1), u16(24), u64(size), u64(body.length), u64(offset)])
      : Buffer.alloc(0);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(0x031e), u16(wide ? 45 : 20), u16(flags), u16(method), u16(0), u16(0x21),
      u32(crc), u32(wide ? 0xffffffff : body.length), u32(wide ? 0xffffffff : size),
      u16(name.length), u16(centralExtra.length), u16(0), u16(0), u16(0), u32(0),
      u32(wide ? 0xffffffff : offset), name, centralExtra,
    ]));
    offset += local.length + body.length;
  }

  const directory = Buffer.concat(central);
  const directoryOffset = offset;
  const count = entries.length;
  const needs64 = zip64 || count > 0xfffe;
  const tail = [];

  if (needs64) {
    const recordOffset = directoryOffset + directory.length;
    tail.push(
      u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0),
      u64(count), u64(count), u64(directory.length), u64(directoryOffset),
      u32(0x07064b50), u32(0), u64(recordOffset), u32(1),
    );
  }
  const commentBytes = Buffer.from(comment);
  tail.push(
    u32(0x06054b50), u16(0), u16(0),
    u16(needs64 ? 0xffff : count), u16(needs64 ? 0xffff : count),
    u32(needs64 ? 0xffffffff : directory.length), u32(needs64 ? 0xffffffff : directoryOffset),
    u16(commentBytes.length), commentBytes,
  );

  return { buffer: Buffer.concat([...chunks, directory, ...tail]), ranges };
}
