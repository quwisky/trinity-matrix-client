import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZipFormatError, isZip, readZip, writeZip } from './zip-archive.mjs';

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const text = (name, value) => ({ name, data: Buffer.from(value, 'utf8') });

describe('ZIP archive round trip', () => {
  it('writes entries that it reads back unchanged', () => {
    const entries = [
      text('report.jsonl', '{"method":"onBegin"}\n'.repeat(50)),
      { name: 'resources/', data: Buffer.alloc(0) },
      { name: 'resources/a.bin', data: Buffer.from([0, 1, 2, 3]) },
    ];
    const archive = writeZip(entries);
    expect(isZip(archive)).toBe(true);
    expect(
      readZip(archive).map(({ name, data }) => [name, data.toString('hex')]),
    ).toEqual(entries.map(({ name, data }) => [name, data.toString('hex')]));
  });

  it('copies an unchanged entry without recompressing it', () => {
    const [entry] = readZip(writeZip([text('a.txt', 'x'.repeat(4096))]));
    const copy = readZip(writeZip([entry]));
    expect(copy[0].stored.raw.equals(entry.stored.raw)).toBe(true);
    expect(copy[0].data.toString()).toBe('x'.repeat(4096));
  });

  it('writes an archive the system unzip verifies', (context) => {
    let unzip = true;
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    } catch {
      unzip = false;
    }
    if (!unzip) context.skip();
    const directory = mkdtempSync(join(tmpdir(), 'trinity-zip-'));
    directories.push(directory);
    const path = join(directory, 'report.zip');
    writeFileSync(
      path,
      writeZip([text('report.jsonl', 'line\n'.repeat(100)), text('b', 'b')]),
    );
    expect(
      execFileSync('unzip', ['-p', path, 'report.jsonl'], { encoding: 'utf8' }),
    ).toBe('line\n'.repeat(100));
  });
});

describe('ZIP archive verification', () => {
  const archive = () => writeZip([text('report.jsonl', 'content')]);

  it('rejects a buffer without a central directory', () => {
    expect(() => readZip(Buffer.from('PK\u0003\u0004 truncated'))).toThrow(
      ZipFormatError,
    );
  });

  it('rejects an entry whose content fails its CRC', () => {
    const bytes = archive();
    const offset = bytes.indexOf('content');
    bytes[offset] ^= 0xff;
    expect(() => readZip(bytes)).toThrow(/CRC/u);
  });

  it('rejects an encrypted entry', () => {
    const bytes = archive();
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 1, central + 8);
    expect(() => readZip(bytes)).toThrow(/encrypted/u);
  });

  it('rejects a ZIP64 archive', () => {
    const bytes = archive();
    const end = bytes.length - 22;
    bytes.writeUInt32LE(0xffffffff, end + 16);
    expect(() => readZip(bytes)).toThrow(/ZIP64/u);
  });

  it('reads an archive written by the system zip', (context) => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-zip-'));
    directories.push(directory);
    writeFileSync(join(directory, 'a.txt'), 'hello '.repeat(200));
    try {
      execFileSync('zip', ['-q', 'out.zip', 'a.txt'], { cwd: directory });
    } catch {
      context.skip();
    }
    const [entry] = readZip(readFileSync(join(directory, 'out.zip')));
    expect(entry.name).toBe('a.txt');
    expect(entry.data.toString()).toBe('hello '.repeat(200));
  });
});
