import { Menu, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { appIdentity } from './app-identity';
import { checkForUpdates } from './update-check';

/** What the application menu depends on at build time. */
export interface MenuOptions {
  /** A packaged release build: no developer tools (decision 20). */
  readonly packaged: boolean;
  /** App lock's menu item; absent until the renderer reports its state. */
  readonly lock?: LockMenuItem;
}

export interface LockMenuItem {
  readonly visible: boolean;
  readonly enabled: boolean;
  /** Electron accelerator syntax, or null while the shortcut is unassigned. */
  readonly accelerator: string | null;
  readonly onLock: () => void;
}

export function buildMenu(options: MenuOptions): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        ...(options.lock?.visible
          ? [
              {
                id: 'lock-trinity',
                // Names this channel's app: "Lock Trinity" or "Lock Trinity Next".
                label: `Lock ${appIdentity().productName}`,
                enabled: options.lock.enabled,
                ...(options.lock.accelerator
                  ? { accelerator: options.lock.accelerator }
                  : {}),
                // Shown only: the renderer's shortcut service handles the key on
                // Windows and Linux (macOS registers it regardless, and the click
                // locks the same way).
                registerAccelerator: false,
                click: () => options.lock?.onLock(),
              },
              { type: 'separator' as const },
            ]
          : []),
        // Close (Cmd/Ctrl+W) hides the window to the tray. Windows and Linux keep it
        // here because they have no Window menu.
        ...(isMac
          ? [{ role: 'close' as const }]
          : [{ role: 'close' as const }, { role: 'quit' as const }]),
      ],
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
