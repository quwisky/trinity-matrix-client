import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock('electron', () => ({
  shell: { openExternal },
  // window.ts (and its ./deep-link import) reference these at module load.
  app: {
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    isReady: vi.fn(() => false),
  },
  BrowserWindow: vi.fn(),
}));

import { hardenContents, installPermissionPolicy } from './window';

/** Minimal WebContents fake that records its window-open handler + event listeners. */
function fakeContents() {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  return {
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((evt: string, cb: (...args: unknown[]) => void) => {
      listeners[evt] = cb;
    }),
    emit: (evt: string, ...args: unknown[]) => listeners[evt]?.(...args),
  };
}

describe('hardenContents', () => {
  beforeEach(() => openExternal.mockClear());

  it('denies every window.open, opening only http(s) externally', () => {
    const c = fakeContents();
    hardenContents(c as never);
    const handler = c.setWindowOpenHandler.mock.calls[0][0] as (a: {
      url: string;
    }) => unknown;

    expect(handler({ url: 'https://example.com' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledWith('https://example.com');

    // A non-http URL is still denied, but not handed to the OS browser.
    openExternal.mockClear();
    expect(handler({ url: 'trinity://app/rooms' })).toEqual({ action: 'deny' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('blocks navigation to an external URL and opens it externally instead', () => {
    const c = fakeContents();
    hardenContents(c as never);
    const event = { preventDefault: vi.fn() };
    c.emit('will-navigate', event, 'https://evil.example/phish');

    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://evil.example/phish');
  });

  it('blocks webview attachment', () => {
    const c = fakeContents();
    hardenContents(c as never);
    const event = { preventDefault: vi.fn() };
    c.emit('will-attach-webview', event);
    expect(event.preventDefault).toHaveBeenCalled();
  });
});

describe('installPermissionPolicy', () => {
  function fakeSession() {
    return {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    };
  }

  const appContents = { getURL: () => 'trinity://app/rooms' };
  const remoteContents = { getURL: () => 'https://widgets.example/' };

  it('allows only the trusted main frame to use app capabilities', () => {
    const s = fakeSession();
    installPermissionPolicy(s as never);
    const request = s.setPermissionRequestHandler.mock.calls[0][0] as (
      c: unknown,
      p: string,
      cb: (ok: boolean) => void,
      d?: {
        mediaTypes?: string[];
        isMainFrame?: boolean;
        requestingUrl?: string;
      },
    ) => void;
    const decide = (
      permission: string,
      details: {
        mediaTypes?: string[];
        isMainFrame?: boolean;
        requestingUrl?: string;
      } = { isMainFrame: true, requestingUrl: 'trinity://app/rooms' },
      contents: unknown = appContents,
    ) => {
      let granted: boolean | undefined;
      request(contents, permission, (ok) => (granted = ok), {
        isMainFrame: true,
        requestingUrl: 'trinity://app/rooms',
        ...details,
      });
      return granted;
    };

    expect(decide('media', { mediaTypes: ['audio'] })).toBe(true); // mic
    expect(decide('media', { mediaTypes: ['video'] })).toBe(true); // QR camera
    expect(decide('media', { mediaTypes: ['audio', 'video'] })).toBe(true);
    expect(decide('geolocation')).toBe(true);
    expect(decide('clipboard-sanitized-write')).toBe(true);
    expect(decide('notifications')).toBe(false);
    expect(decide('clipboard-read')).toBe(false);
    expect(decide('openExternal')).toBe(false);
    expect(decide('media', { mediaTypes: ['audio'], isMainFrame: false })).toBe(
      false,
    );
    expect(decide('clipboard-sanitized-write', { isMainFrame: false })).toBe(
      false,
    );
    expect(decide('geolocation', undefined, remoteContents)).toBe(false);
    expect(decide('clipboard-sanitized-write', undefined, remoteContents)).toBe(
      false,
    );
  });

  it('the sync check handler mirrors the request policy', () => {
    const s = fakeSession();
    installPermissionPolicy(s as never);
    const check = s.setPermissionCheckHandler.mock.calls[0][0] as (
      c: unknown,
      p: string,
      origin: string,
      details?: { isMainFrame?: boolean },
    ) => boolean;

    expect(
      check(appContents, 'geolocation', 'trinity://app', { isMainFrame: true }),
    ).toBe(true);
    expect(
      check(appContents, 'media', 'trinity://app', { isMainFrame: true }),
    ).toBe(true);
    expect(
      check(appContents, 'clipboard-sanitized-write', 'trinity://app', {
        isMainFrame: true,
      }),
    ).toBe(true);
    expect(
      check(appContents, 'clipboard-read', 'trinity://app', {
        isMainFrame: true,
      }),
    ).toBe(false);
    expect(
      check(appContents, 'media', 'https://widgets.example', {
        isMainFrame: false,
      }),
    ).toBe(false);
    expect(
      check(remoteContents, 'geolocation', 'https://widgets.example', {
        isMainFrame: true,
      }),
    ).toBe(false);
    expect(
      check(remoteContents, 'clipboard-sanitized-write', 'trinity://app', {
        isMainFrame: true,
      }),
    ).toBe(false);
    expect(
      check(appContents, 'midi', 'trinity://app', { isMainFrame: true }),
    ).toBe(false);
  });
});
