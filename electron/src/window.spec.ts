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

import { hardenContents } from './window';

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
