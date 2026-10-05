import { app, ipcMain, Menu } from 'electron';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { getMainWindow } from './window';
import { readWindowPrefs, writeWindowPrefs } from './window-prefs';

const CHANNEL = 'trinity:host:v1:title-bar';
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
const MAX_MENU_COORDINATE = 10_000;

/** The main window when `event` comes from its renderer, else `null`. */
function trustedWindow(
  event: IpcMainEvent | IpcMainInvokeEvent,
): BrowserWindow | null {
  const win = getMainWindow();
  return win && event.sender === win.webContents ? win : null;
}

function isMenuCoordinate(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_MENU_COORDINATE
  );
}

/**
 * Wire the `title-bar` host operation: overlay colours, the ☰ app-menu popup, the
 * system-title-bar preference and relaunch. Every channel serves only the main
 * window's renderer and validates its payload before native work.
 */
export function registerTitleBarIpc(): void {
  ipcMain.on(`${CHANNEL}:set-overlay`, (event, raw: unknown) => {
    const win = trustedWindow(event);
    // macOS uses traffic lights, not a Windows Controls Overlay.
    if (!win || process.platform === 'darwin') return;
    if (!raw || typeof raw !== 'object') return;
    const { color, symbolColor } = raw as Record<string, unknown>;
    if (
      typeof color !== 'string' ||
      typeof symbolColor !== 'string' ||
      !HEX_COLOUR.test(color) ||
      !HEX_COLOUR.test(symbolColor)
    ) {
      return;
    }
    win.setTitleBarOverlay({ color, symbolColor, height: 32 });
  });

  ipcMain.on(`${CHANNEL}:popup-menu`, (event, raw: unknown) => {
    const win = trustedWindow(event);
    if (!win || !raw || typeof raw !== 'object') return;
    const { x, y } = raw as Record<string, unknown>;
    if (!isMenuCoordinate(x) || !isMenuCoordinate(y)) return;
    Menu.getApplicationMenu()?.popup({ window: win, x, y });
  });

  ipcMain.handle(`${CHANNEL}:get-system-title-bar`, (event) =>
    trustedWindow(event) ? readWindowPrefs().systemTitleBar : false,
  );

  ipcMain.handle(`${CHANNEL}:set-system-title-bar`, (event, raw: unknown) => {
    if (!trustedWindow(event)) {
      return { kind: 'rejected', diagnostic: { code: 'sender-rejected' } };
    }
    if (typeof raw !== 'boolean') {
      return {
        kind: 'rejected',
        diagnostic: { code: 'invalid-system-title-bar' },
      };
    }
    try {
      writeWindowPrefs({ systemTitleBar: raw });
      return { kind: 'completed' };
    } catch {
      return {
        kind: 'rejected',
        diagnostic: { code: 'window-prefs-write-failed' },
      };
    }
  });

  ipcMain.on(`${CHANNEL}:relaunch`, (event) => {
    if (!trustedWindow(event)) return;
    app.relaunch();
    app.exit(0);
  });
}
