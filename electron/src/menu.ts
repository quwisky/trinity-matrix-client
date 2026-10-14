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
    {
      // The stock editMenu adds Delete, Paste and Match Style and Speech; Trinity's
      // fields are plain text, so they would only repeat Paste or do nothing.
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        // Release builds have no developer tools, and no Reload: it is a debugging aid
        // that drops unsent drafts. Leaving the roles out also drops their accelerators.
        // window.ts turns devTools off in webPreferences as well.
        ...(options.packaged
          ? []
          : [
              { role: 'reload' as const },
              { role: 'forceReload' as const },
              { role: 'toggleDevTools' as const },
              { type: 'separator' as const },
            ]),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    // Windows and Linux get only Minimize and Close here, which the title bar already has.
    ...(isMac ? [{ role: 'windowMenu' as const }] : []),
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
