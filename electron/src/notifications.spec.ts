import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class FakeNotification {
    static supported = true;
    static mode: 'show' | 'fail' | 'throw' | 'construct' | 'pending' = 'show';
    static instances: FakeNotification[] = [];
    readonly listeners = new Map<string, Set<Listener>>();
    readonly close = vi.fn();

    constructor(readonly options: Record<string, unknown>) {
      if (FakeNotification.mode === 'construct') {
        throw new Error('native constructor details');
      }
      FakeNotification.instances.push(this);
    }

    static isSupported(): boolean {
      return FakeNotification.supported;
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? new Set<Listener>();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, listener: Listener): this {
      const once = (...args: unknown[]): void => {
        this.removeListener(event, once);
        listener(...args);
      };
      return this.on(event, once);
    }

    removeListener(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(...args);
      }
    }

    show(): void {
      if (FakeNotification.mode === 'throw') throw new Error('native details');
      if (FakeNotification.mode === 'fail') {
        this.emit('failed', {}, 'native details');
      } else if (FakeNotification.mode === 'show') {
        this.emit('show');
      }
    }
  }

  return {
    FakeNotification,
    handlers: new Map<
      string,
      (event: { sender: unknown }, raw: unknown) => unknown
    >(),
    mainWindow: {
      current: null as {
        webContents: { send: ReturnType<typeof vi.fn> };
      } | null,
    },
    focusMainWindow: vi.fn(),
  };
});

vi.mock('electron', () => ({
  Notification: mocks.FakeNotification,
  nativeImage: { createFromPath: vi.fn() },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: { sender: unknown }, raw: unknown) => unknown,
    ) => mocks.handlers.set(channel, handler),
  },
}));
vi.mock('node:fs', () => ({ existsSync: () => false }));
vi.mock('./icons', () => ({ iconCandidatePaths: () => [] }));
vi.mock('./window', () => ({
  focusMainWindow: mocks.focusMainWindow,
  getMainWindow: () => mocks.mainWindow.current,
}));

import {
  NOTIFICATION_CLICK_CHANNEL,
  SHOW_NOTIFICATION_CHANNEL,
  registerNotificationIpc,
} from './notifications';

const destination = {
  accountId: '@me:example.org',
  roomId: '!room:example.org',
  eventId: '$event',
} as const;

describe('notification-presentation IPC', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.FakeNotification.instances = [];
    mocks.FakeNotification.supported = true;
    mocks.FakeNotification.mode = 'show';
    mocks.focusMainWindow.mockClear();
    mocks.mainWindow.current = { webContents: { send: vi.fn() } };
    registerNotificationIpc();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function present(
    payload: unknown,
    sender: unknown = mocks.mainWindow.current?.webContents,
  ): Promise<unknown> {
    return await mocks.handlers.get(SHOW_NOTIFICATION_CHANNEL)?.(
      { sender },
      payload,
    );
  }

  it('returns completed only after the OS reports the notification shown', async () => {
    await expect(
      present({ title: 'Alice', body: 'Hello', destination, silent: true }),
    ).resolves.toEqual({ kind: 'completed' });
    expect(mocks.FakeNotification.instances[0].options).toMatchObject({
      title: 'Alice',
      body: 'Hello',
      silent: true,
    });
  });

  it('returns explicit unavailable and secret-safe failure outcomes', async () => {
    mocks.FakeNotification.supported = false;
    await expect(
      present({ title: 'Alice', body: 'Hello', destination }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'not-supported' });

    mocks.FakeNotification.supported = true;
    mocks.FakeNotification.mode = 'fail';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await present({
      title: 'Alice',
      body: 'Hello',
      destination,
    });
    expect(result).toEqual({
      kind: 'rejected',
      diagnostic: { code: 'notification-host-failed' },
    });
    expect(JSON.stringify(result)).not.toContain('native details');
  });

  it.each(['construct', 'throw'] as const)(
    'maps a synchronous %s failure to a secret-safe typed outcome',
    async (mode) => {
      mocks.FakeNotification.mode = mode;

      const result = await present({
        title: 'Alice',
        body: 'Hello',
        destination,
      });

      expect(result).toEqual({
        kind: 'rejected',
        diagnostic: { code: 'notification-host-failed' },
      });
      expect(JSON.stringify(result)).not.toContain('native');
    },
  );

  it('returns a typed timeout when the OS never acknowledges presentation', async () => {
    vi.useFakeTimers();
    mocks.FakeNotification.mode = 'pending';

    const result = present({ title: 'Alice', body: 'Hello', destination });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'notification-host-timeout' },
    });
  });

  it('rejects foreign senders and malformed payloads before native access', async () => {
    await expect(
      present({ title: 'Alice', body: 'Hello', destination }, { id: 99 }),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'sender-rejected' },
    });
    await expect(present({ title: 'Alice', destination: {} })).resolves.toEqual(
      {
        kind: 'rejected',
        diagnostic: { code: 'invalid-notification-payload' },
      },
    );
    expect(mocks.FakeNotification.instances).toHaveLength(0);
  });

  it('forwards a typed activation after focusing the main window', async () => {
    await present({ title: 'Alice', body: 'Hello', destination });
    mocks.FakeNotification.instances[0].emit('click');

    expect(mocks.focusMainWindow).toHaveBeenCalledOnce();
    expect(
      mocks.mainWindow.current?.webContents.send,
    ).toHaveBeenCalledExactlyOnceWith(NOTIFICATION_CLICK_CHANNEL, destination);
  });
});
