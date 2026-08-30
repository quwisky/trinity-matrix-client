import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, mainWindowRef } = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: { sender: unknown }, request: unknown) => unknown
  >(),
  mainWindowRef: { current: null as { webContents: unknown } | null },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: { sender: unknown }, request: unknown) => unknown,
    ) => handlers.set(channel, handler),
  },
}));
vi.mock('./window', () => ({ getMainWindow: () => mainWindowRef.current }));

import {
  HOST_NEGOTIATE_CHANNEL,
  HOST_OPERATIONS,
  negotiateHostCapabilities,
  registerHostCapabilityHandshake,
} from './host-capabilities';

describe('host capability negotiation', () => {
  it('returns an explicit result for every requested operation', () => {
    const result = negotiateHostCapabilities({
      protocolVersion: 1,
      operations: HOST_OPERATIONS,
    });

    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(Object.keys(result.operations)).toEqual(HOST_OPERATIONS);
    expect(result.operations.badge).toEqual({ kind: 'supported' });
    expect(result.operations.updates).toEqual({
      kind: 'unavailable',
      reason: 'not-implemented',
    });
  });

  it('rejects mismatched protocol versions and hostile operation names', () => {
    expect(
      negotiateHostCapabilities({ protocolVersion: 2, operations: [] }),
    ).toEqual({ kind: 'rejected', reason: 'protocol-mismatch' });
    expect(
      negotiateHostCapabilities({
        protocolVersion: 1,
        operations: ['badge', 'shell:execute'],
      }),
    ).toEqual({ kind: 'rejected', reason: 'malformed-request' });
    expect(
      negotiateHostCapabilities({
        protocolVersion: 1,
        operations: ['badge', 'badge'],
      }),
    ).toEqual({ kind: 'rejected', reason: 'malformed-request' });
  });
});

describe('host capability IPC', () => {
  beforeEach(() => {
    handlers.clear();
    mainWindowRef.current = { webContents: { id: 1 } };
    registerHostCapabilityHandshake();
  });

  it('rejects a foreign sender without reflecting request data', () => {
    const handler = handlers.get(HOST_NEGOTIATE_CHANNEL);
    expect(
      handler?.(
        { sender: { id: 99 } },
        { protocolVersion: 1, operations: ['badge'], secret: 'never-return' },
      ),
    ).toEqual({ kind: 'rejected', reason: 'malformed-request' });
  });
});
