import { app, ipcMain } from 'electron';
import { persistAppIcon } from './app-icon-persistence';
import {
  isAppIconChoice,
  saveAppIcon,
  storedAppIconChoice,
  type AppIconChoice,
} from './app-icon-state';
import { dockIconFile, resolveIconFile, windowIconOptions } from './icons';
import { setTrayIcon } from './tray';
import { getMainWindow } from './window';

/** Renderer → main: the resolved App icon (`'blurple' | 'dark'`), or `'system'` on macOS. */
export const SET_APP_ICON_CHANNEL = 'trinity:app-icon:set';

let current: AppIconChoice | undefined;

/** Dock on macOS; window and tray on Windows/Linux. Only while Trinity runs. */
export function applyAppIcon(icon: AppIconChoice): void {
  if (process.platform === 'darwin') {
    if (icon === 'system') {
      // Electron hands null to setApplicationIconImage as nil: the bundle's macOS-themed icon.
      app.dock?.setIcon(null as unknown as string);
      return;
    }
    const file = resolveIconFile(dockIconFile(icon));
    if (file) app.dock?.setIcon(file);
    return;
  }
  // Only macOS sends 'system'; elsewhere the renderer resolves Match system itself.
  if (icon === 'system') return;
  const { icon: windowIcon } = windowIconOptions(process.platform, icon);
  if (windowIcon) getMainWindow()?.setIcon(windowIcon);
  setTrayIcon(icon);
}

/** Wire the IPC; also applies a stored Dark icon, which the shipped icons cannot express. */
export function registerAppIconIpc(): void {
  current = storedAppIconChoice();
  if (current === 'dark') {
    if (process.platform === 'darwin') applyAppIcon(current);
    // An update or reinstall restores the shipped bundle, shortcuts and .desktop entry.
    persistAppIcon(current);
  }
  ipcMain.handle(SET_APP_ICON_CHANNEL, (event, raw: unknown) => {
    const win = getMainWindow();
    if (
      !win ||
      event.sender !== win.webContents ||
      !isAppIconChoice(raw) ||
      (raw === 'system' && process.platform !== 'darwin')
    ) {
      return false;
    }
    if (raw === current) return true;
    current = raw;
    saveAppIcon(raw);
    applyAppIcon(raw);
    persistAppIcon(raw);
    return true;
  });
}
