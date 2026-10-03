import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  files: new Map<string, string | Buffer>(),
  app: { isPackaged: true },
  execFile: vi.fn(),
  links: new Map<string, string>(),
  writeShortcutLink: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.app.isPackaged;
    },
    getPath: (name: string) =>
      ({
        exe: '/Applications/Trinity.app/Contents/MacOS/Trinity',
        appData: 'C:/Users/u/AppData/Roaming',
        desktop: 'C:/Users/u/Desktop',
        userData: '/data',
      })[name],
  },
  nativeImage: {
    createFromPath: () => ({
      resize: () => ({ toPNG: () => Buffer.from('PNGDATA') }),
    }),
  },
  shell: {
    readShortcutLink: (link: string) => ({ target: mocks.links.get(link) }),
    writeShortcutLink: mocks.writeShortcutLink,
  },
}));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('node:fs', () => {
  const fs = {
    existsSync: (file: string) =>
      mocks.files.has(file) || mocks.links.has(file),
    readFileSync: (file: string) => {
      if (!mocks.files.has(file)) throw new Error('ENOENT');
      return mocks.files.get(file);
    },
    readdirSync: (dir: string) =>
      [...mocks.files.keys()]
        .filter((file) => file.startsWith(`${dir}/`))
        .map((file) => file.slice(dir.length + 1)),
    writeFileSync: (file: string, data: string | Buffer) =>
      mocks.files.set(file, data),
    mkdirSync: () => undefined,
    rmSync: (file: string) => mocks.files.delete(file),
  };
  return { default: fs, ...fs };
});
vi.mock('./icons', () => ({
  dockIconFile: (icon: string) =>
    icon === 'dark' ? 'icon-mac-dark.png' : 'icon-mac.png',
  resolveIconFile: (name: string) => `/res/${name}`,
}));

import { persistAppIcon } from './app-icon-persistence';

const platform = (value: NodeJS.Platform) =>
  Object.defineProperty(process, 'platform', { value, configurable: true });

beforeEach(() => {
  mocks.files.clear();
  mocks.links.clear();
  mocks.app.isPackaged = true;
  vi.clearAllMocks();
  delete process.env['APPIMAGE'];
  process.env['XDG_DATA_HOME'] = '/home/u/.local/share';
  process.env['XDG_DATA_DIRS'] = '/usr/share';
});

describe('persistAppIcon', () => {
  it('does nothing in an unpackaged build', () => {
    mocks.app.isPackaged = false;
    platform('darwin');
    persistAppIcon('dark');
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('sets the dark icon on the macOS bundle, and clears it for Blurple', () => {
    platform('darwin');
    persistAppIcon('dark');
    expect(mocks.execFile).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining([
        '-l',
        'JavaScript',
        '/Applications/Trinity.app',
        '/res/icon-mac-dark.png',
      ]),
      expect.any(Function),
    );

    persistAppIcon('blurple');
    persistAppIcon('system');
    for (const call of mocks.execFile.mock.calls.slice(1)) {
      expect(call[1].slice(-2)).toEqual(['/Applications/Trinity.app', '']);
    }
  });

  it("points only Trinity's own Windows shortcuts at a dark .ico, and back at the exe", () => {
    platform('win32');
    const start =
      'C:/Users/u/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Trinity.lnk';
    const pinned =
      'C:/Users/u/AppData/Roaming/Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar/Trinity.lnk';
    const desktop = 'C:/Users/u/Desktop/Trinity.lnk';
    mocks.links.set(start, process.execPath);
    mocks.links.set(pinned, process.execPath);
    mocks.links.set(desktop, 'C:/Other/app.exe');

    persistAppIcon('dark');
    const ico = mocks.files.get('/data/icon-dark.ico') as Buffer;
    expect([ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([1, 1]);
    expect(ico.subarray(22).toString()).toBe('PNGDATA');
    const dark = {
      target: process.execPath,
      icon: '/data/icon-dark.ico',
      iconIndex: 0,
    };
    expect(mocks.writeShortcutLink.mock.calls).toEqual([
      [start, 'update', dark],
      [pinned, 'update', dark],
    ]);

    mocks.writeShortcutLink.mockClear();
    persistAppIcon('blurple');
    expect(mocks.writeShortcutLink).toHaveBeenCalledWith(start, 'update', {
      target: process.execPath,
      icon: process.execPath,
      iconIndex: 0,
    });
  });

  it("overrides the deb's .desktop entry per user for Dark and removes it for Blurple", () => {
    platform('linux');
    mocks.files.set(
      '/usr/share/applications/other.desktop',
      'Exec=/bin/other\n',
    );
    mocks.files.set(
      '/usr/share/applications/trinity-desktop.desktop',
      `[Desktop Entry]\nName=Trinity\nExec="${process.execPath}" %U\nIcon=trinity-desktop\n`,
    );
    const override =
      '/home/u/.local/share/applications/trinity-desktop.desktop';

    persistAppIcon('dark');
    const text = mocks.files.get(override) as string;
    expect(text).toContain('Icon=/res/icon-dark.png\n');
    expect(text).toContain(`Exec="${process.execPath}" %U`);

    persistAppIcon('blurple');
    expect(mocks.files.has(override)).toBe(false);
  });

  it('leaves AppImage and foreign .desktop overrides alone', () => {
    platform('linux');
    const override =
      '/home/u/.local/share/applications/trinity-desktop.desktop';
    mocks.files.set(
      '/usr/share/applications/trinity-desktop.desktop',
      `Exec="${process.execPath}"\nIcon=trinity-desktop\n`,
    );
    mocks.files.set(override, 'Icon=user-choice\n');
    persistAppIcon('blurple');
    expect(mocks.files.get(override)).toBe('Icon=user-choice\n');

    process.env['APPIMAGE'] = '/home/u/Trinity.AppImage';
    mocks.files.delete(override);
    persistAppIcon('dark');
    expect(mocks.files.has(override)).toBe(false);
  });
});
