import * as real from '@matrix-org/matrix-sdk-crypto-wasm-real';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspect } from 'node:util';

import { NotOnNativeError } from './guard';
import { install } from './install';
import {
  NativeCryptoError,
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

const BOB = '@bob:example.org';
const device = (fields: Record<string, unknown> = {}) => ({
  userId: BOB,
  deviceId: 'BOB',
  displayName: "Bob's phone",
  keys: { 'ed25519:BOB': 'bob-ed25519', 'curve25519:BOB': 'bob-curve' },
  algorithms: [
    real.EncryptionAlgorithm.OlmV1Curve25519AesSha2,
    real.EncryptionAlgorithm.MegolmV1AesSha2,
  ],
  signatures: {
    [BOB]: {
      'ed25519:BOB': { isValid: true, signature: 'self-signature' },
      'ed25519:SSK': { isValid: false, invalidSignatureSource: 'bad' },
    },
  },
  isVerified: true,
  isCrossSigningTrusted: true,
  isCrossSignedByOwner: true,
  isLocallyTrusted: false,
  isBlacklisted: false,
  localTrustState: real.LocalTrust.Unset,
  isDeleted: false,
  isDehydrated: false,
  ...fields,
});
const masterKey = (key: string) =>
  JSON.stringify({
    user_id: BOB,
    usage: ['master'],
    keys: { [`ed25519:${key}`]: key },
  });
const other = {
  kind: 'other',
  isVerified: false,
  wasPreviouslyVerified: true,
  hasVerificationViolation: true,
  masterKey: masterKey('bob-master'),
  selfSigningKey: '{"keys":{}}',
  identityNeedsUserApproval: true,
};
const own = {
  kind: 'own',
  isVerified: true,
  wasPreviouslyVerified: true,
  hasVerificationViolation: false,
  masterKey: masterKey('alice-master'),
  selfSigningKey: '{"keys":{"ed25519:S":"S"}}',
  userSigningKey: '{"keys":{"ed25519:U":"U"}}',
};

type Answer = unknown | ((request: NativeRequest) => NativeResponse);

/**
 * A crate with one machine; `answers` maps a method to its result or to a function answering
 * the request. `panicOn` makes the next call of a method panic, as the crate drops a machine.
 */
function fakeCrate(answers: Record<string, Answer>) {
  const requests: NativeRequest[] = [];
  const panicOn = new Set<string>();
  let open = false;
  const answer = (request: NativeRequest): NativeResponse => {
    requests.push(request);
    if (request.method === 'init') {
      open = true;
      return { result: description };
    }
    if (request.method === 'roomKeyRequestsEnabled') return { result: true };
    if (request.method === 'pollEvents')
      return { result: { events: [], dropped: 0 } };
    if (!open) return { error: { code: 'UnknownMachine', message: 'init' } };
    if (panicOn.delete(request.method)) {
      open = false;
      return { error: { code: 'Panic', message: 'panic' } };
    }
    const found = answers[request.method];
    if (typeof found === 'function')
      return (found as (request: NativeRequest) => NativeResponse)(request);
    if (request.method in answers) return { result: found };
    return { error: { code: 'UnknownMethod', message: request.method } };
  };
  const run = async (text: string): Promise<string> => {
    const parsed = JSON.parse(text) as NativeRequest | NativeRequest[];
    return JSON.stringify(
      Array.isArray(parsed) ? parsed.map(answer) : answer(parsed),
    );
  };
  return { requests, panicOn, bridge: { call: run, callBatch: run } };
}

async function machine(answers: Record<string, Answer> = {}) {
  const crate = fakeCrate(answers);
  const { uninstallForTests } = install({
    bridge: crate.bridge,
    storeDirectory: '/stores',
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
    uninstallForTests();
  }
}

const sent = (crate: { requests: NativeRequest[] }, method: string) =>
  crate.requests.filter((request: NativeRequest) => request.method === method);
const refuse = (code: string) => (): NativeResponse => ({
  error: {
    code,
    message: 'the device changed since the host read it; read it again',
  },
});
const bob = () => new real.UserId(BOB);
const bobDevice = () => new real.DeviceId('BOB');

describe('devices on the native shim', () => {
  it('answers every read of matrix-js-sdk from the snapshot, on the real prototype', async () => {
    const { olm, crate } = await machine({ getDevice: device() });
    const found = (await olm.getDevice(bob(), bobDevice(), 5))!;
    expect(sent(crate, 'getDevice')[0]?.params).toEqual({
      userId: BOB,
      deviceId: 'BOB',
      timeoutSecs: 5,
    });
    expect(found).toBeInstanceOf(real.Device);
    expect(
      (found as unknown as { __wbg_ptr?: number }).__wbg_ptr,
    ).toBeUndefined();
    // The synchronous reads of matrix-js-sdk's rustDeviceToJsDevice, as it makes them.
    expect(found.deviceId.toString()).toBe('BOB');
    expect(found.displayName).toBe("Bob's phone");
    expect(
      Object.fromEntries(
        [...found.keys.entries()].map(([id, key]) => [
          id.toString(),
          key.toBase64(),
        ]),
      ),
    ).toEqual(device().keys);
    expect(found.algorithms).toEqual(device().algorithms);
    expect([found.isBlacklisted(), found.isVerified()]).toEqual([false, true]);
    const signatures = [...found.signatures.get(bob())!.entries()].map(
      ([id, signature]) => [
        id,
        signature.isValid(),
        signature.signature?.toBase64(),
      ],
    );
    expect(signatures).toEqual([
      ['ed25519:BOB', true, 'self-signature'],
      ['ed25519:SSK', false, undefined],
    ]);
    expect(
      found.signatures.get(new real.UserId('@carol:example.org')),
    ).toBeUndefined();
    expect(found.isDehydrated).toBe(false);
    expect([
      found.isCrossSignedByOwner(),
      found.isCrossSigningTrusted(),
      found.isLocallyTrusted(),
      found.isBlacklisted(),
      found.isDeleted(),
    ]).toEqual([true, true, false, false, false]);
    expect(found.userId.toString()).toBe(BOB);
    expect(found.localTrustState).toBe(real.LocalTrust.Unset);
    // Members matrix-js-sdk does not read still throw.
    expect(() => found.firstTimeSeen()).toThrow(NotOnNativeError);
    expect(() => found.curve25519Key).toThrow(NotOnNativeError);
    found.free();
  });

  it('answers a blacklisted device from its snapshot, an unknown one as undefined', async () => {
    const { olm } = await machine({
      getDevice: (request: NativeRequest) => ({
        result:
          request.params?.['deviceId'] === 'BOB'
            ? device({ isBlacklisted: true, isVerified: true })
            : null,
      }),
    });
    const found = (await olm.getDevice(bob(), bobDevice()))!;
    expect([found.isBlacklisted(), found.isVerified()]).toEqual([true, true]);
    expect(
      await olm.getDevice(bob(), new real.DeviceId('GONE')),
    ).toBeUndefined();
  });

  it("passes the snapshot's ed25519 key on every device call", async () => {
    const { olm, crate } = await machine({
      getDevice: device(),
      setLocalTrust: null,
      verifyDevice: { type: real.RequestType.SignatureUpload, body: '{}' },
      encryptToDeviceEvent: '{"ciphertext":"x"}',
    });
    const found = (await olm.getDevice(bob(), bobDevice()))!;
    const target = { userId: BOB, deviceId: 'BOB', ed25519Key: 'bob-ed25519' };
    expect(await found.setLocalTrust(real.LocalTrust.Verified)).toBeNull();
    expect(sent(crate, 'setLocalTrust')[0]?.params).toEqual({
      ...target,
      localState: real.LocalTrust.Verified,
    });
    expect(await found.verify()).toBeInstanceOf(real.SignatureUploadRequest);
    expect(sent(crate, 'verifyDevice')[0]?.params).toEqual(target);
    expect(
      await found.encryptToDeviceEvent(
        'm.test',
        { body: 1 },
        real.CollectStrategy.identityBasedStrategy(),
      ),
    ).toBe('{"ciphertext":"x"}');
    expect(sent(crate, 'encryptToDeviceEvent')[0]?.params).toEqual({
      ...target,
      eventType: 'm.test',
      content: { body: 1 },
      shareStrategy: 'identityBasedStrategy',
    });
  });

  it('refuses a device call without the ed25519 key, before anything is sent', async () => {
    const { olm, crate } = await machine({
      getDevice: device({ keys: { 'curve25519:BOB': 'bob-curve' } }),
      setLocalTrust: null,
    });
    const found = (await olm.getDevice(bob(), bobDevice()))!;
    await expect(
      found.setLocalTrust(real.LocalTrust.Verified),
    ).rejects.toMatchObject({
      code: 'UnexpectedAnswer',
    });
    await expect(found.verify()).rejects.toThrow(NativeCryptoError);
    await expect(found.encryptToDeviceEvent('m.test', {})).rejects.toThrow(
      NativeCryptoError,
    );
    expect(sent(crate, 'setLocalTrust')).toEqual([]);
    expect(sent(crate, 'verifyDevice')).toEqual([]);
    expect(sent(crate, 'encryptToDeviceEvent')).toEqual([]);
  });

  it.each(['StaleObject', 'UnknownDevice'])(
    'rejects a device call the crate answers %s, as a failure naming no key',
    async (code) => {
      const { olm } = await machine({
        getDevice: device(),
        setLocalTrust: refuse(code),
        verifyDevice: refuse(code),
        encryptToDeviceEvent: refuse(code),
      });
      const found = (await olm.getDevice(bob(), bobDevice()))!;
      for (const call of [
        () => found.setLocalTrust(real.LocalTrust.Verified),
        () => found.verify(),
        () => found.encryptToDeviceEvent('m.test', {}),
      ]) {
        const error = await call().then(
          () => undefined,
          (failure: unknown) => failure,
        );
        expect(error).toBeInstanceOf(NativeCryptoError);
        expect(error).toMatchObject({ code });
        expect((error as Error).message).not.toContain('bob-ed25519');
      }
    },
  );

  it('fails closed on a snapshot without its trust answers', async () => {
    const { olm } = await machine({
      getDevice: { ...device(), isVerified: undefined },
      getUserDevices: [device(), { ...device(), isBlacklisted: 'no' }],
    });
    await expect(olm.getDevice(bob(), bobDevice())).rejects.toMatchObject({
      code: 'UnexpectedAnswer',
    });
    await expect(olm.getUserDevices(bob())).rejects.toMatchObject({
      code: 'UnexpectedAnswer',
    });
  });

  it('builds UserDevices from the device snapshots', async () => {
    const { olm, crate } = await machine({
      getUserDevices: [device(), device({ deviceId: 'TWO', keys: {} })],
    });
    const devices = await olm.getUserDevices(bob(), 1);
    expect(sent(crate, 'getUserDevices')[0]?.params).toEqual({
      userId: BOB,
      timeoutSecs: 1,
    });
    expect(devices).toBeInstanceOf(real.UserDevices);
    const list = devices.devices();
    expect(list.map((item) => item.deviceId.toString())).toEqual([
      'BOB',
      'TWO',
    ]);
    expect(list.every((item) => item instanceof real.Device)).toBe(true);
    expect(() => devices.isAnyVerified()).toThrow(NotOnNativeError);
    devices.free();
  });
});

describe('identities on the native shim', () => {
  it('builds each kind on its real prototype, from the snapshot', async () => {
    const { olm } = await machine({
      getIdentity: (request: NativeRequest) => ({
        result: request.params?.['userId'] === BOB ? other : own,
      }),
    });
    const theirs = await olm.getIdentity(bob());
    const mine = await olm.getIdentity(new real.UserId(description.userId));
    expect(theirs).toBeInstanceOf(real.OtherUserIdentity);
    expect(theirs).not.toBeInstanceOf(real.OwnUserIdentity);
    expect(mine).toBeInstanceOf(real.OwnUserIdentity);
    // matrix-js-sdk shows the user-signing key only for the own identity, tested with `in`.
    expect('userSigningKey' in theirs!).toBe(false);
    expect('userSigningKey' in mine!).toBe(true);
    const other_ = theirs as real.OtherUserIdentity;
    expect([
      other_.isVerified(),
      other_.wasPreviouslyVerified(),
      other_.hasVerificationViolation(),
      other_.identityNeedsUserApproval(),
    ]).toEqual([false, true, true, true]);
    expect(JSON.parse(other_.masterKey).keys).toEqual({
      'ed25519:bob-master': 'bob-master',
    });
    const own_ = mine as real.OwnUserIdentity;
    expect([own_.isVerified(), own_.wasPreviouslyVerified()]).toEqual([
      true,
      true,
    ]);
    expect(own_.userSigningKey).toBe(own.userSigningKey);
    expect(own_.selfSigningKey).toBe(own.selfSigningKey);
    expect(() => own_.trustsOurOwnDevice()).toThrow(NotOnNativeError);
  });

  it('answers no identity as undefined and fails closed on a wrong shape', async () => {
    const { olm } = await machine({
      getIdentity: (request: NativeRequest) => ({
        result:
          request.params?.['userId'] === BOB
            ? null
            : { ...own, userSigningKey: undefined },
      }),
    });
    expect(await olm.getIdentity(bob())).toBeUndefined();
    await expect(
      olm.getIdentity(new real.UserId(description.userId)),
    ).rejects.toMatchObject({ code: 'UnexpectedAnswer' });
  });

  it("passes the snapshot's master key on every identity call", async () => {
    const { olm, crate } = await machine({
      getIdentity: (request: NativeRequest) => ({
        result: request.params?.['userId'] === BOB ? other : own,
      }),
      verifyIdentity: { type: real.RequestType.SignatureUpload, body: '{}' },
      withdrawVerification: null,
      pinCurrentMasterKey: null,
    });
    const theirs = (await olm.getIdentity(bob())) as real.OtherUserIdentity;
    const mine = (await olm.getIdentity(
      new real.UserId(description.userId),
    )) as real.OwnUserIdentity;
    expect(await theirs.verify()).toBeInstanceOf(real.SignatureUploadRequest);
    await theirs.withdrawVerification();
    await theirs.pinCurrentMasterKey();
    await mine.verify();
    await mine.withdrawVerification();
    const theirTarget = { userId: BOB, masterKey: 'bob-master' };
    const ownTarget = { userId: description.userId, masterKey: 'alice-master' };
    expect(
      sent(crate, 'verifyIdentity').map(
        (request: NativeRequest) => request.params,
      ),
    ).toEqual([theirTarget, ownTarget]);
    expect(
      sent(crate, 'withdrawVerification').map(
        (request: NativeRequest) => request.params,
      ),
    ).toEqual([theirTarget, ownTarget]);
    expect(sent(crate, 'pinCurrentMasterKey')[0]?.params).toEqual(theirTarget);
  });

  it('rejects an identity call the crate answers StaleObject or UnknownIdentity', async () => {
    const { olm } = await machine({
      getIdentity: other,
      pinCurrentMasterKey: refuse('StaleObject'),
      withdrawVerification: refuse('UnknownIdentity'),
      verifyIdentity: refuse('StaleObject'),
    });
    const theirs = (await olm.getIdentity(bob())) as real.OtherUserIdentity;
    await expect(theirs.pinCurrentMasterKey()).rejects.toMatchObject({
      code: 'StaleObject',
    });
    await expect(theirs.withdrawVerification()).rejects.toMatchObject({
      code: 'UnknownIdentity',
    });
    await expect(theirs.verify()).rejects.toMatchObject({
      code: 'StaleObject',
    });
  });

  it('refuses an identity call when the snapshot holds no master key', async () => {
    const { olm, crate } = await machine({
      getIdentity: { ...other, masterKey: '{"keys":{}}' },
      pinCurrentMasterKey: null,
    });
    const theirs = (await olm.getIdentity(bob())) as real.OtherUserIdentity;
    await expect(theirs.pinCurrentMasterKey()).rejects.toMatchObject({
      code: 'UnexpectedAnswer',
    });
    expect(sent(crate, 'pinCurrentMasterKey')).toEqual([]);
  });
});

describe('backup and room keys on the native shim', () => {
  const backupKey = real.BackupDecryptionKey.createRandomKey();

  it('hands out the backup key as a real BackupDecryptionKey, a copy per read', async () => {
    const { olm } = await machine({
      getBackupKeys: {
        decryptionKeyBase64: backupKey.toBase64(),
        backupVersion: '3',
      },
    });
    const keys = await olm.getBackupKeys();
    expect(keys).toBeInstanceOf(real.BackupKeys);
    expect(keys.backupVersion).toBe('3');
    const first = keys.decryptionKey!;
    expect(first).toBeInstanceOf(real.BackupDecryptionKey);
    expect(first.toBase64()).toBe(backupKey.toBase64());
    expect(first.megolmV1PublicKey.publicKeyBase64).toBe(
      backupKey.megolmV1PublicKey.publicKeyBase64,
    );
    // matrix-js-sdk frees the decryptors it builds from one read.
    first.free();
    expect(keys.decryptionKey!.toBase64()).toBe(backupKey.toBase64());
    expect(() => keys.decryptionKeyBase64).toThrow(NotOnNativeError);
    keys.free();
    expect(keys.decryptionKey).toBeUndefined();
  });

  it('answers no backup key as undefined', async () => {
    const { olm } = await machine({ getBackupKeys: {} });
    const keys = await olm.getBackupKeys();
    expect(keys.decryptionKey).toBeUndefined();
    expect(keys.backupVersion).toBeUndefined();
  });

  it('saves the key as base64, and a refused key fails as WASM fails: an Error, code only', async () => {
    const { olm, crate } = await machine({
      saveBackupDecryptionKey: (request: NativeRequest) =>
        request.params?.['version'] === 'bad'
          ? {
              error: {
                code: 'CryptoError',
                message: 'invalid backup decryption key',
              },
            }
          : { result: null },
    });
    await olm.saveBackupDecryptionKey(backupKey, '3');
    expect(sent(crate, 'saveBackupDecryptionKey')[0]?.params).toEqual({
      decryptionKeyBase64: backupKey.toBase64(),
      version: '3',
    });
    const error = await olm.saveBackupDecryptionKey(backupKey, 'bad').then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'CryptoError' });
    // A call that carries the key gets its code only: no crate text at all.
    expect((error as Error).message).toContain('withheld');
    expect((error as Error).message).not.toContain(backupKey.toBase64());
  });

  it("replays the crate's last progress to the listener once, when the import is done", async () => {
    const result = {
      importedCount: 2,
      totalCount: 2,
      keys: { '!room:example.org': { senderKey: ['s1', 's2'] } },
    };
    const { olm, crate } = await machine({
      importExportedRoomKeys: { ...result, lastProgress: [1, 2] },
      importBackedUpRoomKeys: {
        ...result,
        lastProgress: [1, 3, 1],
        failures: 1,
      },
    });
    const exported = vi.fn();
    const imported = await olm.importExportedRoomKeys('[]', exported);
    expect(exported.mock.calls).toEqual([[1, 2]]);
    expect(imported).toBeInstanceOf(real.RoomKeyImportResult);
    expect(imported.importedCount).toBe(2);
    expect(imported.totalCount).toBe(2);
    expect(imported.keys()).toEqual(
      new Map([
        ['!room:example.org', new Map([['senderKey', new Set(['s1', 's2'])]])],
      ]),
    );

    const backedUp = vi.fn();
    // A room given twice, as matrix-js-sdk keys its map by a new RoomId per session.
    await olm.importBackedUpRoomKeys(
      new Map([
        [new real.RoomId('!room:example.org'), new Map([['s1', { a: 1 }]])],
        [new real.RoomId('!room:example.org'), new Map([['s2', { a: 2 }]])],
      ]),
      backedUp,
      '3',
    );
    expect(backedUp.mock.calls).toEqual([[1, 3, 1]]);
    expect(sent(crate, 'importBackedUpRoomKeys')[0]?.params).toEqual({
      backedUpRoomKeys: { '!room:example.org': { s1: { a: 1 }, s2: { a: 2 } } },
      backupVersion: '3',
    });
  });

  it('does not call the listener when WASM would not', async () => {
    const { olm } = await machine({
      importExportedRoomKeys: {
        importedCount: 0,
        totalCount: 0,
        keys: {},
        lastProgress: null,
      },
    });
    const listener = vi.fn();
    await olm.importExportedRoomKeys('[]', listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it('answers the backup and signing value objects matrix-js-sdk reads', async () => {
    const { olm, crate } = await machine({
      exportRoomKeys: '[]',
      roomKeyCounts: { total: 5, backedUp: 3 },
      backupRoomKeys: {
        id: 'r1',
        type: real.RequestType.KeysBackup,
        version: '3',
        body: '{"rooms":{}}',
      },
      verifyBackup: { deviceState: 3, userState: 0, trusted: true },
      sign: { [description.userId]: { 'ed25519:ALICE': 'sig' } },
      enableBackupV1: null,
      disableBackup: null,
    });
    expect(await olm.exportRoomKeys(() => true)).toBe('[]');
    const counts = await olm.roomKeyCounts();
    expect([counts.total, counts.backedUp]).toEqual([5, 3]);
    const request = await olm.backupRoomKeys();
    expect(request).toBeInstanceOf(real.KeysBackupRequest);
    expect(request?.version).toBe('3');
    const verification = await olm.verifyBackup({ algorithm: 'x' });
    expect(verification).toBeInstanceOf(real.SignatureVerification);
    expect(verification.trusted()).toBe(true);
    expect(sent(crate, 'verifyBackup')[0]?.params).toEqual({
      backupInfo: { algorithm: 'x' },
    });
    expect(JSON.parse((await olm.sign('{}')).asJSON())).toEqual({
      [description.userId]: { 'ed25519:ALICE': 'sig' },
    });
    await olm.enableBackupV1('public', '3');
    expect(sent(crate, 'enableBackupV1')[0]?.params).toEqual({
      publicKeyBase64: 'public',
      version: '3',
    });
    await olm.disableBackup();
  });

  it('answers nothing to back up as undefined, and fails closed on a wrong trust shape', async () => {
    const { olm } = await machine({
      backupRoomKeys: null,
      verifyBackup: { deviceState: 3, userState: 0, trusted: 'yes' },
    });
    expect(await olm.backupRoomKeys()).toBeUndefined();
    await expect(olm.verifyBackup({})).rejects.toMatchObject({
      code: 'UnexpectedAnswer',
    });
  });
});

describe('cross-signing on the native shim', () => {
  it('answers status, export, import and bootstrap as the WASM classes', async () => {
    const status = {
      hasMaster: true,
      hasSelfSigning: true,
      hasUserSigning: false,
    };
    let exports = 0;
    const { olm, crate } = await machine({
      crossSigningStatus: status,
      importCrossSigningKeys: status,
      exportCrossSigningKeys: () => ({
        result:
          ++exports > 1
            ? null
            : { masterKey: 'm', self_signing_key: 's', userSigningKey: 'u' },
      }),
      bootstrapCrossSigning: {
        uploadSigningKeysRequest: { body: '{"master_key":{}}' },
        uploadSignaturesRequest: {
          type: real.RequestType.SignatureUpload,
          body: '{}',
        },
      },
    });
    const answered = await olm.crossSigningStatus();
    expect(answered).toBeInstanceOf(real.CrossSigningStatus);
    expect([
      answered.hasMaster,
      answered.hasSelfSigning,
      answered.hasUserSigning,
    ]).toEqual([true, true, false]);
    const exported = (await olm.exportCrossSigningKeys())!;
    expect(exported).toBeInstanceOf(real.CrossSigningKeyExport);
    expect([
      exported.masterKey,
      exported.self_signing_key,
      exported.userSigningKey,
    ]).toEqual(['m', 's', 'u']);
    expect(await olm.exportCrossSigningKeys()).toBeUndefined();
    expect(
      (await olm.importCrossSigningKeys('m', 's', undefined)).hasMaster,
    ).toBe(true);
    expect(sent(crate, 'importCrossSigningKeys')[0]?.params).toEqual({
      masterKey: 'm',
      selfSigningKey: 's',
    });
    const requests = await olm.bootstrapCrossSigning(true);
    expect(sent(crate, 'bootstrapCrossSigning')[0]?.params).toEqual({
      reset: true,
    });
    expect(requests).toBeInstanceOf(real.CrossSigningBootstrapRequests);
    expect(requests.uploadKeysRequest).toBeUndefined();
    expect(requests.uploadSigningKeysRequest).toBeInstanceOf(
      real.UploadSigningKeysRequest,
    );
    expect(requests.uploadSigningKeysRequest.body).toBe('{"master_key":{}}');
    expect(requests.uploadSignaturesRequest).toBeInstanceOf(
      real.SignatureUploadRequest,
    );
  });
});

describe('reloading a dropped machine for the trust calls', () => {
  it('replays the idempotent trust calls once on the reloaded machine', async () => {
    const { olm, crate } = await machine({
      getDevice: device(),
      setLocalTrust: null,
    });
    const found = (await olm.getDevice(bob(), bobDevice()))!;
    crate.panicOn.add('setLocalTrust');
    await found.setLocalTrust(real.LocalTrust.Verified);
    expect(sent(crate, 'setLocalTrust')).toHaveLength(2);
    expect(sent(crate, 'init')).toHaveLength(2);
  });

  it('replays a secret push: the drop discarded the queue it filled', async () => {
    const { olm, crate } = await machine({ pushSecretToVerifiedDevices: null });
    crate.panicOn.add('pushSecretToVerifiedDevices');
    await olm.pushSecretToVerifiedDevices('m.megolm_backup.v1');
    expect(sent(crate, 'pushSecretToVerifiedDevices')).toHaveLength(2);
  });

  it.each([
    [
      'encryptToDeviceEvent',
      (olm: real.OlmMachine, found: real.Device) =>
        found.encryptToDeviceEvent('m.test', {}),
    ],
    [
      'bootstrapCrossSigning',
      (olm: real.OlmMachine) => olm.bootstrapCrossSigning(true),
    ],
  ] as const)(
    'does not replay %s: it fails, after the reload',
    async (method, call) => {
      const { olm, crate } = await machine({
        getDevice: device(),
        encryptToDeviceEvent: '{}',
        bootstrapCrossSigning: {},
        pushSecretToVerifiedDevices: null,
      });
      const found = (await olm.getDevice(bob(), bobDevice()))!;
      crate.panicOn.add(method);
      await expect(call(olm, found)).rejects.toMatchObject({ code: 'Panic' });
      expect(sent(crate, method)).toHaveLength(1);
      expect(sent(crate, 'init')).toHaveLength(2);
    },
  );
});

describe('a stand-in after its own change', () => {
  /** A crate whose device or identity answers change once the mutating call ran. */
  const changing = (before: unknown, after: unknown, mutation: string) => {
    let changed = false;
    return {
      read: () => ({ result: changed ? after : before }),
      mutate: () => {
        changed = true;
        return {
          result: mutation === 'verifyIdentity' ? signatureUpload : null,
        };
      },
    };
  };
  const signatureUpload = {
    type: real.RequestType.SignatureUpload,
    body: '{}',
  };

  it('answers the new local trust once setLocalTrust resolves, as WASM shows it', async () => {
    const state = changing(
      device(),
      device({
        isBlacklisted: true,
        isVerified: false,
        localTrustState: real.LocalTrust.BlackListed,
      }),
      'setLocalTrust',
    );
    const { olm, crate } = await machine({
      getDevice: state.read,
      setLocalTrust: state.mutate,
    });
    const found = (await olm.getDevice(bob(), bobDevice(), 5))!;
    expect(found.isVerified()).toBe(true);
    await found.setLocalTrust(real.LocalTrust.BlackListed);
    expect([
      found.isBlacklisted(),
      found.isVerified(),
      found.localTrustState,
    ]).toEqual([true, false, real.LocalTrust.BlackListed]);
    expect(sent(crate, 'getDevice').at(-1)?.params).toEqual({
      userId: BOB,
      deviceId: 'BOB',
    });
  });

  it.each([
    ['gone', () => ({ result: null })],
    [
      'another key under its ID',
      () => ({ result: device({ keys: { 'ed25519:BOB': 'new-key' } }) }),
    ],
    [
      'unreadable',
      () => ({ error: { code: 'StoreError', message: 'locked' } }),
    ],
  ] as const)(
    'is spent when the device is %s by then: reads throw',
    async (_case, after) => {
      let reads = 0;
      const { olm } = await machine({
        getDevice: () => (++reads === 1 ? { result: device() } : after()),
        setLocalTrust: null,
      });
      const found = (await olm.getDevice(bob(), bobDevice()))!;
      await found.setLocalTrust(real.LocalTrust.Verified);
      expect(() => found.isVerified()).toThrow(NativeCryptoError);
      expect(() => found.isBlacklisted()).toThrow(/changed or is gone/);
      expect(() => found.keys).toThrow(NativeCryptoError);
      await expect(
        found.setLocalTrust(real.LocalTrust.Unset),
      ).rejects.toMatchObject({
        code: 'StaleObject',
      });
    },
  );

  it('keeps its answers after Device.verify, which only signs', async () => {
    const { olm, crate } = await machine({
      getDevice: device({ isCrossSigningTrusted: false }),
      verifyDevice: signatureUpload,
    });
    const found = (await olm.getDevice(bob(), bobDevice()))!;
    await found.verify();
    expect(found.isCrossSigningTrusted()).toBe(false);
    expect(sent(crate, 'getDevice')).toHaveLength(1);
  });

  it.each([
    ['pinCurrentMasterKey', 'identityNeedsUserApproval', false],
    ['withdrawVerification', 'wasPreviouslyVerified', false],
  ] as const)(
    'answers OtherUserIdentity.%s at once on the same object (%s)',
    async (method, read, expected) => {
      const state = changing(
        other,
        {
          ...other,
          identityNeedsUserApproval: false,
          wasPreviouslyVerified: false,
        },
        method,
      );
      const { olm } = await machine({
        getIdentity: state.read,
        [method]: state.mutate,
      });
      const theirs = (await olm.getIdentity(bob())) as real.OtherUserIdentity;
      expect(theirs[read]()).toBe(true);
      await theirs[method]();
      expect(theirs[read]()).toBe(expected);
    },
  );

  it.each([
    ['verify', 'verifyIdentity', 'isVerified', { isVerified: true }, true],
    [
      'withdrawVerification',
      'withdrawVerification',
      'wasPreviouslyVerified',
      { wasPreviouslyVerified: false },
      false,
    ],
  ] as const)(
    'answers OwnUserIdentity.%s at once on the same object',
    async (member, method, read, after, expected) => {
      const before = { ...own, isVerified: false };
      const state = changing(before, { ...before, ...after }, method);
      const { olm } = await machine({
        getIdentity: state.read,
        [method]: state.mutate,
      });
      const mine = (await olm.getIdentity(
        new real.UserId(description.userId),
      )) as real.OwnUserIdentity;
      await mine[member]();
      expect(mine[read]()).toBe(expected);
    },
  );

  it.each([
    [
      'OwnUserIdentity.verify',
      'verifyIdentity',
      { isVerified: true },
      (mine: real.OwnUserIdentity) => mine.verify(),
      (mine: real.OwnUserIdentity) => mine.isVerified(),
      true,
    ],
    [
      'OwnUserIdentity.withdrawVerification',
      'withdrawVerification',
      { wasPreviouslyVerified: false },
      (mine: real.OwnUserIdentity) => mine.withdrawVerification(),
      (mine: real.OwnUserIdentity) => mine.wasPreviouslyVerified(),
      false,
    ],
  ] as const)(
    'reads %s again when it fails after the change upstream made first',
    async (_name, method, after, act, read, expected) => {
      const before = { ...own, isVerified: false };
      let failed = false;
      const { olm } = await machine({
        getIdentity: () => ({
          result: failed ? { ...before, ...after } : before,
        }),
        [method]: () => {
          failed = true;
          return { error: { code: 'CryptoError', message: 'signing failed' } };
        },
      });
      const mine = (await olm.getIdentity(
        new real.UserId(description.userId),
      )) as real.OwnUserIdentity;
      await expect(act(mine)).rejects.toMatchObject({ code: 'CryptoError' });
      expect(read(mine)).toBe(expected);
    },
  );

  it('reads the device again when setLocalTrust fails after the change', async () => {
    let failed = false;
    const { olm } = await machine({
      getDevice: () => ({
        result: failed
          ? device({
              isBlacklisted: true,
              localTrustState: real.LocalTrust.BlackListed,
            })
          : device(),
      }),
      setLocalTrust: () => {
        failed = true;
        return { error: { code: 'StoreError', message: 'save failed' } };
      },
    });
    const found = (await olm.getDevice(bob(), bobDevice()))!;
    await expect(
      found.setLocalTrust(real.LocalTrust.BlackListed),
    ).rejects.toMatchObject({
      code: 'StoreError',
    });
    expect(found.isBlacklisted()).toBe(true);
  });

  it('keeps its answers after OtherUserIdentity.verify, which only signs', async () => {
    const { olm, crate } = await machine({
      getIdentity: other,
      verifyIdentity: signatureUpload,
    });
    const theirs = (await olm.getIdentity(bob())) as real.OtherUserIdentity;
    await theirs.verify();
    expect(theirs.isVerified()).toBe(false);
    expect(sent(crate, 'getIdentity')).toHaveLength(1);
  });

  it.each([
    ['reset', { ...other, masterKey: masterKey('new-master') }],
    ['gone', null],
    ['now of the other kind', own],
  ] as const)(
    'is spent when the identity is %s by then',
    async (_case, after) => {
      let reads = 0;
      const { olm } = await machine({
        getIdentity: () => ({ result: ++reads === 1 ? other : after }),
        pinCurrentMasterKey: null,
      });
      const theirs = (await olm.getIdentity(bob())) as real.OtherUserIdentity;
      await theirs.pinCurrentMasterKey();
      expect(() => theirs.identityNeedsUserApproval()).toThrow(
        /changed or is gone/,
      );
      expect(() => theirs.masterKey).toThrow(NativeCryptoError);
    },
  );
});

describe('secrets in stand-ins', () => {
  it('keeps the private cross-signing keys out of enumeration, JSON and inspection', async () => {
    const { olm } = await machine({
      exportCrossSigningKeys: {
        masterKey: 'master-seed',
        self_signing_key: 'self-seed',
        userSigningKey: 'user-seed',
      },
    });
    const exported = (await olm.exportCrossSigningKeys())!;
    expect([
      exported.masterKey,
      exported.self_signing_key,
      exported.userSigningKey,
    ]).toEqual(['master-seed', 'self-seed', 'user-seed']);
    for (const shown of [
      JSON.stringify(exported),
      inspect(exported),
      Object.keys(exported).join(),
    ]) {
      expect(shown).not.toMatch(/seed/);
    }
  });

  it('keeps the backup key out of enumeration, JSON and inspection', async () => {
    const key = real.BackupDecryptionKey.createRandomKey();
    const { olm } = await machine({
      getBackupKeys: {
        decryptionKeyBase64: key.toBase64(),
        backupVersion: '1',
      },
    });
    const keys = await olm.getBackupKeys();
    for (const shown of [
      JSON.stringify(keys),
      inspect(keys),
      Object.keys(keys).join(),
    ]) {
      expect(shown).not.toContain(key.toBase64());
    }
  });
});

describe('shapes that fail closed', () => {
  it('getSecretsFromInbox refuses an answer that is not a list of strings', async () => {
    for (const answer of ['abc', [1], null]) {
      const { olm } = await machine({ getSecretsFromInbox: answer });
      await expect(
        olm.getSecretsFromInbox('m.megolm_backup.v1'),
      ).rejects.toMatchObject({
        code: 'UnexpectedAnswer',
      });
    }
    const { olm } = await machine({ getSecretsFromInbox: ['a', 'b'] });
    expect(await olm.getSecretsFromInbox('m.megolm_backup.v1')).toEqual(
      new Set(['a', 'b']),
    );
  });

  it.each([-1, 4, 1.5])(
    'getDevice refuses a local trust state of %s',
    async (state) => {
      const { olm } = await machine({
        getDevice: device({ localTrustState: state }),
      });
      await expect(olm.getDevice(bob(), bobDevice())).rejects.toMatchObject({
        code: 'UnexpectedAnswer',
      });
    },
  );

  const signatures = { type: real.RequestType.SignatureUpload, body: '{}' };
  it.each([
    [
      'a signing keys body that is not a string',
      {
        uploadSigningKeysRequest: { body: {} },
        uploadSignaturesRequest: signatures,
      },
    ],
    [
      'a keys upload of another type',
      {
        uploadKeysRequest: {
          id: '1',
          type: real.RequestType.KeysQuery,
          body: '{}',
        },
        uploadSigningKeysRequest: { body: '{}' },
        uploadSignaturesRequest: signatures,
      },
    ],
    [
      'a signature upload of another type',
      {
        uploadSigningKeysRequest: { body: '{}' },
        uploadSignaturesRequest: {
          ...signatures,
          type: real.RequestType.KeysQuery,
        },
      },
    ],
  ])('bootstrapCrossSigning refuses %s', async (_case, answer) => {
    const { olm } = await machine({ bootstrapCrossSigning: answer });
    await expect(olm.bootstrapCrossSigning(true)).rejects.toMatchObject({
      code: 'UnexpectedAnswer',
    });
  });

  it.each([
    ['a key that is not a string', { masterKey: 1 }],
    ['an unknown field', { masterKey: 'm', other: 'x' }],
  ])('exportCrossSigningKeys refuses %s', async (_case, answer) => {
    const { olm } = await machine({ exportCrossSigningKeys: answer });
    await expect(olm.exportCrossSigningKeys()).rejects.toMatchObject({
      code: 'UnexpectedAnswer',
    });
  });

  it.each([
    [
      'an algorithm that is not a number',
      device({ algorithms: ['m.megolm.v1.aes-sha2'] }),
    ],
    [
      'a signature whose isValid is a string',
      device({
        signatures: {
          [BOB]: { 'ed25519:BOB': { isValid: 'false', signature: 's' } },
        },
      }),
    ],
    [
      'a valid signature without its value',
      device({ signatures: { [BOB]: { 'ed25519:BOB': { isValid: true } } } }),
    ],
  ])('getDevice refuses %s', async (_case, answer) => {
    const { olm } = await machine({ getDevice: answer });
    await expect(olm.getDevice(bob(), bobDevice())).rejects.toMatchObject({
      code: 'UnexpectedAnswer',
    });
  });

  it('refuses a device or identity signature upload of another shape', async () => {
    const { olm } = await machine({
      getDevice: device(),
      getIdentity: other,
      verifyDevice: { type: real.RequestType.KeysQuery, body: '{}' },
      verifyIdentity: { type: real.RequestType.SignatureUpload },
    });
    await expect(
      (await olm.getDevice(bob(), bobDevice()))!.verify(),
    ).rejects.toMatchObject({ code: 'UnexpectedAnswer' });
    await expect(
      ((await olm.getIdentity(bob())) as real.OtherUserIdentity).verify(),
    ).rejects.toMatchObject({ code: 'UnexpectedAnswer' });
  });
});

interface ManifestEntry {
  readonly native?: string;
  readonly note?: string;
  readonly shimImpl?: boolean;
}

/**
 * Every device and identity method whose manifest note says the shim must pass the snapshot's
 * key: implemented ones must send it, the others must still throw without sending anything.
 * A member added to the manifest is covered without touching this list.
 */
describe('the expected key on every device and identity call (from the manifest)', () => {
  const manifest = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../../../../../native/crypto/surface.json'),
      'utf8',
    ),
  ) as { stateful: Record<string, Record<string, ManifestEntry>> };
  const guarded = Object.entries(manifest.stateful).flatMap(
    ([owner, members]) =>
      Object.entries(members).flatMap(([member, entry]) => {
        const key =
          /the shim must pass (ed25519Key|masterKey) from the snapshot/.exec(
            entry.note ?? '',
          )?.[1];
        return key ? [[owner, member, key, entry] as const] : [];
      }),
  );
  /** Arguments a member needs before it can send its request. */
  const ARGS: Record<string, unknown[]> = {
    'Device.setLocalTrust': [real.LocalTrust.Verified],
    'Device.encryptToDeviceEvent': ['m.test', {}],
    'OtherUserIdentity.requestVerification': [
      new real.RoomId('!dm:example.org'),
      new real.EventId('$request'),
    ],
  };
  const EXPECTED = {
    ed25519Key: 'bob-ed25519',
    masterKey: 'bob-master',
  } as const;

  it('finds the guarded members of each class', () => {
    expect(new Set(guarded.map(([owner]) => owner))).toEqual(
      new Set(['Device', 'OwnUserIdentity', 'OtherUserIdentity']),
    );
  });

  it('reads every call of a device or identity as guarded, so a reworded note cannot skip one', () => {
    const calls = Object.entries(manifest.stateful)
      .filter(([owner]) =>
        ['Device', 'OwnUserIdentity', 'OtherUserIdentity'].includes(owner),
      )
      .flatMap(([owner, members]) =>
        Object.entries(members)
          .filter(([, entry]) => (entry.note ?? '').startsWith('call:'))
          .map(([member]) => `${owner}.${member}`),
      );
    expect(calls.sort()).toEqual(
      guarded.map(([owner, member]) => `${owner}.${member}`).sort(),
    );
    expect(guarded).toHaveLength(11);
  });

  it.each(guarded)('%s.%s passes %s', async (owner, member, key, entry) => {
    const answers: Record<string, Answer> = {
      getDevice: device(),
      getIdentity:
        owner === 'OwnUserIdentity'
          ? { ...own, masterKey: masterKey('bob-master') }
          : other,
      [entry.native!]: null,
    };
    const { olm, crate } = await machine(answers);
    const target =
      owner === 'Device'
        ? await olm.getDevice(bob(), bobDevice())
        : await olm.getIdentity(
            owner === 'OwnUserIdentity'
              ? new real.UserId(description.userId)
              : bob(),
          );
    const method = (
      target as unknown as Record<string, (...args: unknown[]) => unknown>
    )[member]!;
    const calls = () => sent(crate, entry.native!);
    if (!entry.shimImpl) {
      expect(() =>
        method.apply(target, ARGS[`${owner}.${member}`] ?? []),
      ).toThrow(NotOnNativeError);
      expect(calls()).toEqual([]);
      return;
    }
    await Promise.resolve(
      method.apply(target, ARGS[`${owner}.${member}`] ?? []),
    ).catch(() => undefined);
    expect(
      calls(),
      `${owner}.${member} sent no ${entry.native}`,
    ).not.toHaveLength(0);
    for (const request of calls())
      expect(request.params?.[key]).toBe(
        EXPECTED[key as keyof typeof EXPECTED],
      );
  });
});
