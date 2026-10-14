import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(roles).toContain('reload');
    expect(roles).toContain('togglefullscreen');
  });
});
