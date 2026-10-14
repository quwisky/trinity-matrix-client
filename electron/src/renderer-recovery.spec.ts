import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  quit: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { quit: mocks.quit },
  dialog: { showMessageBox: mocks.showMessageBox },
}));
vi.mock('./app-identity', () => ({
  appIdentity: () => ({ productName: 'Trinity Next' }),
}));

import type { BrowserWindow } from 'electron';
import { CRASH_LOOP_MS, watchRendererRecovery } from './renderer-recovery';

type Listener = (...args: unknown[]) => void;

/** A window fake that records listeners on itself and on its WebContents. */
function fakeWindow(onScreen = true) {
  const windowListeners: Record<string, Listener> = {};
  const contentsListeners: Record<string, Listener> = {};
  const contents = {
    on: vi.fn((event: string, listener: Listener) => {
      contentsListeners[event] = listener;
    }),
    reload: vi.fn(),
    forcefullyCrashRenderer: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isCrashed: vi.fn(() => false),
  };
  const win = {
    on: vi.fn((event: string, listener: Listener) => {
      windowListeners[event] = listener;
    }),
    isVisible: vi.fn(() => onScreen),
    isMinimized: vi.fn(() => false),
    webContents: contents,
  };
  return {
    win: win as unknown as BrowserWindow,
    contents,
    setVisible: (value: boolean) => win.isVisible.mockReturnValue(value),
    setMinimized: (value: boolean) => win.isMinimized.mockReturnValue(value),
    gone: (reason: string) =>
      contentsListeners['render-process-gone']?.({}, { reason, exitCode: 1 }),
    loaded: () => contentsListeners['did-finish-load']?.(),
    emit: (event: string) => windowListeners[event]?.(),
  };
}

/** Let the dialog promise and its continuation run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A question that stays open until aborted, then answers its cancel button. */
function openUntilAborted(): void {
  mocks.showMessageBox.mockImplementation(
    (_win: unknown, options: { signal: AbortSignal; cancelId: number }) =>
      new Promise((resolve) =>
        options.signal.addEventListener('abort', () =>
          resolve({ response: options.cancelId }),
        ),
      ),
  );
}

describe('renderer recovery', () => {
  let now: number;

  beforeEach(() => {
    vi.resetAllMocks();
    now = 1_000_000;
  });

  describe('when the renderer process goes away', () => {
    it('reloads the window after a crash', () => {
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.gone('crashed');
      expect(fake.contents.reload).toHaveBeenCalledTimes(1);
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
    });

    it('reloads a window hidden to the tray too, so it keeps syncing', () => {
      const fake = fakeWindow(false);
      watchRendererRecovery(fake.win, () => now);
      fake.gone('oom');
      expect(fake.contents.reload).toHaveBeenCalledTimes(1);
    });

    it('does nothing after a clean exit', () => {
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.gone('clean-exit');
      expect(fake.contents.reload).not.toHaveBeenCalled();
    });

    it('does nothing once the window is gone', () => {
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.contents.isDestroyed.mockReturnValue(true);
      fake.gone('crashed');
      expect(fake.contents.reload).not.toHaveBeenCalled();
    });

    it('asks instead of reloading again when it crashes soon after a reload', async () => {
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.gone('crashed');
      now += CRASH_LOOP_MS - 1;
      fake.gone('oom');
      await settle();
      expect(fake.contents.reload).toHaveBeenCalledTimes(1);
      expect(mocks.showMessageBox).toHaveBeenCalledWith(
        fake.win,
        expect.objectContaining({
          message: 'Trinity Next stopped working',
          buttons: ['Reload', 'Quit'],
          // Escape reloads; only an explicit Quit quits.
          cancelId: 0,
          noLink: true,
        }),
      );
      expect(mocks.quit).toHaveBeenCalledTimes(1);
    });

    it('reloads when asked after a repeated crash', async () => {
      mocks.showMessageBox.mockResolvedValue({ response: 0 });
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.gone('crashed');
      fake.gone('crashed');
      await settle();
      expect(fake.contents.reload).toHaveBeenCalledTimes(2);
      expect(mocks.quit).not.toHaveBeenCalled();
    });

    it('reloads on its own again once the last reload is long past', () => {
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.gone('crashed');
      now += CRASH_LOOP_MS;
      fake.gone('crashed');
      expect(fake.contents.reload).toHaveBeenCalledTimes(2);
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
    });

    it('asks about a repeated crash only once the hidden window is shown', async () => {
      mocks.showMessageBox.mockResolvedValue({ response: 0 });
      const fake = fakeWindow(false);
      watchRendererRecovery(fake.win, () => now);
      fake.gone('crashed');
      fake.gone('crashed');
      await settle();
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      fake.setVisible(true);
      fake.emit('show');
      await settle();
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
      expect(fake.contents.reload).toHaveBeenCalledTimes(2);
    });

    it('asks about a deferred crash on show even while Electron still reports the window hidden', async () => {
      // Linux without a window manager (CI's xvfb) reports isVisible() false throughout.
      mocks.showMessageBox.mockResolvedValue({ response: 0 });
      const fake = fakeWindow(false);
      watchRendererRecovery(fake.win, () => now);
      fake.gone('crashed');
      fake.gone('crashed');
      fake.emit('focus');
      await settle();
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
      expect(fake.contents.reload).toHaveBeenCalledTimes(2);
    });

    it('keeps recovering after a question fails to open', async () => {
      mocks.showMessageBox.mockRejectedValueOnce(new Error('destroyed'));
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.gone('crashed');
      fake.gone('crashed');
      await settle();
      // The failed question reloads, as Escape would.
      expect(fake.contents.reload).toHaveBeenCalledTimes(2);
      mocks.showMessageBox.mockResolvedValue({ response: 0 });
      fake.gone('crashed');
      await settle();
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
    });
  });

  describe('when the window stops responding', () => {
    it('asks, then ends the renderer and reloads after it exits on Reload', async () => {
      mocks.showMessageBox.mockResolvedValue({ response: 0 });
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.emit('unresponsive');
      await settle();
      expect(mocks.showMessageBox).toHaveBeenCalledWith(
        fake.win,
        expect.objectContaining({
          message: 'Trinity Next isn’t responding',
          buttons: ['Reload', 'Keep Waiting'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        }),
      );
      expect(fake.contents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
      // A reload issued before the hung renderer is gone is lost; it follows the exit.
      expect(fake.contents.reload).not.toHaveBeenCalled();
      fake.gone('killed');
      expect(fake.contents.reload).toHaveBeenCalledTimes(1);
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    });

    // Linux and Windows report the deliberate end as a crash, macOS as killed.
    it.each([
      ['killed', 0],
      ['crashed', 0],
      ['crashed', CRASH_LOOP_MS],
    ])(
      'reloads without asking again when the ended renderer reports %s (%i ms after a reload)',
      async (reason, sinceReload) => {
        mocks.showMessageBox.mockResolvedValue({ response: 0 });
        const fake = fakeWindow();
        watchRendererRecovery(fake.win, () => now);
        fake.gone('crashed');
        fake.loaded();
        now += sinceReload;
        fake.emit('unresponsive');
        await settle();
        fake.gone(reason);
        expect(fake.contents.reload).toHaveBeenCalledTimes(2);
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
      },
    );

    it('ends the hung renderer on Reload even while Electron still reports an earlier crash', async () => {
      // Linux keeps isCrashed() true after a crashed renderer has been reloaded.
      mocks.showMessageBox.mockResolvedValue({ response: 0 });
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.gone('crashed');
      fake.contents.isCrashed.mockReturnValue(true);
      now += CRASH_LOOP_MS;
      fake.emit('unresponsive');
      await settle();
      expect(fake.contents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
      fake.gone('crashed');
      expect(fake.contents.reload).toHaveBeenCalledTimes(2);
    });

    it('closes the question and reloads when the renderer crashes while it is open', async () => {
      openUntilAborted();
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.emit('unresponsive');
      fake.gone('oom');
      await settle();
      expect(fake.contents.reload).toHaveBeenCalledTimes(1);
      expect(fake.contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
    });

    it('drops a Reload answer about a renderer that has since been replaced', async () => {
      let answer: (value: { response: number }) => void = () => undefined;
      mocks.showMessageBox.mockReturnValue(
        new Promise((resolve) => (answer = resolve)),
      );
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.emit('unresponsive');
      fake.gone('crashed');
      answer({ response: 0 });
      await settle();
      expect(fake.contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
      expect(fake.contents.reload).toHaveBeenCalledTimes(1);
    });

    it('leaves it alone when the person keeps waiting', async () => {
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.emit('unresponsive');
      await settle();
      expect(fake.contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
      expect(fake.contents.reload).not.toHaveBeenCalled();
    });

    it('closes the question, ending nothing, when the window responds again', async () => {
      openUntilAborted();
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.emit('unresponsive');
      fake.emit('responsive');
      await settle();
      expect(fake.contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
      expect(fake.contents.reload).not.toHaveBeenCalled();
    });

    it('does not ask again on focus after Keep Waiting, only on a new hang', async () => {
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.emit('unresponsive');
      await settle();
      // Closing the box hands focus back to the window.
      fake.emit('focus');
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
      fake.emit('unresponsive');
      await settle();
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
    });

    it('asks only once while the question is open', () => {
      mocks.showMessageBox.mockReturnValue(new Promise(() => undefined));
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.emit('unresponsive');
      fake.emit('unresponsive');
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    });

    it.each(['show', 'restore', 'focus'])(
      'waits until a window off screen comes back (%s) before asking',
      (event) => {
        mocks.showMessageBox.mockReturnValue(new Promise(() => undefined));
        const fake = fakeWindow();
        fake.setMinimized(true);
        watchRendererRecovery(fake.win, () => now);
        fake.emit('unresponsive');
        expect(mocks.showMessageBox).not.toHaveBeenCalled();
        fake.setMinimized(false);
        fake.emit(event);
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
      },
    );

    it('asks about a deferred hang on focus even while Electron still reports the window hidden', () => {
      mocks.showMessageBox.mockReturnValue(new Promise(() => undefined));
      const fake = fakeWindow(false);
      watchRendererRecovery(fake.win, () => now);
      fake.emit('unresponsive');
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      fake.emit('focus');
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    });

    it('does not ask on show once a hidden window has recovered', () => {
      const fake = fakeWindow(false);
      watchRendererRecovery(fake.win, () => now);
      fake.emit('unresponsive');
      fake.emit('responsive');
      fake.setVisible(true);
      fake.emit('show');
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
    });

    it('does not ask on show about a hang its crash and reload already ended', () => {
      const fake = fakeWindow(false);
      watchRendererRecovery(fake.win, () => now);
      fake.emit('unresponsive');
      fake.gone('crashed');
      fake.setVisible(true);
      fake.emit('show');
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      expect(fake.contents.reload).toHaveBeenCalledTimes(1);
    });
  });
});
