import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the handler registered with protocol.handle so we can drive it directly.
// vi.hoisted so the mock var exists when the hoisted vi.mock factory runs.
const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }));
vi.mock('electron', () => ({
  protocol: { handle: handleMock, registerSchemesAsPrivileged: vi.fn() },
}));

import { contentTypeFor, isAppUrl, registerAppProtocol } from './scheme';

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
  // Security-relevant guarantee: URLs on other origins (and garbage) are never
  // treated as app URLs. (A positive `trinity://app/...` case can't be asserted
  // here — URL.origin is opaque for a non-special scheme until Electron registers
  // it as `standard` at runtime; that's out of scope for a unit test.)
  it('rejects external origins and malformed input', () => {
    expect(isAppUrl('https://evil.example/app')).toBe(false);
    expect(isAppUrl('http://app/')).toBe(false);
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
