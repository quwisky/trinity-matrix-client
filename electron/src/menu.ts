import { Menu, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { checkForUpdates } from './update-check';

/** What the application menu depends on at build time. */
export interface MenuOptions {
  /** A packaged release build: no developer tools (decision 20). */
  readonly packaged: boolean;
}

export function buildMenu(options: MenuOptions): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        // Release builds have no developer tools; leaving the role out also drops its
        // accelerator. window.ts turns devTools off in webPreferences as well.
        ...(options.packaged ? [] : [{ role: 'toggleDevTools' as const }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Check for Updates…',
          click: () => void checkForUpdates({ manual: true }),
        },
        { type: 'separator' },
        {
          label: 'Trinity on GitHub',
          click: () =>
            void shell.openExternal(
              'https://github.com/quwisky/trinity-matrix-client',
            ),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
