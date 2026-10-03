import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { exposed, invoke, on, send, removeListener } = vi.hoisted(() => ({
  exposed: { value: undefined as unknown },
  invoke: vi.fn<(channel: string, request?: unknown) => Promise<unknown>>(() =>
    Promise.resolve({ kind: 'completed' }),
  ),
  on: vi.fn(),
  send: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, value: unknown) => {
      exposed.value = value;
    },
  },
  ipcRenderer: { invoke, on, send, removeListener },
}));

type ExposedBridge = {
  readonly protocolVersion: unknown;
  readonly negotiate: (operations: readonly string[]) => Promise<unknown>;
  readonly capabilities: {
    readonly deepLinks: {
      readonly subscribe: (callback: (url: string) => void) => () => void;
    };
    readonly notificationPresentation: {
      readonly present: (payload: unknown) => Promise<unknown>;
      readonly subscribeClicks: (
        callback: (destination: unknown) => void,
      ) => () => void;
    };
    readonly badge: { readonly set: (count: number) => Promise<unknown> };
    readonly secureStore: {
      readonly isAvailable: () => Promise<boolean>;
      readonly get: (key: string) => Promise<string | null>;
      readonly set: (key: string, value: string) => Promise<boolean>;
      readonly delete: (key: string) => Promise<void>;
    };
    readonly networkCors: {
      readonly setAllowedOrigins: (origins: readonly string[]) => void;
      readonly allowOrigin: (origin: string) => void;
    };
    readonly location: {
      readonly approximate: () => Promise<{
        lat: number;
        lng: number;
      } | null>;
    };
  };
  readonly onDeepLink?: unknown;
  readonly showNotification?: unknown;
  readonly onNotificationClick?: unknown;
  readonly secureStore?: unknown;
  readonly cors?: unknown;
  readonly resolveApproxLocation?: unknown;
  readonly ipcRenderer?: unknown;
};

describe('preload host capabilities', () => {
  let bridge: ExposedBridge;

  beforeAll(async () => {
    await import('./preload');
    bridge = exposed.value as ExposedBridge;
  });

  beforeEach(async () => {
    invoke.mockReset();
    invoke.mockResolvedValueOnce({
      kind: 'rejected',
      reason: 'malformed-request',
    });
    await bridge.negotiate([]);
    invoke.mockImplementation((channel: string, request?: unknown) =>
      Promise.resolve(
        channel === 'trinity:host:v1:negotiate'
          ? acceptedNegotiation(request)
          : { kind: 'completed' },
      ),
    );
    invoke.mockClear();
    on.mockClear();
    send.mockClear();
    removeListener.mockClear();
  });

  it('exposes protocol v1 without leaking ipcRenderer', () => {
    expect(bridge.protocolVersion).toBe(1);
    expect(bridge.ipcRenderer).toBeUndefined();
  });

  it('exposes required grouped capabilities without legacy flat methods', () => {
    expect(Object.keys(bridge.capabilities).sort()).toEqual([
      'badge',
      'deepLinks',
      'location',
      'networkCors',
      'notificationPresentation',
      'secureStore',
    ]);
    expect(bridge.onDeepLink).toBeUndefined();
    expect(bridge.showNotification).toBeUndefined();
    expect(bridge.onNotificationClick).toBeUndefined();
    expect(bridge.secureStore).toBeUndefined();
    expect(bridge.cors).toBeUndefined();
    expect(bridge.resolveApproxLocation).toBeUndefined();
  });

  it('sends a versioned negotiation request', async () => {
    await bridge.negotiate(['badge']);

    expect(invoke).toHaveBeenCalledWith('trinity:host:v1:negotiate', {
      protocolVersion: 1,
      operations: ['badge'],
    });
  });

  it('keeps every privileged group inert before an accepted negotiation', async () => {
    const deepLink = vi.fn();
    const click = vi.fn();

    bridge.capabilities.deepLinks.subscribe(deepLink);
    bridge.capabilities.notificationPresentation.subscribeClicks(click);
    bridge.capabilities.networkCors.allowOrigin('https://matrix.example');

    await expect(bridge.capabilities.badge.set(7)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'host-rejected',
    });
    await expect(
      bridge.capabilities.notificationPresentation.present({}),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'host-rejected',
    });
    await expect(bridge.capabilities.secureStore.isAvailable()).resolves.toBe(
      false,
    );
    await expect(
      bridge.capabilities.location.approximate(),
    ).resolves.toBeNull();
    expect(on).not.toHaveBeenCalledWith(
      'notification-click',
      expect.anything(),
    );
    expect(send).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('grants only supported operations from the latest accepted negotiation', async () => {
    await bridge.negotiate(['badge']);
    invoke.mockClear();

    await bridge.capabilities.badge.set(3);
    await expect(bridge.capabilities.secureStore.isAvailable()).resolves.toBe(
      false,
    );
    await expect(
      bridge.capabilities.notificationPresentation.present({}),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'host-rejected',
    });

    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'trinity:host:v1:badge:set',
      3,
    );

    invoke.mockResolvedValueOnce({
      kind: 'rejected',
      reason: 'protocol-mismatch',
    });
    await bridge.negotiate(['badge']);
    invoke.mockClear();
    await expect(bridge.capabilities.badge.set(4)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'host-rejected',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('ignores an older negotiation that settles after its replacement', async () => {
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    invoke
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    const olderRequest = bridge.negotiate(['secure-store']);
    const newerRequest = bridge.negotiate(['badge']);
    newer.resolve({ kind: 'rejected', reason: 'protocol-mismatch' });
    await newerRequest;
    older.resolve(
      acceptedNegotiation({
        protocolVersion: 1,
        operations: ['secure-store'],
      }),
    );
    await olderRequest;
    invoke.mockClear();

    await expect(bridge.capabilities.secureStore.isAvailable()).resolves.toBe(
      false,
    );
    await expect(bridge.capabilities.badge.set(2)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'host-rejected',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('scopes badge writes to the versioned badge capability', async () => {
    await bridge.negotiate(['badge']);
    invoke.mockClear();
    await bridge.capabilities.badge.set(7);

    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'trinity:host:v1:badge:set',
      7,
    );
  });

  it('rejects hostile badge input before IPC with a secret-safe code', async () => {
    await bridge.negotiate(['badge']);
    invoke.mockClear();
    const result = await bridge.capabilities.badge.set('7' as never);

    expect(result).toEqual({
      kind: 'rejected',
      diagnostic: { code: 'invalid-badge-count' },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('round-trips only complete typed notification destinations', async () => {
    await bridge.negotiate(['notification-presentation']);
    invoke.mockClear();
    const destination = {
      accountId: '@me:example.org',
      roomId: '!room:example.org',
      eventId: '$event',
    };
    await bridge.capabilities.notificationPresentation.present({
      title: 'Alice',
      body: 'Hello',
      destination,
    });
    expect(invoke).toHaveBeenCalledWith(
      'trinity:host:v1:notification-presentation:present',
      {
        title: 'Alice',
        body: 'Hello',
        tag: undefined,
        destination,
        silent: false,
      },
    );

    const activated = vi.fn();
    const unsubscribe =
      bridge.capabilities.notificationPresentation.subscribeClicks(activated);
    const listener = on.mock.calls.find(
      ([channel]) => channel === 'notification-click',
    )?.[1] as (event: unknown, destination: unknown) => void;
    listener({}, { roomId: 42 });
    listener({}, destination);

    expect(activated).toHaveBeenCalledExactlyOnceWith(destination);

    await bridge.negotiate(['badge']);
    listener({}, destination);
    expect(activated).toHaveBeenCalledOnce();

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith('notification-click', listener);
  });

  it('rejects malformed notification destinations before IPC', async () => {
    await bridge.negotiate(['notification-presentation']);
    invoke.mockClear();
    await expect(
      bridge.capabilities.notificationPresentation.present({
        title: 'Alice',
        body: 'Hello',
        destination: { roomId: 42 },
      }),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'invalid-notification-payload' },
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

function acceptedNegotiation(request: unknown): unknown {
  const operations =
    request && typeof request === 'object'
      ? (request as { operations?: unknown }).operations
      : undefined;
  const requested = Array.isArray(operations) ? operations : [];
  return {
    kind: 'accepted',
    protocolVersion: 1,
    operations: Object.fromEntries(
      requested.map((operation) => [operation, { kind: 'supported' }]),
    ),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
