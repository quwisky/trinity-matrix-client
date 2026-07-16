import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fakes for the native surface the badge touches. vi.hoisted so they exist when
// the mock factories run. `mainWindowRef` is a mutable holder the getMainWindow
// mock reads, letting each test swap in a fake window (or null).
const {
  handlers,
  setBadgeCount,
  setOverlayIcon,
  createFromPath,
  mainWindowRef,
} = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
  setBadgeCount: vi.fn(),
  setOverlayIcon: vi.fn(),
  createFromPath: vi.fn(() => ({ isEmpty: () => false })),
  mainWindowRef: { current: null as { setOverlayIcon: unknown } | null },
}));

vi.mock('electron', () => ({
  app: { setBadgeCount },
  nativeImage: { createFromPath },
  ipcMain: {
    on: (
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => void,
    ) => {
      handlers.set(channel, handler);
    },
  },
}));

// Overlay-asset lookup: pretend the bundled red-dot PNG is always present.
vi.mock('./icons', () => ({
  iconCandidatePaths: () => ['/fake/build/unreadOverlay.png'],
}));
vi.mock('node:fs', () => ({ existsSync: () => true }));

// Main window accessor — tests drive it via mainWindowRef.current.
vi.mock('./window', () => ({
  getMainWindow: () => mainWindowRef.current,
}));

import { registerDockBadge, SET_BADGE_COUNT_CHANNEL } from './dock-badge';

// Register once and grab the captured handler; each test drives it directly.
registerDockBadge();
const handler = handlers.get(SET_BADGE_COUNT_CHANNEL);

/** The main window's webContents — the only sender the handler accepts. */
const webContents = { id: 1 };

/** Deliver a payload to the captured IPC handler as our own renderer would. */
function send(count: unknown): void {
  handler?.({ sender: webContents }, count);
}

/** Deliver a payload as some OTHER webContents would (must be ignored). */
function sendFromForeignSender(count: unknown): void {
  handler?.({ sender: { id: 99 } }, count);
}

const realPlatform = process.platform;
/** Override process.platform for the duration of a test (restored in afterEach). */
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

describe('dock badge IPC', () => {
  beforeEach(() => {
    setBadgeCount.mockClear();
    setOverlayIcon.mockClear();
    createFromPath.mockClear();
    mainWindowRef.current = { webContents };
  });
  afterEach(() => setPlatform(realPlatform));

  it('registers a handler on the badge channel', () => {
    expect(handler).toBeTypeOf('function');
  });

  it('ignores a payload from any sender other than the main window', () => {
    setPlatform('darwin');
    sendFromForeignSender(7);
    expect(setBadgeCount).not.toHaveBeenCalled();
  });

  describe('non-Windows (macOS / Linux Unity) — app.setBadgeCount', () => {
    beforeEach(() => setPlatform('darwin'));

    it('sets the badge to a valid integer count', () => {
      send(5);
      expect(setBadgeCount).toHaveBeenCalledExactlyOnceWith(5);
      expect(setOverlayIcon).not.toHaveBeenCalled();
    });

    it('clears the badge (0) for a zero count', () => {
      send(0);
      expect(setBadgeCount).toHaveBeenCalledExactlyOnceWith(0);
    });

    it('floors a fractional count', () => {
      send(3.9);
      expect(setBadgeCount).toHaveBeenCalledExactlyOnceWith(3);
    });

    it('clamps a negative count to 0', () => {
      send(-7);
      expect(setBadgeCount).toHaveBeenCalledExactlyOnceWith(0);
    });

    it('clamps a huge count to 9999', () => {
      send(1_000_000);
      expect(setBadgeCount).toHaveBeenCalledExactlyOnceWith(9999);
    });

    it('ignores a non-number payload', () => {
      send('5');
      expect(setBadgeCount).not.toHaveBeenCalled();
    });

    it('ignores NaN', () => {
      send(Number.NaN);
      expect(setBadgeCount).not.toHaveBeenCalled();
    });

    it('ignores Infinity', () => {
      send(Number.POSITIVE_INFINITY);
      expect(setBadgeCount).not.toHaveBeenCalled();
    });
  });

  describe('Windows — taskbar overlay icon', () => {
    beforeEach(() => {
      setPlatform('win32');
      mainWindowRef.current = { setOverlayIcon, webContents };
    });

    it('sets a non-null overlay with the count in the description', () => {
      send(5);
      expect(setOverlayIcon).toHaveBeenCalledTimes(1);
      const [image, description] = setOverlayIcon.mock.calls[0];
      expect(image).not.toBeNull();
      expect(description).toContain('5');
      expect(description).toBe('5 unread');
      // Windows must not touch the numeric dock badge.
      expect(setBadgeCount).not.toHaveBeenCalled();
    });

    it('shows a short "99+" description for a large count', () => {
      send(250);
      const [, description] = setOverlayIcon.mock.calls[0];
      expect(description).toBe('99+ unread');
    });

    it('clears the overlay with a null image for a zero count', () => {
      send(0);
      expect(setOverlayIcon).toHaveBeenCalledExactlyOnceWith(null, '');
    });

    it('ignores a malformed payload (leaves the overlay untouched)', () => {
      send('nope');
      expect(setOverlayIcon).not.toHaveBeenCalled();
    });

    it('does not throw when there is no main window', () => {
      mainWindowRef.current = null;
      expect(() => send(3)).not.toThrow();
      expect(setOverlayIcon).not.toHaveBeenCalled();
      expect(setBadgeCount).not.toHaveBeenCalled();
    });
  });
});
