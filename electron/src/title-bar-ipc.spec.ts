import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: { sender: unknown }, payload?: unknown) => unknown;

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Handler>(),
  handlers: new Map<string, Handler>(),
  mainWindowRef: {
    current: null as {
      webContents: object;
      setTitleBarOverlay: ReturnType<typeof vi.fn>;
    } | null,
  },
  popup: vi.fn(),
  getApplicationMenu: vi.fn(),
  relaunch: vi.fn(),
  exit: vi.fn(),
  readWindowPrefs: vi.fn(() => ({ systemTitleBar: false })),
  writeWindowPrefs: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { relaunch: mocks.relaunch, exit: mocks.exit },
  ipcMain: {
    on: (channel: string, handler: Handler) =>
      mocks.listeners.set(channel, handler),
    handle: (channel: string, handler: Handler) =>
      mocks.handlers.set(channel, handler),
  },
  Menu: { getApplicationMenu: mocks.getApplicationMenu },
}));
vi.mock('./window', () => ({
  getMainWindow: () => mocks.mainWindowRef.current,
}));
vi.mock('./window-prefs', () => ({
  readWindowPrefs: mocks.readWindowPrefs,
  writeWindowPrefs: mocks.writeWindowPrefs,
}));

import { registerTitleBarIpc } from './title-bar-ipc';

const CHANNEL = 'trinity:host:v1:title-bar';
const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

function ownSender(): object {
  return mocks.mainWindowRef.current!.webContents;
}

function send(operation: string, sender: unknown, payload?: unknown): void {
  mocks.listeners.get(`${CHANNEL}:${operation}`)?.({ sender }, payload);
}

function invoke(
  operation: string,
  sender: unknown,
  payload?: unknown,
): Promise<unknown> {
  return Promise.resolve(
    mocks.handlers.get(`${CHANNEL}:${operation}`)?.({ sender }, payload),
  );
}

describe('title-bar IPC', () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.handlers.clear();
    mocks.mainWindowRef.current = {
      webContents: {},
      setTitleBarOverlay: vi.fn(),
    };
    mocks.getApplicationMenu.mockReturnValue({ popup: mocks.popup });
    setPlatform('win32');
    registerTitleBarIpc();
  });

  afterEach(() => {
    vi.clearAllMocks();
    setPlatform(originalPlatform);
  });

  describe('set-overlay', () => {
    it('themes the window overlay from the main window', () => {
      send('set-overlay', ownSender(), {
        color: '#121214',
        symbolColor: '#dbdee1',
      });
      expect(
        mocks.mainWindowRef.current!.setTitleBarOverlay,
      ).toHaveBeenCalledWith({
        color: '#121214',
        symbolColor: '#dbdee1',
        height: 32,
      });
    });

    it.each([
      ['a colour name', { color: 'red', symbolColor: '#dbdee1' }],
      ['a short hex', { color: '#12', symbolColor: '#dbdee1' }],
      ['a missing field', { color: '#121214' }],
      ['an object field', { color: {}, symbolColor: '#dbdee1' }],
      ['a non-object', 'red'],
    ])('ignores %s', (_label, payload) => {
      send('set-overlay', ownSender(), payload);
      expect(
        mocks.mainWindowRef.current!.setTitleBarOverlay,
      ).not.toHaveBeenCalled();
    });

    it('ignores a foreign sender', () => {
      send('set-overlay', {}, { color: '#121214', symbolColor: '#dbdee1' });
      expect(
        mocks.mainWindowRef.current!.setTitleBarOverlay,
      ).not.toHaveBeenCalled();
    });

    it('does nothing on macOS, which has no overlay', () => {
      setPlatform('darwin');
      send('set-overlay', ownSender(), {
        color: '#121214',
        symbolColor: '#dbdee1',
      });
      expect(
        mocks.mainWindowRef.current!.setTitleBarOverlay,
      ).not.toHaveBeenCalled();
    });
  });

  describe('popup-menu', () => {
    it('pops the application menu up at the given point', () => {
      send('popup-menu', ownSender(), { x: 8, y: 32 });
      expect(mocks.getApplicationMenu).toHaveBeenCalled();
      expect(mocks.popup).toHaveBeenCalledWith({
        window: mocks.mainWindowRef.current,
        x: 8,
        y: 32,
      });
    });

    it.each([
      ['a fraction', { x: 8.5, y: 32 }],
      ['a negative', { x: -1, y: 32 }],
      ['an out-of-range value', { x: 8, y: 10001 }],
      ['a string', { x: '8', y: 32 }],
      ['a missing field', { x: 8 }],
      ['a non-object', null],
    ])('ignores %s', (_label, payload) => {
      send('popup-menu', ownSender(), payload);
      expect(mocks.popup).not.toHaveBeenCalled();
    });

    it('ignores a foreign sender', () => {
      send('popup-menu', {}, { x: 8, y: 32 });
      expect(mocks.popup).not.toHaveBeenCalled();
    });

    it('does nothing without an application menu', () => {
      mocks.getApplicationMenu.mockReturnValue(null);
      expect(() =>
        send('popup-menu', ownSender(), { x: 8, y: 32 }),
      ).not.toThrow();
    });
  });

  describe('system title bar preference', () => {
    it('reads the stored preference', async () => {
      mocks.readWindowPrefs.mockReturnValueOnce({ systemTitleBar: true });
      await expect(invoke('get-system-title-bar', ownSender())).resolves.toBe(
        true,
      );
    });

    it('answers a foreign sender with false without reading', async () => {
      await expect(invoke('get-system-title-bar', {})).resolves.toBe(false);
      expect(mocks.readWindowPrefs).not.toHaveBeenCalled();
    });

    it('writes a boolean preference', async () => {
      await expect(
        invoke('set-system-title-bar', ownSender(), true),
      ).resolves.toEqual({ kind: 'completed' });
      expect(mocks.writeWindowPrefs).toHaveBeenCalledWith({
        systemTitleBar: true,
      });
    });

    it.each([['true'], [1], [null], [{ systemTitleBar: true }]])(
      'rejects the non-boolean %j',
      async (payload) => {
        await expect(
          invoke('set-system-title-bar', ownSender(), payload),
        ).resolves.toEqual({
          kind: 'rejected',
          diagnostic: { code: 'invalid-system-title-bar' },
        });
        expect(mocks.writeWindowPrefs).not.toHaveBeenCalled();
      },
    );

    it('ignores a foreign sender', async () => {
      await expect(invoke('set-system-title-bar', {}, true)).resolves.toEqual({
        kind: 'rejected',
        diagnostic: { code: 'sender-rejected' },
      });
      expect(mocks.writeWindowPrefs).not.toHaveBeenCalled();
    });

    it('reports a failed write instead of throwing across IPC', async () => {
      mocks.writeWindowPrefs.mockImplementationOnce(() => {
        throw new Error('EACCES: /secret/path');
      });
      await expect(
        invoke('set-system-title-bar', ownSender(), true),
      ).resolves.toEqual({
        kind: 'rejected',
        diagnostic: { code: 'window-prefs-write-failed' },
      });
    });
  });

  describe('relaunch', () => {
    it('relaunches and exits from the main window', () => {
      send('relaunch', ownSender());
      expect(mocks.relaunch).toHaveBeenCalled();
      expect(mocks.exit).toHaveBeenCalledWith(0);
      expect(mocks.relaunch.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.exit.mock.invocationCallOrder[0],
      );
    });

    it('ignores a foreign sender', () => {
      send('relaunch', {});
      expect(mocks.relaunch).not.toHaveBeenCalled();
      expect(mocks.exit).not.toHaveBeenCalled();
    });

    it('ignores every request while no main window exists', () => {
      const sender = ownSender();
      mocks.mainWindowRef.current = null;
      send('relaunch', sender);
      expect(mocks.relaunch).not.toHaveBeenCalled();
    });
  });
});
