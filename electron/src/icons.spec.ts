import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { existsSync } = vi.hoisted(() => ({ existsSync: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync }));
const { createFromPath } = vi.hoisted(() => ({ createFromPath: vi.fn() }));
vi.mock('electron', () => ({
  app: { getAppPath: () => '/app' },
  nativeImage: { createFromPath },
}));

import { iconCandidatePaths, resolveIconFile, trayIconFile } from './icons';

describe('resolveIconFile', () => {
  // iconCandidatePaths() joins process.resourcesPath, which only Electron defines.
  beforeAll(() => {
    Object.defineProperty(process, 'resourcesPath', {
      value: '/resources',
      configurable: true,
    });
  });
  beforeEach(() => existsSync.mockReset());

  it('returns the first candidate that exists', () => {
    const [, second] = iconCandidatePaths('icon.png');
    existsSync.mockImplementation((path: string) => path === second);
    expect(resolveIconFile('icon.png')).toBe(second);
  });

  it('returns undefined when no candidate exists', () => {
    existsSync.mockReturnValue(false);
    expect(resolveIconFile('icon.png')).toBeUndefined();
  });
});

describe('trayIconFile', () => {
  it('uses the template on macOS, a 32 px tray on Linux and a 16 px tray elsewhere', () => {
    expect(trayIconFile('darwin')).toBe('trinityTrayTemplate.png');
    expect(trayIconFile('linux')).toBe('trinityTrayLinux.png');
    expect(trayIconFile('win32')).toBe('trinityTray.png');
  });
});

describe('windowIconOptions', () => {
  const image = { isEmpty: () => false };

  beforeAll(() => {
    Object.defineProperty(process, 'resourcesPath', {
      value: '/resources',
      configurable: true,
    });
  });
  beforeEach(() => {
    existsSync.mockReset();
    createFromPath.mockReset();
    createFromPath.mockReturnValue(image);
    vi.resetModules();
  });

  const load = async () => (await import('./icons')).windowIconOptions;

  it('leaves macOS to the bundle icon', async () => {
    const windowIconOptions = await load();
    expect(windowIconOptions('darwin')).toEqual({});
    expect(createFromPath).not.toHaveBeenCalled();
  });

  it('sets the 256 px window icon image on Windows and Linux', async () => {
    const windowIconOptions = await load();
    const [first] = iconCandidatePaths('windowIcon.png');
    existsSync.mockImplementation((path: string) => path === first);
    expect(windowIconOptions('linux').icon).toBe(image);
    expect(windowIconOptions('win32').icon).toBe(image);
    expect(createFromPath).toHaveBeenCalledWith(first);
  });

  it('decodes the icon once and shares it between windows', async () => {
    const windowIconOptions = await load();
    existsSync.mockReturnValue(true);
    windowIconOptions('win32');
    windowIconOptions('win32');
    windowIconOptions('linux');
    expect(createFromPath).toHaveBeenCalledTimes(1);
  });

  it('omits the icon when the asset is missing', async () => {
    const windowIconOptions = await load();
    existsSync.mockReturnValue(false);
    expect(windowIconOptions('linux')).toEqual({});
  });
});
