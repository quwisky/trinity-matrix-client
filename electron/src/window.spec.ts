import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('./icons', () => ({ windowIconOptions: vi.fn(() => ({})) }));
vi.mock('./window-prefs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./window-prefs')>()),
  readWindowPrefs: vi.fn(() => ({ systemTitleBar: false })),
}));

import { BrowserWindow } from 'electron';
import {
  createWindow,
  hardenContents,
  installPermissionPolicy,
  isSystemTitleBarActive,
} from './window';
import { readWindowPrefs, titleBarOptions } from './window-prefs';

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

  it('allows the trusted main frame to request persistent storage', () => {
    const s = fakeSession();
    installPermissionPolicy(s as never);
    const request = s.setPermissionRequestHandler.mock.calls[0][0];
    const granted = vi.fn();

    request(appContents, 'persistent-storage', granted, {
      isMainFrame: true,
      requestingUrl: 'trinity://app/rooms',
    });

    expect(granted).toHaveBeenCalledWith(true);
  });

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
    expect(decide('fullscreen')).toBe(true); // video player's fullscreen button
    expect(decide('fullscreen', { isMainFrame: false })).toBe(false);
    expect(
      decide('fullscreen', {
        isMainFrame: true,
        requestingUrl: 'https://widgets.example/',
      }),
    ).toBe(false);
    expect(decide('notifications')).toBe(false);
    expect(decide('clipboard-read')).toBe(false);
    expect(decide('openExternal')).toBe(false);
    expect(decide('media', { mediaTypes: ['audio'], isMainFrame: false })).toBe(
      false,
    );
    expect(decide('clipboard-sanitized-write', { isMainFrame: false })).toBe(
      false,
    );
    expect(
      decide('clipboard-sanitized-write', {
        isMainFrame: true,
        requestingUrl: 'https://widgets.example/',
      }),
    ).toBe(false);
    expect(decide('geolocation', undefined, remoteContents)).toBe(false);
    expect(decide('clipboard-sanitized-write', undefined, remoteContents)).toBe(
      false,
    );
  });

  it('allows the trusted main frame to query persistent storage', () => {
    const s = fakeSession();
    installPermissionPolicy(s as never);
    const check = s.setPermissionCheckHandler.mock.calls[0][0];

    expect(
      check(appContents, 'persistent-storage', 'trinity://app', {
        isMainFrame: true,
        requestingUrl: 'trinity://app/rooms',
      }),
    ).toBe(true);
  });

  it.each([
    ['child frame', appContents, 'trinity://app/rooms', false],
    ['remote requesting URL', appContents, 'https://widgets.example/', true],
    ['remote contents', remoteContents, 'trinity://app/rooms', true],
    ['missing requesting URL', appContents, undefined, true],
    ['missing frame identity', appContents, 'trinity://app/rooms', undefined],
    ['spoofed host', appContents, 'trinity://app.evil/rooms', true],
    ['URL credentials', appContents, 'trinity://user@app/rooms', true],
  ])(
    'denies persistent storage for %s',
    (_name, contents, url, isMainFrame) => {
      const s = fakeSession();
      installPermissionPolicy(s as never);
      const request = s.setPermissionRequestHandler.mock.calls[0][0];
      const check = s.setPermissionCheckHandler.mock.calls[0][0];
      const granted = vi.fn();
      const details = { isMainFrame, requestingUrl: url };

      request(contents, 'persistent-storage', granted, details);
      expect(granted).toHaveBeenCalledWith(false);
      expect(check(contents, 'persistent-storage', url, details)).toBe(false);
    },
  );

  it('denies a persistent-storage check without WebContents', () => {
    const s = fakeSession();
    installPermissionPolicy(s as never);
    const check = s.setPermissionCheckHandler.mock.calls[0][0];

    expect(
      check(null, 'persistent-storage', 'trinity://app', { isMainFrame: true }),
    ).toBe(false);
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
      check(
        appContents,
        'clipboard-sanitized-write',
        'https://widgets.example',
        { isMainFrame: true },
      ),
    ).toBe(false);
    expect(
      check(appContents, 'midi', 'trinity://app', { isMainFrame: true }),
    ).toBe(false);
  });
});

describe('titleBarOptions', () => {
  it('hides the frame with a themed overlay on Windows', () => {
    expect(titleBarOptions('win32', { systemTitleBar: false })).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0d0d0f', symbolColor: '#dddee1', height: 32 },
    });
  });

  it('hides the frame on Linux', () => {
    expect(titleBarOptions('linux', { systemTitleBar: false })).toMatchObject({
      titleBarStyle: 'hidden',
    });
  });

  it('positions the traffic lights on macOS', () => {
    expect(titleBarOptions('darwin', { systemTitleBar: false })).toEqual({
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 12, y: 10 },
    });
  });

  it('keeps the system title bar when opted in', () => {
    expect(titleBarOptions('linux', { systemTitleBar: true })).toEqual({});
  });
});

describe('createWindow title bar', () => {
  const setMenuBarVisibility = vi.fn();
  const originalPlatform = process.platform;

  afterEach(() => {
    setMenuBarVisibility.mockClear();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  function create() {
    let options: Record<string, unknown> = {};
    vi.mocked(BrowserWindow).mockImplementation(function (
      this: unknown,
      opts: unknown,
    ) {
      options = opts as Record<string, unknown>;
      return {
        webContents: {
          setWindowOpenHandler: vi.fn(),
          on: vi.fn(),
          ipc: { on: vi.fn() },
        },
        once: vi.fn(),
        on: vi.fn(),
        loadURL: vi.fn(() => Promise.resolve()),
        setMenuBarVisibility,
      };
    } as never);
    createWindow();
    return options;
  }

  it.each(['win32', 'linux'] as const)(
    'hides the native menu bar behind the title row on %s',
    (platform) => {
      Object.defineProperty(process, 'platform', { value: platform });
      create();
      expect(setMenuBarVisibility).toHaveBeenCalledExactlyOnceWith(false);
    },
  );

  it('records the title-bar mode the window was created with', () => {
    vi.mocked(readWindowPrefs).mockReturnValueOnce({ systemTitleBar: true });
    create();
    expect(isSystemTitleBarActive()).toBe(true);
    create();
    expect(isSystemTitleBarActive()).toBe(false);
  });

  it('leaves the macOS menu bar alone', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    create();
    expect(setMenuBarVisibility).not.toHaveBeenCalled();
  });

  it('paints the Graphite dark app surface before the renderer loads', () => {
    expect(create()['backgroundColor']).toBe('#0d0d0f');
  });

  it.each([
    [false, '--trinity-title-bar=row'],
    [true, '--trinity-title-bar=system'],
  ])(
    'tells the renderer the running title-bar mode (system bar %s)',
    (systemTitleBar, argument) => {
      vi.mocked(readWindowPrefs).mockReturnValueOnce({ systemTitleBar });
      const webPreferences = create()['webPreferences'] as {
        additionalArguments?: string[];
      };
      expect(webPreferences.additionalArguments).toEqual([argument]);
    },
  );

  it('passes the frameless options', () => {
    expect(create()).toMatchObject({
      titleBarStyle: 'hidden',
      autoHideMenuBar: false,
    });
  });

  it('keeps the OS frame and menu bar with the system title bar', () => {
    vi.mocked(readWindowPrefs).mockReturnValueOnce({ systemTitleBar: true });
    const options = create();
    expect(options['titleBarStyle']).toBeUndefined();
    expect(options['autoHideMenuBar']).toBe(false);
    expect(setMenuBarVisibility).not.toHaveBeenCalled();
  });
});

describe('createWindow close requested by the page', () => {
  it('closes the window like a user close, which hides it to the tray', () => {
    const close = vi.fn();
    const ipcOn = vi.fn();
    vi.mocked(BrowserWindow).mockImplementation(function () {
      return {
        webContents: {
          setWindowOpenHandler: vi.fn(),
          on: vi.fn(),
          ipc: { on: ipcOn },
        },
        once: vi.fn(),
        on: vi.fn(),
        loadURL: vi.fn(() => Promise.resolve()),
        setMenuBarVisibility: vi.fn(),
        close,
      };
    } as never);
    createWindow();

    const [channel, listener] = ipcOn.mock.calls[0] ?? [];
    expect(channel).toBe('trinity:window:close');
    (listener as () => void)();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('createWindow visibility', () => {
  function create() {
    const listeners = new Map<string, () => void>();
    const send = vi.fn();
    vi.mocked(BrowserWindow).mockImplementation(function () {
      return {
        webContents: {
          setWindowOpenHandler: vi.fn(),
          on: vi.fn(),
          ipc: { on: vi.fn() },
          send,
          isDestroyed: () => false,
        },
        once: vi.fn(),
        on: vi.fn((event: string, listener: () => void) =>
          listeners.set(event, listener),
        ),
        loadURL: vi.fn(() => Promise.resolve()),
        setMenuBarVisibility: vi.fn(),
      };
    } as never);
    createWindow();
    return { listeners, send };
  }

  it.each([
    ['hide', 'hidden'],
    ['minimize', 'hidden'],
    ['show', 'visible'],
    ['restore', 'visible'],
  ])('tells the renderer it is %s', (event, visibility) => {
    const { listeners, send } = create();

    listeners.get(event)?.();

    expect(send).toHaveBeenCalledExactlyOnceWith(
      'trinity:host:v1:lifecycle:visibility',
      visibility,
    );
  });
});
