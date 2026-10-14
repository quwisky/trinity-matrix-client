import { app, dialog } from 'electron';
import type {
  BrowserWindow,
  MessageBoxOptions,
  RenderProcessGoneDetails,
} from 'electron';
import { appIdentity } from './app-identity';

/** A crash this soon after an automatic reload asks instead of reloading in a loop. */
export const CRASH_LOOP_MS = 60_000;

/**
 * Bring the window back when its renderer crashes or hangs. Release builds have no View ›
 * Reload, so without this a blank or frozen window could only be quit and reopened.
 *
 * - A crash reloads the window at once. A crash within {@link CRASH_LOOP_MS} of a reload
 *   the shell made asks Reload or Quit instead.
 * - A hang asks Reload or Keep Waiting, and the question closes itself if the window
 *   responds again or its renderer exits.
 * - Both questions wait until the window is on screen (shown, restored or focused), so a
 *   window hidden to the tray or minimised is asked when the person comes back to it.
 */
export function watchRendererRecovery(
  win: BrowserWindow,
  now: () => number = Date.now,
): void {
  const contents = win.webContents;
  const { productName } = appIdentity();
  let lastReload = Number.NEGATIVE_INFINITY;
  let question: 'hang' | 'crash' | null = null;
  let stopAsking: AbortController | undefined;
  /** Waiting for the window to come back on screen to ask: a hang, or a repeated crash. */
  let hangDeferred = false;
  let crashedAgain = false;
  /** The renderer was ended for a Reload answer; its exit reloads. */
  let killedOnPurpose = false;
  /** Bumped on every renderer exit, so an answer about the old renderer is dropped. */
  let renderer = 0;

  const onScreen = (): boolean => win.isVisible() && !win.isMinimized();

  const reload = (): void => {
    lastReload = now();
    contents.reload();
  };

  /** The chosen button's index, or undefined when the box failed or was dismissed. */
  const ask = async (
    kind: 'hang' | 'crash',
    options: MessageBoxOptions,
  ): Promise<number | undefined> => {
    question = kind;
    stopAsking = new AbortController();
    try {
      const { response } = await dialog.showMessageBox(win, {
        ...options,
        // Plain buttons on Windows, not command links.
        noLink: true,
        signal: stopAsking.signal,
      });
      return response;
    } catch {
      return undefined;
    } finally {
      question = null;
      stopAsking = undefined;
    }
  };

  const askAfterRepeatedCrash = async (): Promise<void> => {
    crashedAgain = true;
    if (!onScreen()) return;
    crashedAgain = false;
    const response = await ask('crash', {
      type: 'error',
      message: `${productName} stopped working`,
      detail:
        'It stopped again soon after reloading. Reload to try again, or quit and open it later.',
      buttons: ['Reload', 'Quit'],
      defaultId: 0,
      // Escape reloads; only an explicit Quit quits.
      cancelId: 0,
    });
    if (response === 1) {
      app.quit();
    } else if (!contents.isDestroyed()) {
      reload();
    }
  };

  const askWhileHung = async (): Promise<void> => {
    // Asked once per report: after Keep Waiting, Chromium reports a still-hung window
    // again on new input, so returning focus to the window does not reopen the box.
    hangDeferred = !onScreen();
    if (hangDeferred) return;
    const askedAbout = renderer;
    const response = await ask('hang', {
      type: 'warning',
      message: `${productName} isn’t responding`,
      detail:
        'Reload it, or keep waiting for it to respond. Anything not yet sent may be lost when it reloads.',
      buttons: ['Reload', 'Keep Waiting'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0 || askedAbout !== renderer || contents.isDestroyed()) {
      return;
    }
    if (contents.isCrashed()) {
      reload();
      return;
    }
    // A hung renderer cannot run a reload itself, so end it. A reload issued before it
    // is gone is lost, so its exit reloads (reported as killed or crashed, by platform).
    killedOnPurpose = true;
    contents.forcefullyCrashRenderer();
  };

  contents.on(
    'render-process-gone',
    (_event: unknown, details: RenderProcessGoneDetails) => {
      if (details.reason === 'clean-exit' || contents.isDestroyed()) return;
      renderer += 1;
      hangDeferred = false;
      if (killedOnPurpose) {
        // Asked for: reload without the crash-loop check.
        killedOnPurpose = false;
        reload();
        return;
      }
      if (question === 'hang') {
        // The hang question is about a renderer that is gone; reload in its place. This
        // skips the crash-loop check, which would open a second box before this one has
        // closed; a renderer that keeps hanging and crashing is asked about each hang.
        stopAsking?.abort();
        reload();
        return;
      }
      if (question === 'crash') return;
      if (now() - lastReload < CRASH_LOOP_MS) {
        void askAfterRepeatedCrash();
      } else {
        reload();
      }
    },
  );
  // A loaded page means no deliberate exit is still on its way.
  contents.on('did-finish-load', () => {
    killedOnPurpose = false;
  });

  win.on('unresponsive', () => {
    if (!question) void askWhileHung();
  });
  win.on('responsive', () => {
    hangDeferred = false;
    if (question === 'hang') stopAsking?.abort();
  });
  const askIfWaiting = (): void => {
    if (question) return;
    if (crashedAgain) void askAfterRepeatedCrash();
    else if (hangDeferred) void askWhileHung();
  };
  win.on('show', askIfWaiting);
  win.on('restore', askIfWaiting);
  win.on('focus', askIfWaiting);
}
