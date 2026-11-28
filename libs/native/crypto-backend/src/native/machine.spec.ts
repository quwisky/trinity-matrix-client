import * as real from '@matrix-org/matrix-sdk-crypto-wasm-real';

import { install } from './install';
import {
  NativeBridgeError,
  NativeCryptoError,
  type NativeCryptoOptions,
  NativeMachineLostError,
  type NativeRequest,
  type NativeResponse,
} from './types';

const description = {
  userId: '@alice:example.org',
  deviceId: 'ALICE',
  identityKeys: {
    ed25519: 'ed-key',
    curve25519: 'mB7Ywmbd9WlFtWhT/4ZbVlUFkNmz04hxkx1bt+QBJ0E',
  },
  deviceCreationTimeMs: 1234,
};
const key = new Uint8Array(32).fill(7);

/**
 * A crate with one machine: `panicOn` makes the next call of a method answer `Panic` and drop
 * the machine, which then answers `UnknownMachine` until `init`.
 */
function fakeCrate() {
  const requests: NativeRequest[] = [];
  const crate = {
    requests,
    open: false,
    panicOn: new Set<string>(),
    failInit: false,
    answers: {
      receiveSyncChanges: [],
      receiveSyncChangesMsc4186: [],
    } as Record<string, unknown>,
    hang: false,
    dead: false,
  };
  const answer = (request: NativeRequest): NativeResponse => {
    requests.push(request);
    if (request.method === 'init') {
      if (crate.failInit)
        return { error: { code: 'StoreError', message: 'locked' } };
      crate.open = true;
      return { result: description };
    }
    if (request.method === 'pollEvents')
      return { result: { events: [], dropped: 0 } };
    if (!crate.open)
      return { error: { code: 'UnknownMachine', message: 'call init' } };
    if (crate.panicOn.delete(request.method)) {
      crate.open = false;
      return { error: { code: 'Panic', message: 'panic in the crypto call' } };
    }
    if (request.method === 'roomKeyRequestsEnabled') {
      return { result: request.params?.['enabled'] ?? true };
    }
    if (request.method in crate.answers)
      return { result: crate.answers[request.method] };
    return { result: null };
  };
  const run = (text: string): Promise<string> =>
    crate.dead
      ? Promise.reject(new Error('process died'))
      : crate.hang
        ? new Promise(() => undefined)
        : Promise.resolve(
            JSON.stringify(
              Array.isArray(JSON.parse(text))
                ? (JSON.parse(text) as NativeRequest[]).map(answer)
                : answer(JSON.parse(text) as NativeRequest),
            ),
          );
  return { crate, bridge: { call: run, callBatch: run } };
}

async function open(options: Partial<NativeCryptoOptions> = {}) {
  const { crate, bridge } = fakeCrate();
  const lost = vi.fn();
  const { uninstallForTests } = install({
    bridge,
    storeDirectory: '/stores',
    onMachineLost: lost,
    ...options,
  });
  try {
    const store = await real.StoreHandle.openWithKey('prefix', key);
    const machine = await real.OlmMachine.initFromStore(
      new real.UserId(description.userId),
      new real.DeviceId(description.deviceId),
      store,
    );
    store.free();
    return { machine, crate, lost };
  } finally {
    uninstallForTests();
  }
}

const sync = (machine: real.OlmMachine) =>
  machine.receiveSyncChanges(
    '[]',
    new real.DeviceLists(),
    new Map(),
    new Set(),
  );
const room = new real.RoomId('!r:example.org');
const pending = Symbol('pending');
/** What `promise` settled to within a few macrotasks, or `pending`. */
const settled = (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ),
    new Promise((done) => setTimeout(() => done(pending), 50)),
  ]);
const inits = (requests: NativeRequest[]) =>
  requests.filter(({ method }) => method === 'init');

beforeAll(() => real.initAsync());

describe('a machine the crate dropped', () => {
  it('re-runs init with the same store and retries a call that is safe to replay', async () => {
    const { machine, crate, lost } = await open();
    crate.panicOn.add('receiveSyncChanges');
    expect(await sync(machine)).toEqual([]);
    expect(inits(crate.requests)).toHaveLength(2);
    expect(inits(crate.requests)[1].params).toEqual(
      inits(crate.requests)[0].params,
    );
    expect(
      crate.requests.filter(({ method }) => method === 'receiveSyncChanges'),
    ).toHaveLength(2);
    expect(lost).not.toHaveBeenCalled();
  });

  it('sets roomKeyRequestsEnabled again after the re-init', async () => {
    const { machine, crate } = await open();
    machine.roomKeyRequestsEnabled = false;
    crate.open = false;
    await sync(machine);
    const sets = crate.requests.filter(
      ({ method }) => method === 'roomKeyRequestsEnabled',
    );
    expect(sets.at(-1)?.params).toEqual({ enabled: false });
  });

  it('re-runs init but does not replay a call with effects', async () => {
    const { machine, crate, lost } = await open();
    crate.panicOn.add('encryptRoomEvent');
    await expect(
      machine.encryptRoomEvent(room, 'm.room.message', '{}'),
    ).rejects.toMatchObject({
      code: 'Panic',
    });
    expect(inits(crate.requests)).toHaveLength(2);
    expect(
      crate.requests.filter(({ method }) => method === 'encryptRoomEvent'),
    ).toHaveLength(1);
    crate.answers['encryptRoomEvent'] = '{"ciphertext":"x"}';
    expect(await machine.encryptRoomEvent(room, 'm.room.message', '{}')).toBe(
      '{"ciphertext":"x"}',
    );
    expect(lost).not.toHaveBeenCalled();
  });

  it('is lost when the re-init fails: sync input stays pending, other calls reject, the host hears once', async () => {
    const { machine, crate, lost } = await open();
    crate.failInit = true;
    crate.open = false;
    expect(await settled(sync(machine))).toBe(pending);
    expect(await settled(sync(machine))).toBe(pending);
    expect(
      await settled(
        machine.receiveSyncChangesMsc4186(
          '[]',
          new real.DeviceLists(),
          new Map(),
          new Set(),
        ),
      ),
    ).toBe(pending);
    const other = await settled(machine.outgoingRequests());
    expect(other).toMatchObject({ error: expect.any(NativeMachineLostError) });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(String(lost.mock.calls[0][0])).toMatch(/init/);
  });

  it('is lost when the bridge fails, and keeps the failed sync input pending', async () => {
    const { machine, crate, lost } = await open();
    crate.dead = true;
    expect(await settled(sync(machine))).toBe(pending);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(String(lost.mock.calls[0][0])).toMatch(/bridge failed/);
    await expect(machine.getRoomSettings(room)).rejects.toBeInstanceOf(
      NativeMachineLostError,
    );
    expect(() => machine.close()).not.toThrow();
  });

  it('hides the bridge failure reason of a batch that carries init', async () => {
    const { crate, bridge } = fakeCrate();
    crate.dead = true;
    const { uninstallForTests } = install({
      bridge,
      storeDirectory: '/stores',
    });
    try {
      const store = await real.StoreHandle.openWithKey('prefix', key);
      const error = await real.OlmMachine.initFromStore(
        new real.UserId(description.userId),
        new real.DeviceId(description.deviceId),
        store,
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NativeBridgeError);
      expect((error as Error).message).toBe(
        'native crypto init: the bridge failed',
      );
    } finally {
      uninstallForTests();
    }
  });

  it('is lost when a batch times out', async () => {
    const { machine, crate, lost } = await open({ timeoutMs: 20 });
    crate.hang = true;
    expect(await settled(sync(machine))).toBe(pending);
    await new Promise((done) => setTimeout(done, 60));
    expect(lost).toHaveBeenCalledTimes(1);
    expect(String(lost.mock.calls[0][0])).toMatch(/timed out/);
    await expect(machine.trackedUsers()).rejects.toBeInstanceOf(
      NativeMachineLostError,
    );
  });
});

describe('answers', () => {
  it('fails closed on an answer of the wrong shape', async () => {
    const { machine, crate } = await open();
    crate.answers['isBackupEnabled'] = null;
    await expect(machine.isBackupEnabled()).rejects.toBeInstanceOf(
      NativeCryptoError,
    );
    crate.answers['getMissingSessions'] = { type: 1, id: 'q', body: '{}' };
    await expect(machine.getMissingSessions([])).rejects.toThrow(
      /unexpected answer/,
    );
    crate.answers['getRoomSettings'] = { algorithm: 'megolm' };
    await expect(machine.getRoomSettings(room)).rejects.toThrow(
      /unexpected answer/,
    );
    crate.answers['getRoomEventEncryptionInfo'] = {
      sender: '@bob:example.org',
    };
    await expect(
      machine.getRoomEventEncryptionInfo('{}', room),
    ).rejects.toThrow(/unexpected answer/);
    crate.answers['getIdentity'] = { kind: 'nobody' };
    await expect(
      machine.getIdentity(new real.UserId('@bob:example.org')),
    ).rejects.toThrow(/unexpected answer/);
  });

  it('restores roomKeyRequestsEnabled when setting it fails', async () => {
    const logger = { warn: vi.fn() };
    const { machine, crate } = await open({ logger });
    crate.panicOn.add('roomKeyRequestsEnabled');
    crate.failInit = true;
    machine.roomKeyRequestsEnabled = false;
    await new Promise((done) => setTimeout(done, 20));
    expect(machine.roomKeyRequestsEnabled).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('disposes stand-ins and value objects like free', async () => {
    const { machine } = await open();
    const dispose = (Symbol as { dispose?: symbol }).dispose;
    if (!dispose) return;
    expect(() =>
      (machine as unknown as Record<symbol, () => void>)[dispose](),
    ).not.toThrow();
    const keys = machine.identityKeys as unknown as Record<symbol, () => void>;
    expect(() => keys[dispose]()).not.toThrow();
  });
});
