import {
  EventType,
  MatrixError,
  SyncState,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { roomEncryptionRepair } from './room-encryption-repair';

const SERVER_CONTENT = {
  algorithm: 'm.megolm.v1.aes-sha2',
  rotation_period_ms: 604_800_000,
};

function setup(
  options: {
    stateEvent?: boolean;
    stored?: boolean;
    serverState?: () => Promise<unknown>;
    storeRead?: () => Promise<boolean>;
  } = {},
) {
  const room = {
    roomId: '!room:hs',
    getMyMembership: () => 'join',
    hasEncryptionStateEvent: () => options.stateEvent ?? false,
  };
  let applied = false;
  const onCryptoEvent = vi.fn(async (_room: unknown, _event: MatrixEvent) => {
    applied = true;
  });
  const getStateEvent = vi.fn(
    options.serverState ?? (() => Promise.resolve(SERVER_CONTENT)),
  );
  const client = {
    getRooms: () => [room],
    getStateEvent,
    getCrypto: () => ({
      onCryptoEvent,
      isEncryptionEnabledInRoom: () =>
        applied
          ? Promise.resolve(true)
          : (options.storeRead?.() ?? Promise.resolve(options.stored ?? true)),
    }),
  };
  const sync = roomEncryptionRepair(client as unknown as MatrixClient);
  return { room, sync, onCryptoEvent, getStateEvent };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('roomEncryptionRepair', () => {
  it("applies the server's m.room.encryption when the store says encrypted but sync left it out", async () => {
    const { room, sync, onCryptoEvent, getStateEvent } = setup();

    sync(SyncState.Prepared);

    await vi.waitFor(() => expect(onCryptoEvent).toHaveBeenCalledTimes(1));
    expect(getStateEvent).toHaveBeenCalledExactlyOnceWith(
      room.roomId,
      EventType.RoomEncryption,
      '',
    );
    const [appliedRoom, event] = onCryptoEvent.mock.calls[0] ?? [];
    expect(appliedRoom).toBe(room);
    expect(event?.getContent()).toEqual(SERVER_CONTENT);
  });

  it('repairs a room once per session, however many syncs arrive', async () => {
    let answer!: (content: unknown) => void;
    const { sync, onCryptoEvent, getStateEvent } = setup({
      serverState: () => new Promise((resolve) => (answer = resolve)),
    });

    sync(SyncState.Prepared);
    sync(SyncState.Syncing);
    await vi.waitFor(() => expect(getStateEvent).toHaveBeenCalled());
    sync(SyncState.Syncing);
    answer(SERVER_CONTENT);
    await vi.waitFor(() => expect(onCryptoEvent).toHaveBeenCalled());
    sync(SyncState.Syncing);
    await Promise.resolve();

    expect(getStateEvent).toHaveBeenCalledTimes(1);
    expect(onCryptoEvent).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the synced state has the event', async () => {
    const { sync, onCryptoEvent, getStateEvent } = setup({ stateEvent: true });

    sync(SyncState.Prepared);
    await new Promise((resolve) => setTimeout(resolve));

    expect(getStateEvent).not.toHaveBeenCalled();
    expect(onCryptoEvent).not.toHaveBeenCalled();
  });

  it('does nothing in a room the crypto store has as unencrypted', async () => {
    const { sync, onCryptoEvent, getStateEvent } = setup({ stored: false });

    sync(SyncState.Prepared);
    await new Promise((resolve) => setTimeout(resolve));

    expect(getStateEvent).not.toHaveBeenCalled();
    expect(onCryptoEvent).not.toHaveBeenCalled();
  });

  it('retries a failed repair on a later sync, not on every one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let calls = 0;
    const { sync, onCryptoEvent, getStateEvent } = setup({
      serverState: () =>
        ++calls === 1
          ? Promise.reject(new Error('offline'))
          : Promise.resolve(SERVER_CONTENT),
    });

    sync(SyncState.Prepared);
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledTimes(1));
    sync(SyncState.Syncing);
    await new Promise((resolve) => setTimeout(resolve));
    expect(getStateEvent).toHaveBeenCalledTimes(1);

    sync(SyncState.Syncing);

    await vi.waitFor(() => expect(onCryptoEvent).toHaveBeenCalledTimes(1));
    expect(getStateEvent).toHaveBeenCalledTimes(2);
    expect(onCryptoEvent.mock.calls[0]?.[1].getContent()).toEqual(
      SERVER_CONTENT,
    );
  });

  it('retries after a crypto store read that throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let reads = 0;
    const { sync, onCryptoEvent } = setup({
      storeRead: () =>
        ++reads === 1
          ? Promise.reject(new Error('store busy'))
          : Promise.resolve(true),
    });

    sync(SyncState.Prepared);
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledTimes(1));
    sync(SyncState.Syncing);
    sync(SyncState.Syncing);

    await vi.waitFor(() => expect(onCryptoEvent).toHaveBeenCalledTimes(1));
  });

  it('logs a failed fetch and carries on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sync, onCryptoEvent } = setup({
      serverState: () =>
        Promise.reject(
          new MatrixError({ errcode: 'M_UNKNOWN', error: 'busy' }, 500),
        ),
    });

    sync(SyncState.Prepared);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(onCryptoEvent).not.toHaveBeenCalled();
  });
});
