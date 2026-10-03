import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const files = new Map<string, string>();
  const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
  const win = { webContents: {}, setIcon: vi.fn() };
  return {
    files,
    handlers,
    win,
    dockSetIcon: vi.fn(),
    setTrayIcon: vi.fn(),
    persistAppIcon: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/data', dock: { setIcon: mocks.dockSetIcon } },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => unknown) =>
      mocks.handlers.set(channel, fn),
  },
}));
vi.mock('node:fs', () => ({
  readFileSync: (path: string) => {
    if (!mocks.files.has(path)) throw new Error('ENOENT');
    return mocks.files.get(path);
  },
  writeFileSync: (path: string, data: string) => mocks.files.set(path, data),
}));
vi.mock('./icons', () => ({
  dockIconFile: (icon: string) =>
    icon === 'dark' ? 'icon-mac-dark.png' : 'icon-mac.png',
  resolveIconFile: (name: string) => `/res/${name}`,
  windowIconOptions: (_p: string, icon: string) => ({
    icon: `/res/${icon === 'dark' ? 'icon-dark.png' : 'icon.png'}`,
  }),
}));
vi.mock('./app-icon-persistence', () => ({
  persistAppIcon: mocks.persistAppIcon,
}));
vi.mock('./tray', () => ({ setTrayIcon: mocks.setTrayIcon }));
vi.mock('./window', () => ({ getMainWindow: () => mocks.win }));

import {
  SET_APP_ICON_CHANNEL,
  applyAppIcon,
  registerAppIconIpc,
} from './app-icon';
import { storedAppIcon, storedAppIconChoice } from './app-icon-state';

const platform = (value: NodeJS.Platform) =>
  Object.defineProperty(process, 'platform', { value, configurable: true });

beforeEach(() => {
  mocks.files.clear();
  mocks.handlers.clear();
  vi.clearAllMocks();
  platform('linux');
});

describe('app icon', () => {
  it('defaults to blurple and ignores a corrupt or foreign state file', () => {
    expect(storedAppIcon()).toBe('blurple');
    mocks.files.set('/data/app-icon.json', '{"icon":"pink"}');
    expect(storedAppIcon()).toBe('blurple');
    mocks.files.set('/data/app-icon.json', 'not json');
    expect(storedAppIcon()).toBe('blurple');
  });

  it('applies the window and tray icon on Windows/Linux and the Dock icon on macOS', () => {
    applyAppIcon('dark');
    expect(mocks.win.setIcon).toHaveBeenCalledWith('/res/icon-dark.png');
    expect(mocks.setTrayIcon).toHaveBeenCalledWith('dark');
    expect(mocks.dockSetIcon).not.toHaveBeenCalled();

    vi.clearAllMocks();
    platform('darwin');
    applyAppIcon('dark');
    expect(mocks.dockSetIcon).toHaveBeenCalledWith('/res/icon-mac-dark.png');
    expect(mocks.win.setIcon).not.toHaveBeenCalled();
    expect(mocks.setTrayIcon).not.toHaveBeenCalled();
  });

  it('serves only the main window, validates the name, persists and applies it', async () => {
    registerAppIconIpc();
    const handle = mocks.handlers.get(SET_APP_ICON_CHANNEL)!;
    expect(await handle({ sender: {} }, 'dark')).toBe(false);
    expect(await handle({ sender: mocks.win.webContents }, 'pink')).toBe(false);
    expect(mocks.files.size).toBe(0);

    expect(await handle({ sender: mocks.win.webContents }, 'dark')).toBe(true);
    expect(storedAppIcon()).toBe('dark');
    expect(mocks.win.setIcon).toHaveBeenCalledWith('/res/icon-dark.png');
  });

  it('does not re-apply an unchanged icon', async () => {
    registerAppIconIpc();
    const handle = mocks.handlers.get(SET_APP_ICON_CHANNEL)!;
    await handle({ sender: mocks.win.webContents }, 'dark');
    mocks.win.setIcon.mockClear();
    expect(await handle({ sender: mocks.win.webContents }, 'dark')).toBe(true);
    expect(mocks.win.setIcon).not.toHaveBeenCalled();
  });

  it('keeps a changed icon after quit, and re-applies a stored Dark one at startup', async () => {
    registerAppIconIpc();
    expect(mocks.persistAppIcon).not.toHaveBeenCalled();
    const handle = mocks.handlers.get(SET_APP_ICON_CHANNEL)!;
    await handle({ sender: mocks.win.webContents }, 'dark');
    expect(mocks.persistAppIcon).toHaveBeenCalledWith('dark');

    mocks.persistAppIcon.mockClear();
    registerAppIconIpc();
    expect(mocks.persistAppIcon).toHaveBeenCalledWith('dark');
  });

  it('hands the macOS icon back to the system for Match system, elsewhere refuses it', async () => {
    registerAppIconIpc();
    const handle = mocks.handlers.get(SET_APP_ICON_CHANNEL)!;
    expect(await handle({ sender: mocks.win.webContents }, 'system')).toBe(
      false,
    );

    platform('darwin');
    expect(await handle({ sender: mocks.win.webContents }, 'system')).toBe(
      true,
    );
    expect(mocks.dockSetIcon).toHaveBeenCalledWith(null);
    expect(mocks.persistAppIcon).toHaveBeenCalledWith('system');
    expect(storedAppIconChoice()).toBe('system');
    expect(storedAppIcon()).toBe('blurple');

    vi.clearAllMocks();
    registerAppIconIpc();
    expect(mocks.dockSetIcon).not.toHaveBeenCalled();
    expect(mocks.persistAppIcon).not.toHaveBeenCalled();
  });
});
