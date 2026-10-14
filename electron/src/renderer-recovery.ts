import { app, dialog } from 'electron';
import type { BrowserWindow, RenderProcessGoneDetails } from 'electron';
import { appIdentity } from './app-identity';

/** A crash this soon after an automatic reload asks instead of reloading in a loop. */
export const CRASH_LOOP_MS = 60_000;

/**
 * Bring the window back when its renderer crashes or hangs. Release builds have no View ›
 * Reload, so without this a blank or frozen window could only be quit and reopened.
 *
 * - A crash reloads the window at once. A second crash within {@link CRASH_LOOP_MS} of
 *   that reload asks Reload or Quit instead.
 * - A hang asks Reload or Keep Waiting, and the question closes itself if the window
 *   responds again. A hidden (closed-to-tray) window is asked when it is shown.
 */
export function watchRendererRecovery(
  win: BrowserWindow,
  now: () => number = Date.now,
): void {
  const contents = win.webContents;
  const { productName } = appIdentity();
  let lastReload = Number.NEGATIVE_INFINITY;
  let asking = false;
  let hung = false;
  let killedOnPurpose = false;
  let stopAsking: AbortController | undefined;

  const reload = (): void => {
    lastReload = now();
    contents.reload();
  };

  const askAfterRepeatedCrash = async (): Promise<void> => {
    asking = true;
    const { response } = await dialog.showMessageBox(win, {
      type: 'error',
      message: `${productName} stopped working`,
      detail:
        'It stopped again soon after reloading. Reload to try again, or quit and open it later.',
      buttons: ['Reload', 'Quit'],
      defaultId: 0,
      cancelId: 0,
    });
    asking = false;
    if (response === 1) {
      app.quit();
    } else if (!contents.isDestroyed()) {
      reload();
    }
  };

  const askWhileHung = async (): Promise<void> => {
    asking = true;
    stopAsking = new AbortController();
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      message: `${productName} isn’t responding`,
      detail:
        'Reload it, or keep waiting for it to respond. Anything not yet sent may be lost when it reloads.',
      buttons: ['Reload', 'Keep Waiting'],
      defaultId: 1,
      cancelId: 1,
      signal: stopAsking.signal,
    });
    asking = false;
    stopAsking = undefined;
    if (response !== 0 || contents.isDestroyed()) return;
    hung = false;
    // A hung renderer cannot run a reload itself, so end it. A reload issued before it is
    // gone is lost, so render-process-gone reloads once it has exited.
    killedOnPurpose = true;
    contents.forcefullyCrashRenderer();
  };

  contents.on(
    'render-process-gone',
    (_event: unknown, details: RenderProcessGoneDetails) => {
      if (details.reason === 'clean-exit' || contents.isDestroyed()) return;
      if (killedOnPurpose && details.reason === 'killed') {
        // Asked for: reload without the crash-loop check.
        killedOnPurpose = false;
        reload();
        return;
      }
      if (asking) return;
      if (now() - lastReload < CRASH_LOOP_MS) {
        void askAfterRepeatedCrash();
      } else {
        reload();
      }
    },
  );

  win.on('unresponsive', () => {
    hung = true;
    if (!asking && win.isVisible()) void askWhileHung();
  });
  win.on('responsive', () => {
    hung = false;
    stopAsking?.abort();
  });
  win.on('show', () => {
    if (hung && !asking) void askWhileHung();
  });
}
