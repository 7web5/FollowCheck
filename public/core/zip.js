// Minimal ZIP reader for FollowCheck.
//
// Reads only the byte ranges it needs through Blob.slice(), so the archive is
// never loaded into memory as a whole. The caller decides which entries to keep
// while the central directory is parsed; every other filename is dropped as
// soon as it has been looked at.

const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIZE = 56;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;
const MAX_DIRECTORY_BYTES = 256 * 1024 * 1024;

export const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024 * 1024;

export class ZipError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ZipError';
    this.code = code;
  }
}

const fail = (code) => {
  throw new ZipError(code);
};

async function readBytes(blob, start, end) {
  if (!(start >= 0 && end >= start && end <= blob.size)) fail('DAMAGED');
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(dv, offset) {
  const value = dv.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('DAMAGED');
  return Number(value);
}

async function findEndRecord(blob) {
  const size = blob.size;
  if (size < EOCD_SIZE) fail(await startsLikeZip(blob) ? 'DAMAGED' : 'NOT_ZIP');

  // Most archives have no comment, so the record is the last 22 bytes.
  const last = await readBytes(blob, size - EOCD_SIZE, size);
  const lastView = view(last);
  if (lastView.getUint32(0, true) === EOCD_SIG && lastView.getUint16(20, true) === 0) {
    return { position: size - EOCD_SIZE, dv: lastView };
  }

  const start = Math.max(0, size - EOCD_SIZE - MAX_COMMENT);
  const tail = await readBytes(blob, start, size);
  const tailView = view(tail);
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (tailView.getUint32(i, true) !== EOCD_SIG) continue;
    const commentLength = tailView.getUint16(i + 20, true);
    if (i + EOCD_SIZE + commentLength !== tail.length) continue;
    return { position: start + i, dv: new DataView(tail.buffer, i, EOCD_SIZE) };
  }
  fail(await startsLikeZip(blob) ? 'DAMAGED' : 'NOT_ZIP');
}

async function startsLikeZip(blob) {
  if (blob.size < 4) return false;
  const head = view(await readBytes(blob, 0, 4));
  return head.getUint32(0, true) === LOCAL_SIG;
}

async function readDirectoryLocation(blob) {
  const { position, dv } = await findEndRecord(blob);
  let count = dv.getUint16(10, true);
  let directorySize = dv.getUint32(12, true);
  let directoryOffset = dv.getUint32(16, true);
  let directoryEnd = position;

  if (dv.getUint16(4, true) !== 0 || dv.getUint16(6, true) !== 0) fail('DAMAGED');

  if (position >= ZIP64_LOCATOR_SIZE) {
    const locator = view(await readBytes(blob, position - ZIP64_LOCATOR_SIZE, position));
    if (locator.getUint32(0, true) === ZIP64_LOCATOR_SIG) {
      const recordOffset = u64(locator, 8);
      if (recordOffset + ZIP64_EOCD_SIZE > position - ZIP64_LOCATOR_SIZE) fail('DAMAGED');
      const record = view(await readBytes(blob, recordOffset, recordOffset + ZIP64_EOCD_SIZE));
      if (record.getUint32(0, true) !== ZIP64_EOCD_SIG) fail('DAMAGED');
      count = u64(record, 32);
      directorySize = u64(record, 40);
      directoryOffset = u64(record, 48);
      directoryEnd = recordOffset;
    }
  }

  if (directoryOffset + directorySize > directoryEnd) fail('DAMAGED');
  if (directorySize > MAX_DIRECTORY_BYTES) fail('TOO_LARGE');
  return { count, directoryOffset, directorySize };
}

const nameDecoder = new TextDecoder('utf-8');

/**
 * Reads the central directory and calls keep(name) for every entry.
 * Returns [{ value, entry }] for entries where keep() returned something other
 * than undefined. Filenames themselves are never retained.
 */
export async function readDirectory(blob, keep) {
  const { count, directoryOffset, directorySize } = await readDirectoryLocation(blob);
  const bytes = await readBytes(blob, directoryOffset, directoryOffset + directorySize);
  const dv = view(bytes);
  const kept = [];
  let p = 0;

  for (let i = 0; i < count; i++) {
    if (p + CENTRAL_SIZE > bytes.length || dv.getUint32(p, true) !== CENTRAL_SIG) fail('DAMAGED');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    let compressedSize = dv.getUint32(p + 20, true);
    let size = dv.getUint32(p + 24, true);
    const nameLength = dv.getUint16(p + 28, true);
    const extraLength = dv.getUint16(p + 30, true);
    const commentLength = dv.getUint16(p + 32, true);
    let offset = dv.getUint32(p + 42, true);
    const nameStart = p + CENTRAL_SIZE;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > bytes.length) fail('DAMAGED');

    const value = keep(nameDecoder.decode(bytes.subarray(nameStart, extraStart)).replace(/\\/g, '/'));

    if (value !== undefined) {
      // ZIP64 extended information: only fields that are maxed out are present.
      let q = extraStart;
      const extraEnd = extraStart + extraLength;
      while (q + 4 <= extraEnd) {
        const id = dv.getUint16(q, true);
        const length = dv.getUint16(q + 2, true);
        if (id === 0x0001) {
          let r = q + 4;
          const end = r + length;
          const take = () => {
            if (r + 8 > end) fail('DAMAGED');
            const v = u64(dv, r);
            r += 8;
            return v;
          };
          if (size === 0xffffffff) size = take();
          if (compressedSize === 0xffffffff) compressedSize = take();
          if (offset === 0xffffffff) offset = take();
        }
        q += 4 + length;
      }

      kept.push({
        value,
        entry: {
          method,
          crc,
          size,
          compressedSize,
          offset,
          encrypted: (flags & 0x1) !== 0 || method === 99,
        },
      });
    }
    p = next;
  }
  return kept;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflate(blob, maxBytes, expectedSize) {
  let reader;
  try {
    reader = blob.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  } catch {
    fail('DAMAGED');
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // Count real output, never the declared size.
      if (total > maxBytes) fail('TOO_LARGE');
      if (total > expectedSize) fail('DAMAGED');
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    if (error instanceof ZipError) throw error;
    fail('DAMAGED');
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const chunk of chunks) {
    out.set(chunk, o);
    o += chunk.byteLength;
  }
  return out;
}

/** Decompresses one entry returned by readDirectory() and verifies it. */
export async function readEntry(blob, entry, { maxBytes = DEFAULT_MAX_ENTRY_BYTES } = {}) {
  if (entry.encrypted) fail('ENCRYPTED');
  if (entry.size > maxBytes) fail('TOO_LARGE');

  const header = view(await readBytes(blob, entry.offset, entry.offset + LOCAL_SIZE));
  if (header.getUint32(0, true) !== LOCAL_SIG) fail('DAMAGED');
  if (header.getUint16(6, true) & 0x1) fail('ENCRYPTED');
  const start = entry.offset + LOCAL_SIZE + header.getUint16(26, true) + header.getUint16(28, true);
  const end = start + entry.compressedSize;
  if (end > blob.size) fail('DAMAGED');

  let out;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) fail('DAMAGED');
    out = await readBytes(blob, start, end);
  } else if (entry.method === 8) {
    out = await inflate(blob.slice(start, end), maxBytes, entry.size);
  } else {
    fail('DAMAGED');
  }

  if (out.length !== entry.size || crc32(out) !== entry.crc) fail('DAMAGED');
  return out;
}
