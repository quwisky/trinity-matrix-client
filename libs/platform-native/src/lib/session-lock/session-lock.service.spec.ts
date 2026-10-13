import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { desktopBridgeFixture } from '@trinity/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionLockService } from './session-lock.service';
import {
  SESSION_CHANNEL_FACTORY,
  SESSION_HANDOVER_TIMEOUT_MS,
  SESSION_LOCK_NAME,
  SESSION_LOCK_REQUIRED,
  SESSION_LOCKS,
  type SessionChannel,
  type SessionHandoverRequest,
  type SessionLocks,
} from './session-lock.tokens';

type GrantCallback = (lock: Lock | null) => Promise<void> | undefined;

/** One origin's exclusive Web Lock: one holder, a first-in-first-out queue, `ifAvailable`. */
class FakeLocks implements SessionLocks {
  readonly requests: {
    readonly name: string;
    readonly options: LockOptions;
  }[] = [];
  refuse = false;
  /** The browser drops queued (not `ifAvailable`) requests, as it may for a frozen page. */
  refuseQueued = false;
  private holder: object | null = null;
  private readonly queue: GrantCallback[] = [];

  get queued(): number {
    return this.queue.length;
  }

  request(
    name: string,
    options: LockOptions,
    callback: GrantCallback,
  ): Promise<unknown> {
    this.requests.push({ name, options });
    if (this.refuse) {
      return Promise.reject(new DOMException('Refused', 'SecurityError'));
    }
    if (this.refuseQueued && !options.ifAvailable) {
      return Promise.reject(new DOMException('Dropped', 'AbortError'));
    }
    if (this.holder === null && this.queue.length === 0) {
      this.grant(callback);
    } else if (options.ifAvailable) {
      return Promise.resolve(callback(null));
    } else {
      this.queue.push(callback);
    }
    return Promise.resolve();
  }

  /** The holding tab closed or crashed: the browser frees the lock; its promise never settles. */
  dropHolder(): void {
    this.holder = null;
    this.grantNext();
  }

  private grant(callback: GrantCallback): void {
    const holder = {};
    this.holder = holder;
    const held = callback({
      name: SESSION_LOCK_NAME,
      mode: 'exclusive',
    } as Lock);
    void Promise.resolve(held).then(() => {
      if (this.holder !== holder) return;
      this.holder = null;
      this.grantNext();
    });
  }

  private grantNext(): void {
    const next = this.queue.shift();
    if (next) this.grant(next);
  }
}

/** One origin's BroadcastChannel: a message reaches every other open channel, never its sender. */
class FakeChannels {
  readonly posted: unknown[] = [];
  private readonly channels = new Set<SessionChannel>();

  readonly open = (): SessionChannel => {
    const channel: SessionChannel = {
      onmessage: null,
      postMessage: (message: SessionHandoverRequest) =>
        this.broadcast(message, channel),
      close: () => {
        this.channels.delete(channel);
      },
    };
    this.channels.add(channel);
    return channel;
  };

  /** Deliver `data` as another tab, or a foreign page, would post it. */
  broadcast(data: unknown, sender: SessionChannel | null = null): void {
    this.posted.push(data);
    for (const channel of this.channels) {
      if (channel !== sender) {
        queueMicrotask(() =>
          channel.onmessage?.({ data } as MessageEvent<unknown>),
        );
      }
    }
  }
}

function setup(
  options: {
    readonly locks?: SessionLocks | null;
    readonly required?: boolean;
  } = {},
) {
  const locks = new FakeLocks();
  const channels = new FakeChannels();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: SESSION_LOCKS,
        useValue: options.locks === undefined ? locks : options.locks,
      },
      { provide: SESSION_LOCK_REQUIRED, useValue: options.required ?? true },
      { provide: SESSION_CHANNEL_FACTORY, useValue: channels.open },
    ],
  });
  /** One more tab of the same origin: its own service over the shared locks and channel. */
  const openTab = (): SessionLockService =>
    TestBed.runInInjectionContext(() => new SessionLockService());
  return { locks, channels, openTab };
}

/** Let queued lock grants and channel deliveries run (real timers only). */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('SessionLockService', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('holds the lock when no other tab has it, asking the browser once', async () => {
    const { locks, openTab } = setup();
    const tab = openTab();

    const answers = await Promise.all([
      firstValueFrom(tab.acquire()),
      firstValueFrom(tab.acquire()),
    ]);

    expect(answers).toEqual(['held', 'held']);
    expect(tab.state()).toBe('held');
    expect(locks.requests).toEqual([
      {
        name: 'trinity-session',
        options: { mode: 'exclusive', ifAvailable: true },
      },
    ]);
  });

  it('waits while another tab holds the lock, and holds it once that tab goes', async () => {
    const { locks, openTab } = setup();
    const owner = openTab();
    const waiter = openTab();
    await firstValueFrom(owner.acquire());

    await expect(firstValueFrom(waiter.acquire())).resolves.toBe('waiting');
    expect(waiter.state()).toBe('waiting');
    expect(locks.requests.at(-1)).toEqual({
      name: 'trinity-session',
      options: { mode: 'exclusive' },
    });
    const granted = firstValueFrom(waiter.granted());

    locks.dropHolder();

    await expect(granted).resolves.toBeUndefined();
    expect(waiter.state()).toBe('held');
  });

  it('emits granted at once in a tab that already holds the lock', async () => {
    const { openTab } = setup();
    const tab = openTab();
    await firstValueFrom(tab.acquire());

    await expect(firstValueFrom(tab.granted())).resolves.toBeUndefined();
  });

  it('lets waiting tabs start in the order they queued, one at a time', async () => {
    const { locks, openTab } = setup();
    const owner = openTab();
    const first = openTab();
    const second = openTab();
    await firstValueFrom(owner.acquire());
    await firstValueFrom(first.acquire());
    await firstValueFrom(second.acquire());

    locks.dropHolder();
    await settle();

    expect([first.state(), second.state()]).toEqual(['held', 'waiting']);

    locks.dropHolder();
    await settle();

    expect(second.state()).toBe('held');
  });

  it('hands over: the holder hears the request and keeps the lock until its page goes, then the requesting tab gets it', async () => {
    const { locks, channels, openTab } = setup();
    const owner = openTab();
    const requester = openTab();
    await firstValueFrom(owner.acquire());
    await firstValueFrom(requester.acquire());
    const heardIn: string[] = [];
    owner.handoverRequests.subscribe(() => heardIn.push(owner.state()));

    requester.requestHandover();

    expect(requester.state()).toBe('taking-over');
    expect(channels.posted).toEqual([
      { type: 'handover-request', id: expect.any(String) },
    ]);
    await vi.waitFor(() => expect(heardIn).toEqual(['releasing']), {
      timeout: 1_000,
    });
    await settle();
    // No early release: the holder's lock frees only when its restart unloads the page.
    expect(owner.state()).toBe('releasing');
    expect(requester.state()).toBe('taking-over');

    locks.dropHolder();

    await vi.waitFor(() => expect(requester.state()).toBe('held'), {
      timeout: 1_000,
    });
  });

  it('offers "Try again" after 15 seconds without the lock, sends the request again, and stays queued', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const { locks, channels, openTab } = setup();
    const owner = openTab();
    const requester = openTab();
    await firstValueFrom(owner.acquire());
    await firstValueFrom(requester.acquire());
    // The holder is frozen: nothing listens for its requests, so it never answers.

    requester.requestHandover();
    await vi.advanceTimersByTimeAsync(SESSION_HANDOVER_TIMEOUT_MS - 100);
    expect(requester.state()).toBe('taking-over');
    await vi.advanceTimersByTimeAsync(200);
    expect(requester.state()).toBe('handover-timed-out');

    requester.requestHandover();
    expect(requester.state()).toBe('taking-over');
    expect(channels.posted).toHaveLength(2);

    locks.dropHolder();
    await vi.advanceTimersByTimeAsync(0);
    expect(requester.state()).toBe('held');
    // The second request's timer must not mark a tab that now holds the lock as timed out.
    await vi.advanceTimersByTimeAsync(SESSION_HANDOVER_TIMEOUT_MS + 100);
    expect(requester.state()).toBe('held');
  });

  it('ignores a handover request in a tab that does not hold the lock', async () => {
    const { openTab } = setup();
    const holder = openTab();
    const earlier = openTab();
    const requester = openTab();
    await firstValueFrom(holder.acquire());
    await firstValueFrom(earlier.acquire());
    await firstValueFrom(requester.acquire());
    const heardByHolder = vi.fn();
    const heardByEarlier = vi.fn();
    holder.handoverRequests.subscribe(heardByHolder);
    earlier.handoverRequests.subscribe(heardByEarlier);
    // `earlier` asks first, so it has its channel open and is listening when the next request comes.
    earlier.requestHandover();
    await settle();

    requester.requestHandover();
    await settle();

    expect(heardByHolder).toHaveBeenCalledOnce();
    expect(heardByEarlier).not.toHaveBeenCalled();
    expect(earlier.state()).toBe('taking-over');
  });

  it('offers "Try again" when the browser drops a queued request, and queues again on it', async () => {
    const { locks, openTab } = setup();
    const owner = openTab();
    const waiter = openTab();
    await firstValueFrom(owner.acquire());
    locks.refuseQueued = true;

    await expect(firstValueFrom(waiter.acquire())).resolves.toBe('waiting');
    await settle();

    // Web Locks exist here, so this is not the secure-connection case.
    expect(waiter.state()).toBe('handover-timed-out');
    expect(locks.queued).toBe(0);

    locks.refuseQueued = false;
    waiter.requestHandover();

    expect(waiter.state()).toBe('taking-over');
    expect(locks.queued).toBe(1);
    locks.dropHolder();
    await settle();
    expect(waiter.state()).toBe('held');
  });

  it('hands over once when two requests arrive together', async () => {
    const { openTab } = setup();
    const owner = openTab();
    const first = openTab();
    const second = openTab();
    await firstValueFrom(owner.acquire());
    await firstValueFrom(first.acquire());
    await firstValueFrom(second.acquire());
    const heard = vi.fn();
    owner.handoverRequests.subscribe(heard);

    first.requestHandover();
    second.requestHandover();
    await settle();

    expect(heard).toHaveBeenCalledOnce();
    expect(owner.state()).toBe('releasing');
  });

  it.each([
    ['a bare string', 'handover-request'],
    ['no id', { type: 'handover-request' }],
    ['a numeric id', { type: 'handover-request', id: 7 }],
    ['another type', { type: 'session-ended', id: 'x' }],
    ['null', null],
  ])('ignores a channel message with %s', async (_label, data) => {
    const { channels, openTab } = setup();
    const owner = openTab();
    await firstValueFrom(owner.acquire());
    const heard = vi.fn();
    owner.handoverRequests.subscribe(heard);

    channels.broadcast(data);
    await settle();

    expect(heard).not.toHaveBeenCalled();
    expect(owner.state()).toBe('held');
  });

  it('is unavailable without the Web Locks API', async () => {
    const { openTab } = setup({ locks: null });
    const tab = openTab();

    await expect(firstValueFrom(tab.acquire())).resolves.toBe('unavailable');
    expect(tab.state()).toBe('unavailable');
  });

  it('is unavailable when the lock request throws, and stays so without asking again', async () => {
    const { locks, openTab } = setup();
    locks.refuse = true;
    const tab = openTab();

    await expect(firstValueFrom(tab.acquire())).resolves.toBe('unavailable');
    await expect(firstValueFrom(tab.acquire())).resolves.toBe('unavailable');
    expect(tab.state()).toBe('unavailable');
    expect(locks.requests).toHaveLength(1);
  });

  it('needs no lock in the desktop shell or an installed app', async () => {
    const { locks, openTab } = setup({ required: false });
    const tab = openTab();

    await expect(firstValueFrom(tab.acquire())).resolves.toBe('not-required');
    expect(tab.state()).toBe('not-required');
    expect(locks.requests).toEqual([]);
  });
});

describe('SESSION_LOCK_REQUIRED', () => {
  afterEach(() => {
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('is required in a plain browser tab', () => {
    expect(TestBed.inject(SESSION_LOCK_REQUIRED)).toBe(true);
  });

  it('is not required in the Electron renderer', () => {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture();

    expect(TestBed.inject(SESSION_LOCK_REQUIRED)).toBe(false);
  });

  it('is not required in an installed Capacitor app', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);

    expect(TestBed.inject(SESSION_LOCK_REQUIRED)).toBe(false);
  });
});
