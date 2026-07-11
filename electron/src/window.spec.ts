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

  it('allows only microphone (audio) and geolocation; denies the rest', () => {
    const s = fakeSession();
    installPermissionPolicy(s as never);
    const request = s.setPermissionRequestHandler.mock.calls[0][0] as (
      c: unknown,
      p: string,
      cb: (ok: boolean) => void,
      d?: { mediaTypes?: string[] },
    ) => void;
    const decide = (
      permission: string,
      details?: { mediaTypes?: string[] },
    ) => {
      let granted: boolean | undefined;
      request(null, permission, (ok) => (granted = ok), details);
      return granted;
    };

    expect(decide('media', { mediaTypes: ['audio'] })).toBe(true); // mic
    expect(decide('media', { mediaTypes: ['audio', 'video'] })).toBe(false); // camera
    expect(decide('geolocation')).toBe(true);
    expect(decide('notifications')).toBe(false);
    expect(decide('clipboard-read')).toBe(false);
    expect(decide('openExternal')).toBe(false);
  });

  it('the sync check handler mirrors the request policy', () => {
    const s = fakeSession();
    installPermissionPolicy(s as never);
    const check = s.setPermissionCheckHandler.mock.calls[0][0] as (
      c: unknown,
      p: string,
    ) => boolean;

    expect(check(null, 'geolocation')).toBe(true);
    expect(check(null, 'media')).toBe(true);
    expect(check(null, 'midi')).toBe(false);
  });
});
