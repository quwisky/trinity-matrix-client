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
function fakeWindow(visible = true) {
  const windowListeners: Record<string, Listener> = {};
  const contentsListeners: Record<string, Listener> = {};
  const contents = {
    on: vi.fn((event: string, listener: Listener) => {
      contentsListeners[event] = listener;
    }),
    reload: vi.fn(),
    forcefullyCrashRenderer: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
  const win = {
    on: vi.fn((event: string, listener: Listener) => {
      windowListeners[event] = listener;
    }),
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => visible),
    webContents: contents,
  };
  return {
    win: win as unknown as BrowserWindow,
    contents,
    setVisible: (value: boolean) => win.isVisible.mockReturnValue(value),
    gone: (reason: string) =>
      contentsListeners['render-process-gone']?.({}, { reason, exitCode: 1 }),
    emit: (event: string) => windowListeners[event]?.(),
  };
}

/** Let the dialog promise and its continuation run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('renderer recovery', () => {
  let now: number;

  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  describe('when the window stops responding', () => {
    it('reloads it when the person chooses Reload', async () => {
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
        }),
      );
      expect(fake.contents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
      // A reload issued before the hung renderer is gone is lost; it follows the exit.
      expect(fake.contents.reload).not.toHaveBeenCalled();
      fake.gone('killed');
      expect(fake.contents.reload).toHaveBeenCalledTimes(1);
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    });

    it('reloads the killed renderer even soon after an automatic reload', async () => {
      mocks.showMessageBox.mockResolvedValue({ response: 0 });
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.gone('crashed');
      fake.emit('unresponsive');
      await settle();
      fake.gone('killed');
      expect(fake.contents.reload).toHaveBeenCalledTimes(2);
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
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

    it('closes the question when the window responds again', async () => {
      let signal: AbortSignal | undefined;
      mocks.showMessageBox.mockImplementation(
        (_win: unknown, options: { signal: AbortSignal }) => {
          signal = options.signal;
          return new Promise(() => undefined);
        },
      );
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.emit('unresponsive');
      expect(signal?.aborted).toBe(false);
      fake.emit('responsive');
      expect(signal?.aborted).toBe(true);
    });

    it('asks only once while the question is open', () => {
      mocks.showMessageBox.mockReturnValue(new Promise(() => undefined));
      const fake = fakeWindow();
      watchRendererRecovery(fake.win, () => now);
      fake.emit('unresponsive');
      fake.emit('unresponsive');
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    });

    it('waits until a hidden window is shown again before asking', async () => {
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      const fake = fakeWindow(false);
      watchRendererRecovery(fake.win, () => now);
      fake.emit('unresponsive');
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      fake.setVisible(true);
      fake.emit('show');
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
  });
});
