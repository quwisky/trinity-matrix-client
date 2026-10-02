import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { existsSync } = vi.hoisted(() => ({ existsSync: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync }));
vi.mock('electron', () => ({ app: { getAppPath: () => '/app' } }));

import {
  iconCandidatePaths,
  resolveIconFile,
  trayIconFile,
  windowIconOptions,
} from './icons';

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
  beforeAll(() => {
    Object.defineProperty(process, 'resourcesPath', {
      value: '/resources',
      configurable: true,
    });
  });

  it('leaves macOS to the bundle icon', () => {
    expect(windowIconOptions('darwin')).toEqual({});
  });

  it('sets the generated icon on Windows and Linux', () => {
    const [first] = iconCandidatePaths('icon.png');
    existsSync.mockImplementation((path: string) => path === first);
    expect(windowIconOptions('linux')).toEqual({ icon: first });
    expect(windowIconOptions('win32')).toEqual({ icon: first });
  });
});
