import { ipcMain } from 'electron';
import { getMainWindow } from './window';

/** IPC channel the preload invokes for the window's visibility right now. */
export const VISIBILITY_QUERY_CHANNEL =
  'trinity:host:v1:lifecycle:visibility:current';

/** What the renderer is told: hidden in the tray or minimised, else visible. */
export function windowVisibility(window: {
  isVisible(): boolean;
  isMinimized(): boolean;
}): 'visible' | 'hidden' {
  return window.isVisible() && !window.isMinimized() ? 'visible' : 'hidden';
}

/**
 * Answer "is the window on screen now?". Main announces each visibility change (see
 * `window.ts`), but a renderer that starts while the window is already hidden (reloaded or
 * crash-recovered while Trinity sits in the tray) would hear none and act as foreground
 * until the next change, so it asks once when it subscribes. Only the main window's own
 * renderer is answered.
 */
export function registerLifecycleIpc(): void {
  ipcMain.handle(VISIBILITY_QUERY_CHANNEL, (event) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      return null;
    }
    return windowVisibility(win);
  });
}
