import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: { sender: unknown }, raw?: unknown) => void
  >(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    on: (
      channel: string,
      handler: (event: { sender: unknown }, raw?: unknown) => void,
    ) => handlers.set(channel, handler),
  },
}));

import {
  LOCK_COVER_PAINTED_CHANNEL,
  LOCK_REQUEST_CHANNEL,
  LOCK_SET_STATE_CHANNEL,
  SHOW_HOLD_TIMEOUT_MS,
  parseLockState,
  registerLockIntegration,
} from './lock-integration';

/** The main window's WebContents; fresh per test, as it records renderer exits. */
let contents = fakeContents();

function fakeContents() {
  return Object.assign(new EventEmitter(), { send: vi.fn() });
}

function fakeWindow() {
  const events = new EventEmitter();
  return Object.assign(events, {
    webContents: contents,
    setOpacity: vi.fn(),
    isDestroyed: () => false,
    isVisible: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
  });
}

describe('parseLockState', () => {
  it.each([
    [
      { enabled: true, locked: false, accelerator: 'CommandOrControl+Shift+L' },
      { enabled: true, locked: false, accelerator: 'CommandOrControl+Shift+L' },
    ],
    [
      { enabled: true, locked: true, accelerator: null },
      { enabled: true, locked: true, accelerator: null },
    ],
    [{ enabled: 'yes', locked: false, accelerator: null }, null],
    [{ enabled: true, locked: 1, accelerator: null }, null],
    // A shortcut main can't display drops only the shortcut, never the lock itself.
    [
      { enabled: true, locked: false, accelerator: 'Ctrl+L; rm -rf' },
      { enabled: true, locked: false, accelerator: null },
    ],
    [
      { enabled: true, locked: false, accelerator: 'x'.repeat(65) },
      { enabled: true, locked: false, accelerator: null },
    ],
    [
      { enabled: true, locked: false, accelerator: 7 },
      { enabled: true, locked: false, accelerator: null },
    ],
    [
      { enabled: true, locked: false },
      { enabled: true, locked: false, accelerator: null },
    ],
    [null, null],
  ])('reads %j as %j', (raw, expected) => {
    expect(parseLockState(raw)).toEqual(expected);
  });
});

describe('registerLockIntegration', () => {
  const buildMenu = vi.fn();
  // Fresh per test: listeners from an earlier test's registration would still forward.
  let power: EventEmitter;
  let win: ReturnType<typeof fakeWindow>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    handlers.clear();
    buildMenu.mockClear();
    contents = fakeContents();
    win = fakeWindow();
    power = new EventEmitter();
    registerLockIntegration({
      buildMenu,
      packaged: false,
      powerMonitor: power,
      getMainWindow: () => win as never,
    });
  });

  afterEach(() => vi.useRealTimers());

  const setState = (raw: unknown, sender: unknown = contents) =>
    handlers.get(LOCK_SET_STATE_CHANNEL)!({ sender }, raw);

  it('shows Lock Trinity only while the lock is on, and disables it while locked', () => {
    setState({
      enabled: true,
      locked: false,
      accelerator: 'CommandOrControl+Shift+L',
    });
    expect(buildMenu).toHaveBeenLastCalledWith({
      packaged: false,
      lock: expect.objectContaining({
        visible: true,
        enabled: true,
        accelerator: 'CommandOrControl+Shift+L',
      }),
    });
    setState({ enabled: true, locked: true, accelerator: null });
    expect(buildMenu).toHaveBeenLastCalledWith({
      packaged: false,
      lock: expect.objectContaining({ visible: true, enabled: false }),
    });
    setState({ enabled: false, locked: false, accelerator: null });
    expect(buildMenu).toHaveBeenLastCalledWith({
      packaged: false,
      lock: expect.objectContaining({ visible: false }),
    });
  });

  it('ignores state from another sender and malformed state', () => {
    setState(
      { enabled: true, locked: false, accelerator: null },
      { other: true },
    );
    setState({ enabled: 1 });
    expect(buildMenu).not.toHaveBeenCalled();
  });

  it('asks the renderer to lock from the menu item', () => {
    setState({ enabled: true, locked: false, accelerator: null });
    const lock = buildMenu.mock.calls.at(-1)![0].lock;
    lock.onLock();
    expect(contents.send).toHaveBeenCalledWith(LOCK_REQUEST_CHANNEL, 'menu');
  });

  it('forwards the OS locking and sleep only while the lock is on', () => {
    power.emit('lock-screen');
    expect(contents.send).not.toHaveBeenCalled();
    setState({ enabled: true, locked: false, accelerator: null });
    power.emit('lock-screen');
    power.emit('suspend');
    expect(contents.send.mock.calls).toEqual([
      [LOCK_REQUEST_CHANNEL, 'system-locked'],
      [LOCK_REQUEST_CHANNEL, 'suspended'],
    ]);
  });

  it('holds a hidden window transparent until the cover has painted', () => {
    setState({ enabled: true, locked: false, accelerator: null });
    win.emit('hide');
    expect(win.setOpacity).toHaveBeenLastCalledWith(0);
    win.emit('show');
    vi.advanceTimersByTime(SHOW_HOLD_TIMEOUT_MS - 1);
    expect(win.setOpacity).toHaveBeenCalledTimes(1);
    handlers.get(LOCK_COVER_PAINTED_CHANNEL)!({ sender: contents });
    expect(win.setOpacity).toHaveBeenLastCalledWith(1);
  });

  it('reveals the window after the timeout if the renderer never answers', () => {
    setState({ enabled: true, locked: false, accelerator: null });
    win.emit('minimize');
    win.emit('restore');
    vi.advanceTimersByTime(SHOW_HOLD_TIMEOUT_MS);
    expect(win.setOpacity).toHaveBeenLastCalledWith(1);
  });

  it('never hides a window while the lock is off', () => {
    win.emit('hide');
    win.emit('show');
    expect(win.setOpacity).not.toHaveBeenCalled();
  });

  const paint = (sender: unknown = contents) =>
    handlers.get(LOCK_COVER_PAINTED_CHANNEL)!({ sender });

  it('keeps the menu item and OS forwarding when the shortcut is unreadable', () => {
    setState({ enabled: true, locked: false, accelerator: 'Ctrl+L; rm -rf' });
    expect(buildMenu).toHaveBeenLastCalledWith({
      packaged: false,
      lock: expect.objectContaining({
        visible: true,
        enabled: true,
        accelerator: null,
      }),
    });
    power.emit('lock-screen');
    power.emit('suspend');
    expect(contents.send.mock.calls).toEqual([
      [LOCK_REQUEST_CHANNEL, 'system-locked'],
      [LOCK_REQUEST_CHANNEL, 'suspended'],
    ]);
  });

  it('ignores a painted signal from another sender', () => {
    setState({ enabled: true, locked: false, accelerator: null });
    win.emit('hide');
    win.emit('show');
    paint({ other: true });
    expect(win.setOpacity.mock.calls).toEqual([[0]]);
  });

  it('keeps the hold through a cover painted while hidden, until the next show', () => {
    setState({ enabled: true, locked: false, accelerator: null });
    win.emit('hide');
    // The renderer locks while hidden (OS lock, sleep, a crash reload) and paints its cover.
    paint();
    vi.advanceTimersByTime(SHOW_HOLD_TIMEOUT_MS * 2);
    expect(win.setOpacity.mock.calls).toEqual([[0]]);
    win.emit('show');
    vi.advanceTimersByTime(SHOW_HOLD_TIMEOUT_MS - 1);
    expect(win.setOpacity.mock.calls).toEqual([[0]]);
    paint();
    expect(win.setOpacity).toHaveBeenLastCalledWith(1);
  });

  it('keeps the hold through a cover painted while hidden, then reveals on the timeout', () => {
    setState({ enabled: true, locked: true, accelerator: null });
    win.emit('minimize');
    paint();
    win.emit('restore');
    vi.advanceTimersByTime(SHOW_HOLD_TIMEOUT_MS - 1);
    expect(win.setOpacity.mock.calls).toEqual([[0]]);
    vi.advanceTimersByTime(1);
    expect(win.setOpacity).toHaveBeenLastCalledWith(1);
  });

  it('cancels a pending reveal when the window hides again', () => {
    setState({ enabled: true, locked: false, accelerator: null });
    win.emit('hide');
    win.emit('show');
    win.emit('hide');
    vi.advanceTimersByTime(SHOW_HOLD_TIMEOUT_MS * 2);
    expect(win.setOpacity.mock.calls).toEqual([[0], [0]]);
    win.emit('show');
    vi.advanceTimersByTime(SHOW_HOLD_TIMEOUT_MS - 1);
    expect(win.setOpacity).toHaveBeenLastCalledWith(0);
    paint();
    expect(win.setOpacity).toHaveBeenLastCalledWith(1);
  });

  it('starts the reveal when a held window comes back through maximize, without restore', () => {
    setState({ enabled: true, locked: true, accelerator: null });
    win.emit('minimize');
    win.emit('maximize');
    vi.advanceTimersByTime(SHOW_HOLD_TIMEOUT_MS);
    expect(win.setOpacity).toHaveBeenLastCalledWith(1);
  });

  it('does not start the reveal for a focus while the window is still hidden', () => {
    setState({ enabled: true, locked: true, accelerator: null });
    win.emit('hide');
    win.isVisible.mockReturnValue(false);
    win.emit('focus');
    paint();
    vi.advanceTimersByTime(SHOW_HOLD_TIMEOUT_MS * 2);
    expect(win.setOpacity.mock.calls).toEqual([[0]]);
  });

  it('survives a window that throws while being destroyed', () => {
    setState({ enabled: true, locked: false, accelerator: null });
    win.setOpacity.mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });
    expect(() => win.emit('hide')).not.toThrow();
  });
  describe('when the renderer cannot report', () => {
    const hold = () => {
      setState({ enabled: true, locked: true, accelerator: null });
      win.emit('hide');
      win.emit('show');
    };

    it('keeps a held window hidden past the timeout while its renderer is not responding', () => {
      hold();
      win.emit('unresponsive');
      vi.advanceTimersByTime(SHOW_HOLD_TIMEOUT_MS * 10);
      expect(win.setOpacity.mock.calls).toEqual([[0]]);
      paint();
      expect(win.setOpacity).toHaveBeenLastCalledWith(1);
    });

    it('keeps it hidden after the renderer has gone, until the new renderer paints', () => {
      hold();
      contents.emit('render-process-gone', {}, { reason: 'crashed' });
      vi.advanceTimersByTime(SHOW_HOLD_TIMEOUT_MS * 10);
      // The reloaded renderer reports its state before its cover has painted.
      setState({ enabled: true, locked: true, accelerator: null });
      vi.advanceTimersByTime(SHOW_HOLD_TIMEOUT_MS * 10);
      expect(win.setOpacity.mock.calls).toEqual([[0]]);
      paint();
      expect(win.setOpacity).toHaveBeenLastCalledWith(1);
    });

    it('applies the usual timeout again once a hung renderer responds', () => {
      hold();
      win.emit('unresponsive');
      vi.advanceTimersByTime(SHOW_HOLD_TIMEOUT_MS * 10);
      win.emit('responsive');
      vi.advanceTimersByTime(SHOW_HOLD_TIMEOUT_MS - 1);
      expect(win.setOpacity.mock.calls).toEqual([[0]]);
      vi.advanceTimersByTime(1);
      expect(win.setOpacity).toHaveBeenLastCalledWith(1);
    });

    it('holds a window shown while its renderer is still gone', () => {
      setState({ enabled: true, locked: true, accelerator: null });
      win.emit('hide');
      contents.emit('render-process-gone', {}, { reason: 'oom' });
      win.emit('show');
      vi.advanceTimersByTime(SHOW_HOLD_TIMEOUT_MS * 10);
      expect(win.setOpacity.mock.calls).toEqual([[0]]);
    });

    it('shows the window once the reloaded renderer reports the lock is off', () => {
      hold();
      contents.emit('render-process-gone', {}, { reason: 'crashed' });
      vi.advanceTimersByTime(SHOW_HOLD_TIMEOUT_MS);
      setState({ enabled: false, locked: false, accelerator: null });
      expect(win.setOpacity).toHaveBeenLastCalledWith(1);
    });

    it('reveals on the timeout as before once the new renderer has reported', () => {
      setState({ enabled: true, locked: true, accelerator: null });
      win.emit('hide');
      contents.emit('render-process-gone', {}, { reason: 'crashed' });
      setState({ enabled: true, locked: true, accelerator: null });
      win.emit('show');
      vi.advanceTimersByTime(SHOW_HOLD_TIMEOUT_MS);
      expect(win.setOpacity).toHaveBeenLastCalledWith(1);
    });
  });
});
