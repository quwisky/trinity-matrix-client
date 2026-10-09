import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { findPackageJSON } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The copy of Pagefind that Starlight's build integration imports.
const pagefindPackage = findPackageJSON(
  'pagefind',
  import.meta.resolve('@astrojs/starlight'),
);
const pagefind = await import(
  pathToFileURL(join(dirname(pagefindPackage), 'lib/index.js')).href
);

const ENTRY = '{"version":"1.5.2","languages":{}}';

// Pagefind 1.5.2's service acknowledges WriteFiles before its tokio writes reach the
// disk, and `close()` then kills it, so a write can be lost after the acknowledgement
// (Pagefind#1271). This backend makes that loss certain: it creates the file as
// `File::create` does, acknowledges, and never writes the bytes. GetFiles still
// returns the index contents in memory.
const LOSSY_BACKEND = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const send = (message) =>
  process.stdout.write(Buffer.from(JSON.stringify(message)).toString('base64') + ',');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf(',')) !== -1) {
    const { message_id, payload } = JSON.parse(
      Buffer.from(buffer.slice(0, end), 'base64').toString(),
    );
    buffer = buffer.slice(end + 1);
    if (payload.type === 'NewIndex') {
      send({ message_id, payload: { type: 'NewIndex', index_id: 1 } });
    } else if (payload.type === 'WriteFiles') {
      mkdirSync(payload.output_path, { recursive: true });
      writeFileSync(join(payload.output_path, 'pagefind-entry.json'), '');
      send({ message_id, payload: { type: 'WriteFiles', output_path: payload.output_path } });
    } else if (payload.type === 'GetFiles') {
      const content = Buffer.from(${JSON.stringify(ENTRY)}).toString('base64');
      send({ message_id, payload: { type: 'GetFiles', files: [{ path: 'pagefind-entry.json', content }] } });
    }
  }
});
`;

const temporaryDirectories = [];

afterEach(async () => {
  await pagefind.close();
  delete process.env.PAGEFIND_BINARY_PATH;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Pagefind index output', () => {
  it('is complete on disk once writeFiles resolves, even if the backend is closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'trinity-docs-pagefind-'));
    temporaryDirectories.push(root);
    const backend = join(root, 'lossy-backend.cjs');
    writeFileSync(backend, LOSSY_BACKEND, 'utf8');
    chmodSync(backend, 0o755);
    process.env.PAGEFIND_BINARY_PATH = backend;
    const outputPath = join(root, 'site', 'pagefind');

    const { index } = await pagefind.createIndex();
    const { errors } = await index.writeFiles({ outputPath });
    await pagefind.close();

    expect(errors).toEqual([]);
    expect(readFileSync(join(outputPath, 'pagefind-entry.json'), 'utf8')).toBe(
      ENTRY,
    );
  });
});
