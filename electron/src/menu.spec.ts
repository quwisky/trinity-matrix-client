import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

const mocks = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template: unknown) => template),
  setApplicationMenu: vi.fn(),
  openExternal: vi.fn(),
  checkForUpdates: vi.fn(() => Promise.resolve()),
}));
vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: mocks.buildFromTemplate,
    setApplicationMenu: mocks.setApplicationMenu,
  },
  shell: { openExternal: mocks.openExternal },
}));
vi.mock('./update-check', () => ({ checkForUpdates: mocks.checkForUpdates }));

import { buildMenu } from './menu';

function template(packaged = false): MenuItemConstructorOptions[] {
  buildMenu({ packaged });
  return mocks.buildFromTemplate.mock.calls.at(
    -1,
  )?.[0] as MenuItemConstructorOptions[];
}

const realPlatform = process.platform;
/** Override process.platform for the duration of a test (restored in afterEach). */
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

/** Top-level menus by role or label, in order. */
function menus(): (string | undefined)[] {
  return template().map((item) => item.role ?? item.label);
}

function editRoles(): (string | undefined)[] {
  const edit = template().find((item) => item.label === 'Edit');
  return (edit?.submenu as MenuItemConstructorOptions[]).map(
    (entry) => entry.role ?? entry.type,
  );
}

function helpItems(): MenuItemConstructorOptions[] {
  const help = template().find((item) => item.role === 'help');
  return help?.submenu as MenuItemConstructorOptions[];
}

function viewRoles(packaged: boolean): (string | undefined)[] {
  const view = template(packaged).find((item) => item.label === 'View');
  return (view?.submenu as MenuItemConstructorOptions[]).map(
    (entry) => entry.role,
  );
}

describe('application menu', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => setPlatform(realPlatform));

  it('checks for updates on demand from Help', () => {
    const item = helpItems().find(
      (entry) => entry.label === 'Check for Updates…',
    );
    item?.click?.({} as never, undefined, {} as never);
    expect(mocks.checkForUpdates).toHaveBeenCalledWith({ manual: true });
  });

  it('links Help to the Trinity repository, not a template leftover', () => {
    const items = helpItems();
    expect(items.some((entry) => entry.label === 'Learn More')).toBe(false);
    items
      .find((entry) => entry.label === 'Trinity on GitHub')
      ?.click?.({} as never, undefined, {} as never);
    expect(mocks.openExternal).toHaveBeenCalledWith(
      'https://github.com/quwisky/trinity-matrix-client',
    );
  });

  it('keeps the developer tools item in development builds', () => {
    expect(viewRoles(false)).toContain('toggleDevTools');
  });

  it('leaves the developer tools item out of release builds', () => {
    const roles = viewRoles(true);
    expect(roles).not.toContain('toggleDevTools');
    expect(roles).toContain('togglefullscreen');
  });

  it('keeps Reload and Force Reload in development builds', () => {
    const roles = viewRoles(false);
    expect(roles).toContain('reload');
    expect(roles).toContain('forceReload');
  });

  it('leaves Reload and Force Reload out of release builds', () => {
    const roles = viewRoles(true);
    expect(roles).not.toContain('reload');
    expect(roles).not.toContain('forceReload');
    // No separator left dangling at the top of the menu.
    expect(roles[0]).toBe('resetZoom');
  });

  it('keeps the standard macOS app and Window menus', () => {
    setPlatform('darwin');
    expect(menus()).toEqual([
      'appMenu',
      'File',
      'Edit',
      'View',
      'windowMenu',
      'help',
    ]);
  });

  it('leaves the Window menu out on Windows and Linux, where the title bar has those controls', () => {
    for (const platform of ['win32', 'linux'] as const) {
      setPlatform(platform);
      expect(menus()).toEqual(['File', 'Edit', 'View', 'help']);
    }
  });

  it('offers only the editing commands a plain-text app uses', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      setPlatform(platform);
      expect(editRoles()).toEqual([
        'undo',
        'redo',
        'separator',
        'cut',
        'copy',
        'paste',
        'separator',
        'selectAll',
      ]);
    }
  });

  it('keeps Close (Cmd/Ctrl+W) in File on every platform, and Quit there off macOS', () => {
    const fileRoles = () =>
      (
        template().find((item) => item.label === 'File')
          ?.submenu as MenuItemConstructorOptions[]
      ).map((entry) => entry.role);
    setPlatform('darwin');
    expect(fileRoles()).toEqual(['close']);
    for (const platform of ['win32', 'linux'] as const) {
      setPlatform(platform);
      expect(fileRoles()).toEqual(['close', 'quit']);
    }
  });
});
