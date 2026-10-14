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
    {
      label: 'File',
      // Close (Cmd/Ctrl+W) hides the window to the tray. Windows and Linux keep it here
      // because they have no Window menu.
      submenu: isMac
        ? [{ role: 'close' }]
        : [{ role: 'close' }, { role: 'quit' }],
    },
    {
      // The stock editMenu adds Delete and Paste and Match Style, which repeat Paste in
      // Trinity's plain-text fields, and on macOS Speech, which the system's Spoken
      // Content shortcut (Option+Esc) still covers.
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
        // Release builds have no developer tools and no Reload, a debugging aid;
        // renderer-recovery.ts brings back a crashed or hung window instead. Leaving the
        // roles out also drops their accelerators. window.ts turns devTools off as well.
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
    // On Windows and Linux the stock Window menu is only Minimize and Close: the title bar
    // has both buttons, and File keeps Close's Ctrl+W. Ctrl+M (Minimize) goes with it.
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
