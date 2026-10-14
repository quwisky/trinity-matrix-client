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

const contents = { send: vi.fn() };

function fakeWindow() {
  const events = new EventEmitter();
  return Object.assign(events, {
    webContents: contents,
    setOpacity: vi.fn(),
    isDestroyed: () => false,
  });
}

describe('parseLockState', () => {
  it.each([
    [
      { enabled: true, locked: false, accelerator: 'CommandOrControl+Shift+L' },
      true,
    ],
    [{ enabled: true, locked: true, accelerator: null }, true],
    [{ enabled: 'yes', locked: false, accelerator: null }, false],
    [{ enabled: true, locked: false, accelerator: 'Ctrl+L; rm -rf' }, false],
    [{ enabled: true, locked: false, accelerator: 'x'.repeat(65) }, false],
    [null, false],
  ])('accepts %j: %s', (raw, ok) => {
    expect(parseLockState(raw) !== null).toBe(ok);
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
    contents.send.mockClear();
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
});
