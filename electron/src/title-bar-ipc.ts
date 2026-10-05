import { app, ipcMain, Menu } from 'electron';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { getMainWindow, isSystemTitleBarActive } from './window';
import { readWindowPrefs, writeWindowPrefs } from './window-prefs';

export const SET_OVERLAY_CHANNEL = 'trinity:host:v1:title-bar:set-overlay';
export const POPUP_MENU_CHANNEL = 'trinity:host:v1:title-bar:popup-menu';
export const GET_SYSTEM_TITLE_BAR_CHANNEL =
  'trinity:host:v1:title-bar:get-system-title-bar';
export const SET_SYSTEM_TITLE_BAR_CHANNEL =
  'trinity:host:v1:title-bar:set-system-title-bar';
export const RELAUNCH_CHANNEL = 'trinity:host:v1:title-bar:relaunch';
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
  ipcMain.on(SET_OVERLAY_CHANNEL, (event, raw: unknown) => {
    const win = trustedWindow(event);
    // Only a Windows/Linux window created without the OS title bar has an overlay;
    // macOS uses traffic lights.
    if (!win || process.platform === 'darwin' || isSystemTitleBarActive()) {
      return;
    }
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
    try {
      win.setTitleBarOverlay({ color, symbolColor, height: 32 });
    } catch {
      // A throw in an `ipcMain.on` listener would raise the main-process error dialog.
    }
  });

  ipcMain.on(POPUP_MENU_CHANNEL, (event, raw: unknown) => {
    const win = trustedWindow(event);
    if (!win || !raw || typeof raw !== 'object') return;
    const { x, y } = raw as Record<string, unknown>;
    if (!isMenuCoordinate(x) || !isMenuCoordinate(y)) return;
    Menu.getApplicationMenu()?.popup({ window: win, x, y });
  });

  // `saved` drives the settings toggle; `active` says whether this session's window
  // shows the OS title bar, so the renderer knows whether to draw its own row.
  ipcMain.handle(GET_SYSTEM_TITLE_BAR_CHANNEL, (event) =>
    trustedWindow(event)
      ? {
          saved: readWindowPrefs().systemTitleBar,
          active: isSystemTitleBarActive(),
        }
      : { saved: false, active: false },
  );

  ipcMain.handle(SET_SYSTEM_TITLE_BAR_CHANNEL, (event, raw: unknown) => {
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

  ipcMain.on(RELAUNCH_CHANNEL, (event) => {
    if (!trustedWindow(event)) return;
    app.relaunch();
    app.exit(0);
  });
}
