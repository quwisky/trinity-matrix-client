import * as real from '@matrix-org/matrix-sdk-crypto-wasm-real';

import { NotOnNativeError } from './guard';
import { install, SHIM_STATICS } from './install';
import type { NativeRequest, NativeResponse } from './types';

const description = {
  userId: '@alice:example.org',
  deviceId: 'ALICE',
  identityKeys: {
    ed25519: 'ed-key',
    curve25519: 'mB7Ywmbd9WlFtWhT/4ZbVlUFkNmz04hxkx1bt+QBJ0E',
  },
  deviceCreationTimeMs: 1234,
};

/** A crate that answers `init` and records every request. */
function fakeCrate(answers: Record<string, unknown> = {}) {
  const requests: NativeRequest[] = [];
  const answer = (request: NativeRequest): NativeResponse => {
    requests.push(request);
    if (request.method === 'init') return { result: description };
    if (request.method === 'roomKeyRequestsEnabled') return { result: true };
    if (request.method === 'pollEvents')
      return { result: { events: [], dropped: 0 } };
    if (request.method in answers) return { result: answers[request.method] };
    return { error: { code: 'UnknownMethod', message: request.method } };
  };
  const run = async (text: string): Promise<string> => {
    const parsed = JSON.parse(text) as NativeRequest | NativeRequest[];
    return JSON.stringify(
      Array.isArray(parsed) ? parsed.map(answer) : answer(parsed),
    );
  };
  return { requests, bridge: { call: run, callBatch: run } };
}

const statics = () =>
  Object.entries(SHIM_STATICS).flatMap(([name, members]) =>
    members.map((member) => {
      const owner = real[name as keyof typeof SHIM_STATICS] as object;
      return [
        owner,
        member,
        Object.getOwnPropertyDescriptor(owner, member),
      ] as const;
    }),
  );

const machine = async (
  options: Partial<Parameters<typeof install>[0]> = {},
  answers = {},
) => {
  const crate = fakeCrate(answers);
  const { uninstallForTests: uninstall } = install({
    bridge: crate.bridge,
    storeDirectory: '/stores',
    ...options,
  });
  try {
    const store = await real.StoreHandle.openWithKey(
      'prefix',
      new Uint8Array(32).fill(7),
    );
    const olm = await real.OlmMachine.initFromStore(
      new real.UserId(description.userId),
      new real.DeviceId(description.deviceId),
      store,
    );
    return { olm, crate };
  } finally {
    uninstall();
  }
};

beforeAll(() => real.initAsync());

describe('install', () => {
  it('patches the static factories and the uninstaller restores the originals', () => {
    const before = statics();
    const { uninstallForTests: uninstall } = install(fakeCrate());
    for (const [owner, member, descriptor] of before) {
      expect(Object.getOwnPropertyDescriptor(owner, member)?.value).not.toBe(
        descriptor?.value,
      );
    }
    expect(() => install(fakeCrate())).toThrow(/installed already/);
    uninstall();
    uninstall();
    expect(statics()).toEqual(before);
  });

  it('opens a keyed store as storePath and storeKey for init', async () => {
    const { crate } = await machine();
    expect(crate.requests[0]).toEqual({
      method: 'init',
      ...{ userId: description.userId, deviceId: description.deviceId },
      params: {
        storePath: '/stores/prefix',
        storeKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
      },
    });
  });

  it('refuses a named store without a key, a wrong key length and the libolm migration', async () => {
    const { uninstallForTests: uninstall } = install({
      ...fakeCrate(),
      storeDirectory: '/stores',
    });
    try {
      await expect(
        real.StoreHandle.open('prefix', 'passphrase'),
      ).rejects.toThrow(/openWithKey/);
      const shortKey = new Uint8Array(16).fill(9);
      await expect(
        real.StoreHandle.openWithKey('prefix', shortKey),
      ).rejects.toThrow('native crypto: the store key must be 32 bytes');
      await expect(
        real.Migration.migrateBaseData(
          new real.BaseMigrationData(),
          new Uint8Array(32),
          undefined as never,
        ),
      ).rejects.toThrow('legacy libolm migration is not supported on native');
      expect(await real.StoreHandle.open(null, null)).toBeInstanceOf(
        real.StoreHandle,
      );
    } finally {
      uninstall();
    }
  });

  it('builds a machine that passes instanceof, answers its constants and owns no wasm memory', async () => {
    const { olm } = await machine();
    expect(olm).toBeInstanceOf(real.OlmMachine);
    expect(
      (olm as unknown as { __wbg_ptr?: number }).__wbg_ptr,
    ).toBeUndefined();
    expect(olm.userId.toString()).toBe(description.userId);
    expect(olm.deviceId.toString()).toBe(description.deviceId);
    expect(olm.identityKeys.curve25519.toBase64()).toBe(
      description.identityKeys.curve25519,
    );
    expect(olm.identityKeys.ed25519.toBase64()).toBe('ed-key');
    expect(olm.deviceCreationTimeMs).toBe(1234);
    expect(olm.roomKeyRequestsEnabled).toBe(true);
    expect(() => olm.free()).not.toThrow();
  });

  it('throws for every member it does not implement, methods and getters alike', async () => {
    const { olm } = await machine();
    expect(() =>
      olm.getDevice(
        new real.UserId(description.userId),
        new real.DeviceId('B'),
      ),
    ).toThrow(NotOnNativeError);
    expect(() => olm.dehydratedDevices()).toThrow(
      'OlmMachine.dehydratedDevices is not implemented on native crypto',
    );
    expect(() =>
      (olm as unknown as { __destroy_into_raw(): number }).__destroy_into_raw(),
    ).toThrow(NotOnNativeError);
  });

  it('keeps working after the factories are restored', async () => {
    const { olm, crate } = await machine(
      {},
      { trackedUsers: ['@bob:example.org'] },
    );
    expect([...(await olm.trackedUsers())].map(String)).toEqual([
      '@bob:example.org',
    ]);
    expect(crate.requests.at(-2)?.method).toBe('trackedUsers');
  });

  it('puts no key material in its own errors', async () => {
    const key = new Uint8Array(31).fill(0xab);
    const { uninstallForTests: uninstall } = install({
      ...fakeCrate(),
      storeDirectory: '/stores',
    });
    try {
      const error = await real.StoreHandle.openWithKey('prefix', key).catch(
        (caught: Error) => caught,
      );
      expect(String(error)).not.toMatch(/ab|171|q6ur/i);
    } finally {
      uninstall();
    }
  });

  it('changes nothing when a target lacks a member, and can be installed afterwards', () => {
    const before = statics();
    const targets = {
      ...real,
      OlmMachine: Object.assign(function OlmMachine() {}, {
        initFromStore: () => undefined,
      }),
    };
    expect(() =>
      install(fakeCrate(), targets as unknown as typeof real),
    ).toThrow(/OlmMachine.initialize is not in the WASM package/);
    expect(statics()).toEqual(before);
    const { uninstallForTests } = install(fakeCrate());
    uninstallForTests();
    expect(statics()).toEqual(before);
  });
});
