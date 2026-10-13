import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Readable } from 'node:stream';

// Capture the handler registered with protocol.handle so we can drive it directly.
// vi.hoisted so the mock var exists when the hoisted vi.mock factory runs.
const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }));
vi.mock('electron', () => ({
  protocol: { handle: handleMock, registerSchemesAsPrivileged: vi.fn() },
}));

// The handler reads the served build from disk, but `www/` is a copied build
// output (gitignored, absent on a fresh checkout), so the file system is faked:
// `fakeFiles` maps the paths that exist to their bytes, everything else raises
// ENOENT. `streamFailures` lists paths whose stat succeeds but whose open fails
// (a file removed between `stat` and the read).
const {
  fakeFiles,
  streamFailures,
  statMock,
  readFileMock,
  createReadStreamMock,
} = vi.hoisted(() => {
  const fakeFiles = new Map<string, Buffer>();
  const streamFailures = new Set<string>();
  const enoent = (filePath: string) =>
    Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
  return {
    fakeFiles,
    streamFailures,
    statMock: vi.fn(async (filePath: string) => {
      const data = fakeFiles.get(filePath);
      if (data === undefined) {
        throw enoent(filePath);
      }
      return { isFile: () => true, size: data.length };
    }),
    readFileMock: vi.fn(async (filePath: string) =>
      Buffer.from(`body of ${filePath}`),
    ),
    createReadStreamMock: vi.fn((filePath: string) => {
      const data = fakeFiles.get(filePath);
      const stream = new Readable({
        read() {
          this.push(data);
          this.push(null);
        },
      });
      setImmediate(() => {
        if (data === undefined || streamFailures.has(filePath)) {
          stream.destroy(enoent(filePath));
        } else {
          stream.emit('open', 1);
        }
      });
      return stream;
    }),
  };
});
vi.mock('node:fs', () => ({
  promises: { stat: statMock, readFile: readFileMock },
  createReadStream: createReadStreamMock,
}));

import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  contentTypeFor,
  INDEX_HTML,
  isAppUrl,
  registerAppProtocol,
  WWW_ROOT,
} from './scheme';

describe('contentTypeFor', () => {
  it('maps known extensions (case-insensitively)', () => {
    expect(contentTypeFor('/www/app.txt')).toBe('text/plain; charset=utf-8');
    expect(contentTypeFor('/www/font.woff2')).toBe('font/woff2');
    expect(contentTypeFor('/www/manifest.WEBMANIFEST')).toBe(
      'application/manifest+json',
    );
  });

  it('falls back to octet-stream for unknown extensions', () => {
    expect(contentTypeFor('/www/data.bin')).toBe('application/octet-stream');
    expect(contentTypeFor('/www/noext')).toBe('application/octet-stream');
  });
});

describe('isAppUrl', () => {
  it('accepts only the exact Trinity scheme and host', () => {
    expect(isAppUrl('trinity://app/rooms')).toBe(true);
    expect(isAppUrl('trinity://app/')).toBe(true);
    expect(isAppUrl('https://evil.example/app')).toBe(false);
    expect(isAppUrl('http://app/')).toBe(false);
    expect(isAppUrl('trinity://app.evil.example/')).toBe(false);
    expect(isAppUrl('trinity://user@app/')).toBe(false);
    expect(isAppUrl('javascript:alert(1)')).toBe(false);
    expect(isAppUrl('not a url')).toBe(false);
    expect(isAppUrl('')).toBe(false);
  });
});

describe('registerAppProtocol — path guard', () => {
  let handler: (req: { url: string }) => Promise<Response>;

  beforeEach(() => {
    handleMock.mockClear();
    registerAppProtocol();
    handler = handleMock.mock.calls[0][1];
  });

  it('rejects an encoded path-traversal escape with 403', async () => {
    // Encoded slashes (`%2f`) survive URL parsing as one path segment, so `..%2f`
    // isn't collapsed by the parser (unlike literal `..` or `%2e%2e`) — it decodes
    // to `../` only after, and must be caught by the resolved-path guard.
    const res = await handler({
      url: 'trinity://app/..%2f..%2f..%2f..%2f..%2fetc/passwd',
    });
    expect(res.status).toBe(403);
  });

  it('rejects malformed percent-encoding with 400 (no unhandled throw)', async () => {
    const res = await handler({ url: 'trinity://app/%' });
    expect(res.status).toBe(400);
    const res2 = await handler({ url: 'trinity://app/%zz' });
    expect(res2.status).toBe(400);
  });
});

describe('registerAppProtocol — SPA fallback', () => {
  let handler: (req: { url: string }) => Promise<Response>;

  beforeEach(() => {
    handleMock.mockClear();
    statMock.mockClear();
    readFileMock.mockClear();
    createReadStreamMock.mockClear();
    fakeFiles.clear();
    streamFailures.clear();
    fakeFiles.set(INDEX_HTML, Buffer.from('<html></html>'));
    registerAppProtocol();
    handler = handleMock.mock.calls[0][1];
  });

  // The open room lives in the URL as `/rooms/<segment>` (#179). A raw room id
  // (`!abc:matrix.org`) contains a DOT, and this fallback keys off
  // `path.extname`, so `.org` would read as a file extension and the desktop app
  // would answer a reload with a bare 404 instead of booting. base64url
  // (`A-Z a-z 0-9 - _`, unpadded) has no dot, so the route stays extensionless —
  // including when the segment opens with the alphabet's `-` or `_`, which
  // `path.extname` also does not treat as an extension.
  it.each([
    'IWFiYzptYXRyaXgub3Jn', // base64url of `!abc:matrix.org`
    'IX5-fjptYXRyaXgub3Jn', // base64url of `!~~~:matrix.org` — contains `-`
    '-_9xYZ', // opens with the two non-alphanumeric base64url characters
  ])('serves index.html for the client route /rooms/%s', async (segment) => {
    const res = await handler({ url: `trinity://app/rooms/${segment}` });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'none'",
    );
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-length')).toBe('13');
    expect(await res.text()).toBe('<html></html>');
    expect(createReadStreamMock).toHaveBeenCalledWith(INDEX_HTML);
  });

  // The other direction, and the reason the case above is not vacuous: a
  // fallback that answered everything with index.html would hide broken assets
  // behind a 200 of HTML.
  it('still 404s a genuinely missing asset', async () => {
    const res = await handler({ url: 'trinity://app/assets/nope.png' });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not Found');
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('serves a file that exists instead of falling back', async () => {
    const logo = path.join(WWW_ROOT, 'assets', 'logo.png');
    fakeFiles.set(logo, Buffer.from('png'));

    const res = await handler({ url: 'trinity://app/assets/logo.png' });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(createReadStreamMock).toHaveBeenCalledWith(logo);
    expect(createReadStreamMock).not.toHaveBeenCalledWith(INDEX_HTML);
  });
});

describe('registerAppProtocol — streaming', () => {
  let handler: (req: { url: string }) => Promise<Response>;

  beforeEach(() => {
    handleMock.mockClear();
    readFileMock.mockClear();
    createReadStreamMock.mockClear();
    fakeFiles.clear();
    streamFailures.clear();
    fakeFiles.set(INDEX_HTML, Buffer.from('<html></html>'));
    registerAppProtocol();
    handler = handleMock.mock.calls[0][1];
  });

  it('streams a binary file byte for byte without reading it whole', async () => {
    const bytes = randomBytes(4096);
    fakeFiles.set(path.join(WWW_ROOT, 'crypto.wasm'), bytes);

    const res = await handler({ url: 'trinity://app/crypto.wasm' });

    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(ReadableStream);
    expect(res.headers.get('content-type')).toBe('application/wasm');
    expect(res.headers.get('content-length')).toBe('4096');
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('keeps the frame protections on a streamed html file', async () => {
    fakeFiles.set(path.join(WWW_ROOT, 'page.html'), Buffer.from('<p>x</p>'));

    const res = await handler({ url: 'trinity://app/page.html' });

    expect(res.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'none'",
    );
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-length')).toBe('8');
  });

  it('answers 404 when the file vanishes between stat and open', async () => {
    const gone = path.join(WWW_ROOT, 'gone.js');
    fakeFiles.set(gone, Buffer.from('x'));
    streamFailures.add(gone);

    const res = await handler({ url: 'trinity://app/gone.js' });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not Found');
  });

  it('answers 404 when the index.html fallback cannot be read', async () => {
    fakeFiles.delete(INDEX_HTML);

    const res = await handler({ url: 'trinity://app/rooms' });

    expect(res.status).toBe(404);
  });
});
