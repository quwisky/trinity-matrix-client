import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP reader and writer for rewriting Playwright report archives
 * (blob reports, HTML report payloads and traces) in place. It supports what
 * Playwright writes: single-disk archives with stored or deflated entries and
 * no ZIP64 or encryption. Anything else is a {@link ZipFormatError}, so a
 * caller that must verify an archive can fail closed.
 */
export class ZipFormatError extends Error {
  name = 'ZipFormatError';
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_NAMES = 0x0800;
const MAX_32 = 0xffffffff;
const MAX_16 = 0xffff;

/** Whether bytes start with a ZIP local file header. */
export function isZip(bytes) {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === LOCAL_HEADER;
}

function endOfCentralDirectory(buffer) {
  const floor = Math.max(0, buffer.length - MAX_16 - 22);
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1)
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  throw new ZipFormatError('the archive has no end of central directory');
}

function check(condition, message) {
  if (!condition) throw new ZipFormatError(message);
}

/**
 * Read every entry. Each entry keeps its original compressed bytes, so an
 * unchanged entry can be written back without recompression.
 */
export function readZip(buffer) {
  const end = endOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12);
  const start = buffer.readUInt32LE(end + 16);
  check(
    buffer.readUInt16LE(end + 4) === 0 &&
      buffer.readUInt16LE(end + 6) === 0 &&
      buffer.readUInt16LE(end + 8) === count,
    'multi-disk archives are not supported',
  );
  check(
    count !== MAX_16 && size !== MAX_32 && start !== MAX_32,
    'ZIP64 archives are not supported',
  );
  check(start + size <= end, 'the central directory is out of bounds');
  const entries = [];
  let offset = start;
  for (let index = 0; index < count; index += 1) {
    check(
      offset + 46 <= end && buffer.readUInt32LE(offset) === CENTRAL_HEADER,
      'a central directory entry is malformed',
    );
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    check((flags & 1) === 0, 'encrypted entries are not supported');
    check(
      compressedSize !== MAX_32 &&
        uncompressedSize !== MAX_32 &&
        local !== MAX_32,
      'ZIP64 entries are not supported',
    );
    check(
      local + 30 <= buffer.length &&
        buffer.readUInt32LE(local) === LOCAL_HEADER,
      'a local file header is malformed',
    );
    const dataStart =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    check(
      dataStart + compressedSize <= buffer.length,
      'entry data is out of bounds',
    );
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) {
      try {
        data = inflateRawSync(raw);
      } catch {
        throw new ZipFormatError('an entry does not inflate');
      }
    } else throw new ZipFormatError('an entry uses an unsupported method');
    check(
      data.length === uncompressedSize && crc32(data) === crc,
      'an entry fails its size or CRC check',
    );
    entries.push({
      name,
      data,
      time: buffer.readUInt16LE(offset + 12),
      date: buffer.readUInt16LE(offset + 14),
      stored: { method, raw, crc },
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Write entries as a new archive. An entry whose `stored` bytes are still
 * present is copied unchanged; any other entry is deflated when that helps.
 */
export function writeZip(entries) {
  check(entries.length < MAX_16, 'too many entries for a non-ZIP64 archive');
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data, time = 0, date = 0x21, stored } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    let method;
    let raw;
    let crc;
    if (stored) ({ method, raw, crc } = stored);
    else {
      const deflated = deflateRawSync(data);
      method = deflated.length < data.length ? 8 : 0;
      raw = method === 8 ? deflated : data;
      crc = crc32(data);
    }
    check(
      offset + 30 + nameBytes.length + raw.length < MAX_32,
      'the archive is too large for a non-ZIP64 archive',
    );
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(UTF8_NAMES, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(raw.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(CENTRAL_HEADER, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(UTF8_NAMES, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt16LE(time, 12);
    directory.writeUInt16LE(date, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(raw.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);
    chunks.push(header, nameBytes, raw);
    central.push(directory, nameBytes);
    offset += 30 + nameBytes.length + raw.length;
  }
  const directorySize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}
