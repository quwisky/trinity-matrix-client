import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { exposed, invoke, on, send, removeListener } = vi.hoisted(() => ({
  exposed: { value: undefined as unknown },
  invoke: vi.fn(() => Promise.resolve({ kind: 'completed' })),
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
    readonly deepLinks: unknown;
    readonly notificationPresentation: unknown;
    readonly badge: { readonly set: (count: number) => Promise<unknown> };
    readonly secureStore: unknown;
    readonly networkCors: unknown;
    readonly location: unknown;
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

  beforeEach(() => invoke.mockClear());

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

  it('scopes badge writes to the versioned badge capability', async () => {
    await bridge.capabilities.badge.set(7);

    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'trinity:host:v1:badge:set',
      7,
    );
  });

  it('rejects hostile badge input before IPC with a secret-safe code', async () => {
    const result = await bridge.capabilities.badge.set('7' as never);

    expect(result).toEqual({
      kind: 'rejected',
      diagnostic: { code: 'invalid-badge-count' },
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
