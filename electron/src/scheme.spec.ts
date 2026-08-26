import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the handler registered with protocol.handle so we can drive it directly.
// vi.hoisted so the mock var exists when the hoisted vi.mock factory runs.
const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }));
vi.mock('electron', () => ({
  protocol: { handle: handleMock, registerSchemesAsPrivileged: vi.fn() },
}));

// The handler reads the served build from disk, but `www/` is a copied build
// output (gitignored, absent on a fresh checkout), so the file system is faked:
// `fakeFiles` is the set of paths that exist, everything else raises ENOENT.
const { fakeFiles, statMock, readFileMock } = vi.hoisted(() => {
  const fakeFiles = new Set<string>();
  return {
    fakeFiles,
    statMock: vi.fn(async (filePath: string) => {
      if (!fakeFiles.has(filePath)) {
        throw Object.assign(new Error(`ENOENT: ${filePath}`), {
          code: 'ENOENT',
        });
      }
      return { isFile: () => true };
    }),
    readFileMock: vi.fn(async (filePath: string) =>
      Buffer.from(`body of ${filePath}`),
    ),
  };
});
vi.mock('node:fs', () => ({
  promises: { stat: statMock, readFile: readFileMock },
}));

import * as path from 'node:path';

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
    fakeFiles.clear();
    fakeFiles.add(INDEX_HTML);
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
    expect(readFileMock).toHaveBeenCalledWith(INDEX_HTML);
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
    fakeFiles.add(logo);

    const res = await handler({ url: 'trinity://app/assets/logo.png' });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(readFileMock).toHaveBeenCalledWith(logo);
    expect(readFileMock).not.toHaveBeenCalledWith(INDEX_HTML);
  });
});
