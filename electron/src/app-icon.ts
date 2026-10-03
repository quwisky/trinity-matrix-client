import { app, ipcMain } from 'electron';
import { isAppIconName, saveAppIcon, storedAppIcon } from './app-icon-state';
import {
  dockIconFile,
  resolveIconFile,
  windowIconOptions,
  type AppIconName,
} from './icons';
import { setTrayIcon } from './tray';
import { getMainWindow } from './window';

/** Renderer → main: the resolved App icon preference (`'blurple' | 'dark'`). */
export const SET_APP_ICON_CHANNEL = 'trinity:app-icon:set';

let current: AppIconName | undefined;

/** Dock on macOS; window and tray on Windows/Linux. Only while Trinity runs. */
export function applyAppIcon(icon: AppIconName): void {
  if (process.platform === 'darwin') {
    const file = resolveIconFile(dockIconFile(icon));
    if (file) app.dock?.setIcon(file);
    return;
  }
  const { icon: windowIcon } = windowIconOptions(process.platform, icon);
  if (windowIcon) getMainWindow()?.setIcon(windowIcon);
  setTrayIcon(icon);
}

/** Wire the IPC; also applies a stored Dark Dock icon, which the bundle icon cannot express. */
export function registerAppIconIpc(): void {
  current = storedAppIcon();
  if (process.platform === 'darwin' && current === 'dark')
    applyAppIcon(current);
  ipcMain.handle(SET_APP_ICON_CHANNEL, (event, raw: unknown) => {
    const win = getMainWindow();
    if (!win || event.sender !== win.webContents || !isAppIconName(raw)) {
      return false;
    }
    if (raw === current) return true;
    current = raw;
    saveAppIcon(raw);
    applyAppIcon(raw);
    return true;
  });
}
