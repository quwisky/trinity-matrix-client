/**
 * Devices, user identities, trust and cross-signing: each step runs on a native observer and a
 * WASM observer that see the same other users through one homeserver, and both must answer the
 * same, by value. Trust answers (verified, cross-signing trusted, locally trusted, blacklisted,
 * needs approval, violation) are always compared by value; fresh keys and signatures by shape,
 * as each case says. A wrong `true` here is a security bug, so cases also pin the expected
 * answer, not only the agreement.
 */
import * as wasm from '@matrix-org/matrix-sdk-crypto-wasm';
import {
  Homeserver,
  anonymise,
  both,
  compared,
  covered,
  hasCargo,
  shape,
  skipped,
  useDevices,
} from './native-crypto-harness.mjs';

const { LocalTrust, RequestType, SignatureState } = wasm;
const BACKUP_ALGORITHM = 'm.megolm_backup.v1.curve25519-aes-sha2';

const expectSame = ([native, wasmAnswer], step) =>
  expect(native, step).toEqual(wasmAnswer);

const result = (response) => {
  expect(response.error).toBeUndefined();
  return response.result;
};

/** Runs a compared step on each device and returns the raw answers, to send on afterwards. */
const each = (devices, run) =>
  compared(async () => {
    const answers = [];
    for (const it of devices) answers.push(await run(it));
    return answers;
  });

/** Base64 keys (fresh on each side) in JSON keys, such as `ed25519:<key>`. */
const freshKeys = (name) => name.replace(/[A-Za-z0-9+/]{43}/g, '<key>');

/** A request whose signatures and keys are fresh: its fields and its body's shape. */
const requestShape = (request, it) => {
  const { body, ...rest } = anonymise(request, it);
  return { ...shape(rest), body: shape(JSON.parse(body), freshKeys) };
};

/** Every field of a `Device` snapshot (native/crypto/README.md). */
const DEVICE_FIELDS = [
  'algorithms',
  'deviceId',
  'isBlacklisted',
  'isCrossSignedByOwner',
  'isCrossSigningTrusted',
  'isDehydrated',
  'isDeleted',
  'isLocallyTrusted',
  'isVerified',
  'keys',
  'localTrustState',
  'signatures',
  'userId',
];

/** The trust answers of a device snapshot, which are compared by value even where keys differ. */
const trust = (device) =>
  device && {
    isVerified: device.isVerified,
    isCrossSigningTrusted: device.isCrossSigningTrusted,
    isCrossSignedByOwner: device.isCrossSignedByOwner,
    isLocallyTrusted: device.isLocallyTrusted,
    isBlacklisted: device.isBlacklisted,
    localTrustState: device.localTrustState,
  };

const UNTRUSTED = {
  isVerified: false,
  isCrossSigningTrusted: false,
  isLocallyTrusted: false,
  isBlacklisted: false,
  localTrustState: LocalTrust.Unset,
};

/** An identity snapshot with its keys by shape (fresh keys, or the observer's signatures). */
const identityTrust = (identity) => {
  if (!identity) return identity;
  const { masterKey, selfSigningKey, userSigningKey, ...rest } = identity;
  const keys = { masterKey, selfSigningKey, userSigningKey };
  return {
    ...rest,
    keys: Object.fromEntries(
      Object.entries(keys)
        .filter(([, key]) => key !== undefined)
        .map(([name, key]) => [name, shape(JSON.parse(key), freshKeys)]),
    ),
  };
};

/** Each answer's identity through `identityTrust`. */
const identities = (answers) =>
  answers.map(({ result: identity }) => identityTrust(identity));

/** Creates and uploads `device`'s cross-signing keys and signs its device with them. */
const bootstrap = async (server, device) => {
  const requests = result(await device.bootstrapCrossSigning(true));
  if (requests.uploadKeysRequest) {
    await server.send(device, requests.uploadKeysRequest);
  }
  server.uploadSigningKeys(device, requests.uploadSigningKeysRequest);
  await server.send(device, requests.uploadSignaturesRequest);
  return requests;
};

/** `/keys/query` for `users` now, as matrix-js-sdk does with `queryKeysForUsers`. */
const query = async (server, device, users) =>
  server.send(device, result(await device.queryKeysForUsers(users)));

/** Uploads keys and tracks `users`, fetching their keys. */
const join = async (server, device, users) => {
  await server.flush(device);
  await device.updateTrackedUsers(users);
  await server.flush(device);
};

describe.skipIf(!hasCargo)(`native crypto trust with WASM${skipped}`, () => {
  const device = useDevices();

  /** A cross-signed WASM user, then a native and a WASM observer that track it. */
  const world = async () => {
    const server = new Homeserver();
    const bob = await device('wasm');
    await server.flush(bob);
    await bootstrap(server, bob);
    const observers = [await device('native'), await device('wasm')];
    for (const observer of observers)
      await join(server, observer, [bob.userId]);
    return { server, bob, observers };
  };

  /** Each (cross-signed) observer verifies `user`'s identity and fetches the signature back. */
  const verifyUser = async (server, observers, user) => {
    const requests = await each(observers, (it) => it.verifyIdentity(user));
    // The signature is fresh on each side: same request, compared by shape.
    expectSame(
      requests.map(({ result: request }, index) =>
        requestShape(request, observers[index]),
      ),
      'verifyIdentity',
    );
    expect(requests[0].result.type).toBe(RequestType.SignatureUpload);
    expect(requests[0].result.id).toBeUndefined();
    for (const [index, observer] of observers.entries()) {
      await server.send(observer, requests[index].result);
      await compared(() => query(server, observer, [user]));
    }
  };

  covered(
    [
      'OlmMachine.getDevice',
      'OlmMachine.getUserDevices',
      'OlmMachine.getIdentity',
      'OlmMachine.trackedUsers',
      'OlmMachine.queryKeysForUsers',
      'OlmMachine.markRequestAsSent',
      'OlmMachine.registerDevicesUpdatedCallback',
      'OlmMachine.registerUserIdentityUpdatedCallback',
      'Device.algorithms',
      'Device.deviceId',
      'Device.displayName',
      'Device.isBlacklisted',
      'Device.isCrossSignedByOwner',
      'Device.isCrossSigningTrusted',
      'Device.isDehydrated',
      'Device.isLocallyTrusted',
      'Device.isVerified',
      'Device.keys',
      'Device.signatures',
      'UserDevices.devices',
      'OtherUserIdentity.identityNeedsUserApproval',
    ],
    "answers for another user's unverified device and identity as WASM does",
    async () => {
      const { server, bob, observers } = await world();

      const events = await both(observers, (it) => it.pollEvents());
      expectSame(events, 'pollEvents after the first key query');
      expect(events[0].result.events).toContainEqual({
        type: 'userIdentityUpdated',
        userId: bob.userId,
      });
      expect(
        events[0].result.events.some(
          ({ type, userIds }) =>
            type === 'devicesUpdated' && userIds.includes(bob.userId),
        ),
      ).toBe(true);

      const tracked = await both(observers, (it) => it.trackedUsers());
      expectSame(
        tracked.map(({ result: users }) => [...users].sort()),
        'trackedUsers',
      );
      expect(tracked[0].result).toContain(bob.userId);

      const found = await both(observers, (it) =>
        it.getDevice(bob.userId, bob.deviceId),
      );
      expectSame(found, 'getDevice');
      const snapshot = found[0].result;
      // Every field WASM's getters give, and nothing else.
      expect(Object.keys(snapshot).sort()).toEqual(DEVICE_FIELDS);
      expect(snapshot).toMatchObject({
        ...UNTRUSTED,
        isCrossSignedByOwner: true,
        isDeleted: false,
        isDehydrated: false,
        userId: bob.userId,
        deviceId: bob.deviceId,
      });
      expect(snapshot.keys[`ed25519:${bob.deviceId}`]).toBe(
        bob.identityKeys.ed25519,
      );
      expect(
        Object.values(snapshot.signatures[bob.userId]).every(
          ({ isValid }) => isValid,
        ),
      ).toBe(true);

      expectSame(
        await both(observers, (it) => it.getUserDevices(bob.userId)),
        'getUserDevices',
      );
      expectSame(
        await both(observers, (it) => it.getDevice(bob.userId, 'NOPE')),
        'getDevice of an unknown device',
      );

      const identity = await both(observers, (it) =>
        it.getIdentity(bob.userId),
      );
      expectSame(identity, 'getIdentity');
      expect(identity[0].result).toMatchObject({
        kind: 'other',
        isVerified: false,
        wasPreviouslyVerified: false,
        hasVerificationViolation: false,
        identityNeedsUserApproval: false,
      });
      expect(JSON.parse(identity[0].result.masterKey)).toEqual(
        server.crossSigning.get(bob.userId).master_key,
      );
      expectSame(
        await both(observers, (it) => it.getIdentity('@nobody:localhost')),
        'getIdentity of an unknown user',
      );

      // A query answered again with nothing new changes nothing.
      await both(observers, (it) => query(server, it, [bob.userId]));
      expectSame(
        await both(observers, (it) => it.pollEvents()),
        'pollEvents after an unchanged query',
      );

      // The homeserver adds the display name outside the signed keys.
      server.deviceKeys.get(bob.userId)[bob.deviceId].unsigned = {
        device_display_name: "Bob's phone",
      };
      await both(observers, (it) => query(server, it, [bob.userId]));
      expectSame(
        await both(observers, (it) => it.pollEvents()),
        'pollEvents after a display name change',
      );
      const named = await both(observers, (it) =>
        it.getDevice(bob.userId, bob.deviceId),
      );
      expectSame(named, 'getDevice with a display name');
      expect(named[0].result).toMatchObject({
        ...UNTRUSTED,
        displayName: "Bob's phone",
      });
    },
  );

  covered(
    [
      'Device.setLocalTrust',
      'Device.isLocallyTrusted',
      'Device.isBlacklisted',
      'Device.isVerified',
    ],
    'sets local trust and blacklists a device as WASM does',
    async () => {
      const { bob, observers } = await world();
      const expected = {
        [LocalTrust.Verified]: {
          isVerified: true,
          isLocallyTrusted: true,
          isBlacklisted: false,
        },
        [LocalTrust.BlackListed]: {
          isVerified: false,
          isLocallyTrusted: false,
          isBlacklisted: true,
        },
        [LocalTrust.Ignored]: {
          isVerified: false,
          isLocallyTrusted: false,
          isBlacklisted: false,
        },
        [LocalTrust.Unset]: {
          isVerified: false,
          isLocallyTrusted: false,
          isBlacklisted: false,
        },
      };
      for (const state of [
        LocalTrust.Verified,
        LocalTrust.BlackListed,
        LocalTrust.Ignored,
        LocalTrust.Unset,
      ]) {
        expectSame(
          await both(observers, (it) =>
            it.setLocalTrust(bob.userId, bob.deviceId, state),
          ),
          `setLocalTrust ${state}`,
        );
        const found = await both(observers, (it) =>
          it.getDevice(bob.userId, bob.deviceId),
        );
        expectSame(found, `getDevice after setLocalTrust ${state}`);
        expect(found[0].result).toMatchObject({
          ...expected[state],
          localTrustState: state,
          isCrossSigningTrusted: false,
        });
      }
      // Only the owner can cross-sign a device, and neither observer has keys.
      const refused = await both(observers, (it) =>
        it.verifyDevice(bob.userId, bob.deviceId),
      );
      expectSame(refused, "verifyDevice of another user's device");
      expect(refused[0].error).toBeDefined();
      const [native] = observers;
      expect(
        (await native.setLocalTrust(bob.userId, 'NOPE', LocalTrust.Verified))
          .error.code,
      ).toBe('UnknownDevice');
      expect(
        (await native.setLocalTrust(bob.userId, bob.deviceId, 4)).error.code,
      ).toBe('InvalidRequest');
    },
  );

  covered(
    [
      'OlmMachine.bootstrapCrossSigning',
      'OlmMachine.crossSigningStatus',
      'OwnUserIdentity.verify',
      'OwnUserIdentity.wasPreviouslyVerified',
      'OwnUserIdentity.withdrawVerification',
      'OtherUserIdentity.identityNeedsUserApproval',
      'Device.isCrossSigningTrusted',
      'OlmMachine.registerUserIdentityUpdatedCallback',
    ],
    'verifies another user and flags the violation when their key changes',
    async () => {
      const { server, bob, observers } = await world();
      expectSame(
        await both(observers, (it) => it.crossSigningStatus()),
        'crossSigningStatus before',
      );
      // Fresh keys: the requests compared by shape.
      const bootstrapped = await each(observers, (it) =>
        it.bootstrapCrossSigning(true),
      );
      expectSame(
        bootstrapped.map(({ result: requests }, index) => ({
          keys: requestShape(
            requests.uploadSigningKeysRequest,
            observers[index],
          ),
          signatures: requestShape(
            requests.uploadSignaturesRequest,
            observers[index],
          ),
        })),
        'bootstrapCrossSigning',
      );
      for (const [index, observer] of observers.entries()) {
        const requests = bootstrapped[index].result;
        expect(requests.uploadKeysRequest).toBeUndefined();
        server.uploadSigningKeys(observer, requests.uploadSigningKeysRequest);
        await server.send(observer, requests.uploadSignaturesRequest);
      }
      const status = await both(observers, (it) => it.crossSigningStatus());
      expectSame(status, 'crossSigningStatus after');
      expect(status[0].result).toEqual({
        hasMaster: true,
        hasSelfSigning: true,
        hasUserSigning: true,
      });

      await verifyUser(server, observers, bob.userId);
      const verified = await both(observers, (it) =>
        it.getIdentity(bob.userId),
      );
      // The observer's own signature on Bob's master key is fresh: keys by shape.
      expectSame(identities(verified), 'getIdentity once verified');
      expect(verified[0].result).toMatchObject({
        isVerified: true,
        wasPreviouslyVerified: true,
        hasVerificationViolation: false,
        identityNeedsUserApproval: false,
      });
      const trusted = await both(observers, (it) =>
        it.getDevice(bob.userId, bob.deviceId),
      );
      expectSame(trusted, 'getDevice once its owner is verified');
      expect(trust(trusted[0].result)).toMatchObject({
        isVerified: true,
        isCrossSigningTrusted: true,
        isLocallyTrusted: false,
      });

      // Bob resets his cross-signing keys: no longer verified, and the change must be flagged.
      await bootstrap(server, bob);
      await both(observers, (it) => it.pollEvents());
      await both(observers, (it) => query(server, it, [bob.userId]));
      const changed = await both(observers, (it) => it.pollEvents());
      expectSame(changed, 'pollEvents after the key change');
      expect(changed[0].result.events).toContainEqual({
        type: 'userIdentityUpdated',
        userId: bob.userId,
      });
      const violated = await both(observers, (it) =>
        it.getIdentity(bob.userId),
      );
      expectSame(identities(violated), 'getIdentity after the key change');
      expect(violated[0].result).toMatchObject({
        isVerified: false,
        wasPreviouslyVerified: true,
        hasVerificationViolation: true,
      });
      const untrusted = await both(observers, (it) =>
        it.getDevice(bob.userId, bob.deviceId),
      );
      expectSame(untrusted, 'getDevice after the key change');
      expect(trust(untrusted[0].result)).toMatchObject({
        ...UNTRUSTED,
        isCrossSignedByOwner: true,
      });

      expectSame(
        await both(observers, (it) => it.withdrawVerification(bob.userId)),
        'withdrawVerification',
      );
      const withdrawn = await both(observers, (it) =>
        it.getIdentity(bob.userId),
      );
      expectSame(
        identities(withdrawn),
        'getIdentity after withdrawVerification',
      );
      expect(withdrawn[0].result).toMatchObject({
        isVerified: false,
        wasPreviouslyVerified: false,
        hasVerificationViolation: false,
      });
    },
  );

  covered(
    [
      'OtherUserIdentity.pinCurrentMasterKey',
      'OtherUserIdentity.identityNeedsUserApproval',
    ],
    'asks for approval of a changed unverified identity until it is pinned',
    async () => {
      const { server, bob, observers } = await world();
      await bootstrap(server, bob);
      await both(observers, (it) => query(server, it, [bob.userId]));
      const changed = await both(observers, (it) => it.getIdentity(bob.userId));
      expectSame(changed, 'getIdentity after the key change');
      expect(changed[0].result).toMatchObject({
        isVerified: false,
        hasVerificationViolation: false,
        identityNeedsUserApproval: true,
      });
      expectSame(
        await both(observers, (it) => it.pinCurrentMasterKey(bob.userId)),
        'pinCurrentMasterKey',
      );
      const pinned = await both(observers, (it) => it.getIdentity(bob.userId));
      expectSame(pinned, 'getIdentity once pinned');
      expect(pinned[0].result.identityNeedsUserApproval).toBe(false);
    },
  );

  covered(
    [
      'Device.verify',
      'Device.isCrossSigningTrusted',
      'Device.isCrossSignedByOwner',
      'OwnUserIdentity.isVerified',
      'OwnUserIdentity.masterKey',
      'OwnUserIdentity.selfSigningKey',
      'OwnUserIdentity.userSigningKey',
    ],
    'trusts its own devices through cross-signing as WASM does',
    async () => {
      const server = new Homeserver();
      const primaries = [await device('native'), await device('wasm')];
      // A second WASM device for each user, named after its primary so IDs anonymise alike.
      const siblings = [];
      for (const primary of primaries) {
        siblings.push(
          await device('wasm', {
            userId: primary.userId,
            deviceId: `${primary.deviceId}S`,
          }),
        );
      }
      for (const sibling of siblings) await server.flush(sibling);
      for (const primary of primaries) {
        await join(server, primary, [primary.userId]);
        await bootstrap(server, primary);
      }
      const other = (it) => siblings[primaries.indexOf(it)].deviceId;
      // The sibling's keys differ per side: its trust by value, the rest by shape.
      const sibling = async (it) => {
        const answer = await it.getDevice(it.userId, other(it));
        return { trust: trust(answer.result), shape: shape(answer, freshKeys) };
      };

      const before = await both(primaries, sibling);
      expectSame(before, 'getDevice of an own unsigned device');
      expect(before[0].trust).toEqual({
        ...UNTRUSTED,
        isCrossSignedByOwner: false,
      });
      const self = await both(primaries, async (it) => {
        const answer = await it.getDevice(it.userId, it.deviceId);
        return trust(answer.result);
      });
      expectSame(self, 'getDevice of the device itself');

      const identity = await both(primaries, async (it) =>
        identityTrust(result(await it.getIdentity(it.userId))),
      );
      expectSame(identity, 'getIdentity of the own user');
      expect(identity[0]).toMatchObject({
        kind: 'own',
        isVerified: true,
        hasVerificationViolation: false,
      });
      const own = result(await primaries[0].getIdentity(primaries[0].userId));
      expect(JSON.parse(own.masterKey)).toEqual(
        server.crossSigning.get(primaries[0].userId).master_key,
      );
      expect(JSON.parse(own.userSigningKey)).toEqual(
        server.crossSigning.get(primaries[0].userId).user_signing_key,
      );

      const requests = await each(primaries, (it) =>
        it.verifyDevice(it.userId, other(it)),
      );
      expectSame(
        requests.map(({ result: request }, index) =>
          requestShape(request, primaries[index]),
        ),
        'verifyDevice',
      );
      expect(requests[0].result.type).toBe(RequestType.SignatureUpload);
      for (const [index, primary] of primaries.entries()) {
        await server.send(primary, requests[index].result);
        await query(server, primary, [primary.userId]);
      }
      const after = await both(primaries, sibling);
      expectSame(after, 'getDevice of an own device once signed');
      expect(after[0].trust).toMatchObject({
        isVerified: true,
        isCrossSigningTrusted: true,
        isCrossSignedByOwner: true,
        isLocallyTrusted: false,
      });
    },
  );

  covered(
    [
      'OlmMachine.exportCrossSigningKeys',
      'OlmMachine.importCrossSigningKeys',
      'OlmMachine.crossSigningStatus',
      'OwnUserIdentity.isVerified',
    ],
    'imports its own cross-signing keys and rejects wrong ones as WASM does',
    async () => {
      const server = new Homeserver();
      // For each side, a WASM device that owns the keys and a device of the side under test,
      // whose ID is a prefix of the owner's so both anonymise alike.
      const tag = Math.random().toString(36).slice(2, 8);
      const ids = ['native', 'wasm'].map((kind) => ({
        userId: `@keys${kind}${tag}:localhost`,
        deviceId: `IMPORT${kind.toUpperCase()}${tag}`,
      }));
      const owners = [];
      for (const { userId, deviceId } of ids) {
        owners.push(await device('wasm', { userId, deviceId: `${deviceId}O` }));
      }
      const stranger = await device('wasm');
      for (const owner of [...owners, stranger]) {
        await server.flush(owner);
        await bootstrap(server, owner);
      }
      const importers = [];
      for (const [index, kind] of ['native', 'wasm'].entries()) {
        importers.push(await device(kind, ids[index]));
      }
      for (const importer of importers) {
        await join(server, importer, [importer.userId]);
      }
      const exported = await Promise.all(
        owners.map(async (owner) =>
          result(await owner.exportCrossSigningKeys()),
        ),
      );
      const keys = (it) => {
        const { masterKey, self_signing_key, userSigningKey } =
          exported[importers.indexOf(it)];
        return { masterKey, selfSigningKey: self_signing_key, userSigningKey };
      };
      const strangerKeys = result(await stranger.exportCrossSigningKeys());

      expectSame(
        await both(importers, (it) => it.exportCrossSigningKeys()),
        'exportCrossSigningKeys without keys',
      );
      const unverified = await both(importers, async (it) =>
        identityTrust(result(await it.getIdentity(it.userId))),
      );
      expectSame(unverified, 'getIdentity before the import');
      expect(unverified[0].isVerified).toBe(false);

      const wrong = {
        'malformed keys': () => ({
          masterKey: 'not base64!',
          selfSigningKey: 'not base64!',
          userSigningKey: 'not base64!',
        }),
        "another user's keys": () => ({
          masterKey: strangerKeys.masterKey,
          selfSigningKey: strangerKeys.self_signing_key,
          userSigningKey: strangerKeys.userSigningKey,
        }),
        'a wrong master key only': (it) => ({
          ...keys(it),
          masterKey: strangerKeys.masterKey,
        }),
        'no keys': () => ({}),
      };
      for (const [name, made] of Object.entries(wrong)) {
        const answer = await both(importers, (it) =>
          it.importCrossSigningKeys(made(it)),
        );
        if (name === 'malformed keys') {
          // Same code; native's message is fixed on purpose, as WASM's names a character of the
          // private key and its offset.
          expect(answer[0].error).toEqual({
            code: 'CryptoError',
            message:
              'Error while importing m.cross_signing.master: invalid key',
          });
          expect(answer[1].error.code).toBe('CryptoError');
          expect(answer[1].error.message).toMatch(
            /^Error while importing m\.cross_signing\.master: /,
          );
        } else {
          expectSame(answer, `importCrossSigningKeys with ${name}`);
        }
        // Never a key this device did not have before.
        expect(answer[0].result ?? {}).not.toMatchObject({ hasMaster: true });
        expectSame(
          await both(importers, (it) => it.crossSigningStatus()),
          `crossSigningStatus after ${name}`,
        );
      }

      const imported = await both(importers, (it) =>
        it.importCrossSigningKeys(keys(it)),
      );
      expectSame(imported, 'importCrossSigningKeys');
      expect(imported[0].result).toEqual({
        hasMaster: true,
        hasSelfSigning: true,
        hasUserSigning: true,
      });
      const verified = await both(importers, async (it) =>
        identityTrust(result(await it.getIdentity(it.userId))),
      );
      expectSame(verified, 'getIdentity after the import');
      expect(verified[0].isVerified).toBe(true);
      // The keys come back out exactly as they went in.
      const again = await each(importers, async (it) =>
        result(await it.exportCrossSigningKeys()),
      );
      expect(again[0]).toEqual(exported[0]);
      expect(again[1]).toEqual(exported[1]);
    },
  );

  covered(
    [
      'Device.isCrossSigningTrusted',
      'Device.isVerified',
      'OlmMachine.getDevice',
    ],
    'does not trust a device whose signatures were tampered with',
    async () => {
      const server = new Homeserver();
      const bob = await device('wasm');
      const forged = await device('wasm', {
        userId: bob.userId,
        deviceId: `${bob.deviceId}F`,
      });
      const broken = await device('wasm', {
        userId: bob.userId,
        deviceId: `${bob.deviceId}B`,
      });
      for (const it of [bob, forged, broken]) await server.flush(it);
      await bootstrap(server, bob);
      await join(server, bob, [bob.userId]);
      await query(server, bob, [bob.userId]);
      for (const signed of [forged, broken]) {
        const request = result(
          await bob.verifyDevice(bob.userId, signed.deviceId),
        );
        await server.send(bob, request);
      }
      const ssk = Object.keys(
        server.crossSigning.get(bob.userId).self_signing_key.keys,
      )[0];
      // The self-signing key's signature on one device, the device's own on the other.
      server.tamper(bob.userId, forged.deviceId, bob.userId, ssk);
      server.tamper(
        bob.userId,
        broken.deviceId,
        bob.userId,
        `ed25519:${broken.deviceId}`,
      );

      const observers = [await device('native'), await device('wasm')];
      for (const observer of observers) {
        await join(server, observer, [bob.userId]);
        await bootstrap(server, observer);
      }
      await verifyUser(server, observers, bob.userId);

      const control = await both(observers, (it) =>
        it.getDevice(bob.userId, bob.deviceId),
      );
      expectSame(control, 'getDevice of the correctly signed device');
      expect(control[0].result.isCrossSigningTrusted).toBe(true);

      const tampered = await both(observers, (it) =>
        it.getDevice(bob.userId, forged.deviceId),
      );
      expectSame(tampered, 'getDevice with a tampered cross-signing signature');
      expect(trust(tampered[0].result)).toEqual({
        ...UNTRUSTED,
        isCrossSignedByOwner: false,
      });

      expectSame(
        await both(observers, (it) =>
          it.getDevice(bob.userId, broken.deviceId),
        ),
        'getDevice with a tampered self-signature',
      );
      expect(
        (await observers[0].getDevice(bob.userId, broken.deviceId)).result,
      ).toBeNull();

      // The same three devices from one WASM user: compared by value, the broken one left out.
      const all = await both(observers, (it) => it.getUserDevices(bob.userId));
      expectSame(all, 'getUserDevices with tampered devices');
      expect(all[0].result.map(({ deviceId }) => deviceId)).toEqual(
        [bob.deviceId, forged.deviceId].sort(),
      );
    },
  );

  covered(
    ['OlmMachine.markAllTrackedUsersAsDirty'],
    'queries every tracked user again once marked dirty, as WASM does',
    async () => {
      const { server, bob, observers } = await world();
      // The users each pending key query asks for, the observer itself as `<self>`.
      const queried = async (it) =>
        (await it.outgoingRequests())
          .filter(({ type }) => type === RequestType.KeysQuery)
          .map(({ body }) =>
            Object.keys(JSON.parse(body).device_keys)
              .map((user) => (user === it.userId ? '<self>' : user))
              .sort(),
          );
      const before = await both(observers, queried);
      expectSame(before, 'key queries before');
      expect(before[0]).toEqual([]);
      expectSame(
        await both(observers, (it) => it.markAllTrackedUsersAsDirty()),
        'markAllTrackedUsersAsDirty',
      );
      const after = await both(observers, queried);
      expectSame(after, 'key queries once marked dirty');
      expect(after[0]).toEqual([['<self>', bob.userId].sort()]);
      for (const observer of observers) await server.flush(observer);
      expectSame(await both(observers, queried), 'key queries once answered');
    },
  );

  covered(
    ['OlmMachine.bootstrapCrossSigning', 'OlmMachine.crossSigningStatus'],
    'bootstraps cross-signing before the device keys are uploaded, as WASM does',
    async () => {
      const server = new Homeserver();
      const fresh = [await device('native'), await device('wasm')];
      const bootstrapped = await each(fresh, (it) =>
        it.bootstrapCrossSigning(false),
      );
      // Fresh keys and request IDs: the three requests by shape.
      expectSame(
        bootstrapped.map(({ result: requests }, index) =>
          Object.fromEntries(
            Object.entries(requests).map(([name, request]) => [
              name,
              requestShape(request, fresh[index]),
            ]),
          ),
        ),
        'bootstrapCrossSigning before the keys upload',
      );
      expect(bootstrapped[0].result.uploadKeysRequest.type).toBe(
        RequestType.KeysUpload,
      );
      for (const [index, it] of fresh.entries()) {
        const requests = bootstrapped[index].result;
        await server.send(it, requests.uploadKeysRequest);
        server.uploadSigningKeys(it, requests.uploadSigningKeysRequest);
        await server.send(it, requests.uploadSignaturesRequest);
        await join(server, it, [it.userId]);
      }
      expectSame(
        await both(fresh, (it) => it.crossSigningStatus()),
        'crossSigningStatus after the bootstrap',
      );
      const self = await both(fresh, async (it) =>
        trust(result(await it.getDevice(it.userId, it.deviceId))),
      );
      expectSame(self, 'getDevice of the bootstrapped device');
      expect(self[0]).toMatchObject({
        isCrossSigningTrusted: true,
        isCrossSignedByOwner: true,
      });
    },
  );

  covered(
    ['Device.encryptToDeviceEvent'],
    'encrypts a to-device event for one device as WASM does',
    async () => {
      const { server, bob, observers } = await world();
      for (const observer of observers) {
        const claim = await observer.getMissingSessions([bob.userId]);
        await server.send(observer, claim);
      }
      const content = { hello: 'world' };
      const encrypted = await each(observers, (it) =>
        it.encryptToDeviceEvent(bob.userId, bob.deviceId, 'm.test', content),
      );
      // Fresh ciphertext: same shape, and Bob decrypts each.
      expectSame(
        encrypted.map(({ result: json }) => shape(JSON.parse(json), freshKeys)),
        'encryptToDeviceEvent',
      );
      for (const [index, observer] of observers.entries()) {
        server.deliver(bob, [
          {
            type: 'm.room.encrypted',
            sender: observer.userId,
            content: JSON.parse(encrypted[index].result),
          },
        ]);
      }
      const received = await server.sync(bob);
      expect(received.map(({ type }) => type)).toEqual([0, 0]);
      for (const [index, observer] of observers.entries()) {
        const event = JSON.parse(received[index].rawEvent);
        expect(event).toMatchObject({
          type: 'm.test',
          sender: observer.userId,
          content,
        });
      }
    },
  );

  covered(
    ['OlmMachine.verifyBackup', 'OlmMachine.sign'],
    'trusts backup info only when signed by a verified own device or identity',
    async () => {
      const server = new Homeserver();
      const primaries = [await device('native'), await device('wasm')];
      const siblings = [];
      for (const primary of primaries) {
        siblings.push(
          await device('wasm', {
            userId: primary.userId,
            deviceId: `${primary.deviceId}S`,
          }),
        );
      }
      for (const sibling of siblings) await server.flush(sibling);
      for (const primary of primaries)
        await join(server, primary, [primary.userId]);
      const publicKey =
        wasm.BackupDecryptionKey.createRandomKey().megolmV1PublicKey
          .publicKeyBase64;
      const info = (signatures) => ({
        algorithm: BACKUP_ALGORITHM,
        auth_data: { public_key: publicKey, signatures },
      });
      const message = JSON.stringify({ public_key: publicKey });
      const bySibling = await Promise.all(
        siblings.map(async (sibling) => result(await sibling.sign(message))),
      );
      const siblingInfo = (it) => info(bySibling[primaries.indexOf(it)]);
      const { Missing, ValidAndTrusted } = SignatureState;

      const unverified = await both(primaries, (it) =>
        it.verifyBackup(siblingInfo(it)),
      );
      // deviceState and userState are this device's and the identity's signatures only; another
      // device's signature counts in `trusted`, and only once that device is verified.
      expectSame(
        unverified,
        'verifyBackup signed by a known unverified device',
      );
      expect(unverified[0].result).toEqual({
        deviceState: Missing,
        userState: Missing,
        trusted: false,
      });

      for (const primary of primaries) await bootstrap(server, primary);
      const signed = await both(primaries, async (it) =>
        it.verifyBackup(info(result(await it.sign(message)))),
      );
      expectSame(signed, 'verifyBackup signed by device and master key');
      expect(signed[0].result).toEqual({
        deviceState: ValidAndTrusted,
        userState: ValidAndTrusted,
        trusted: true,
      });
      // The master key's signature alone is enough.
      const byMaster = await both(primaries, async (it) => {
        const signatures = result(await it.sign(message));
        delete signatures[it.userId][`ed25519:${it.deviceId}`];
        return it.verifyBackup(info(signatures));
      });
      expectSame(byMaster, 'verifyBackup signed by the master key only');
      expect(byMaster[0].result).toEqual({
        deviceState: Missing,
        userState: ValidAndTrusted,
        trusted: true,
      });

      for (const [index, primary] of primaries.entries()) {
        const request = result(
          await primary.verifyDevice(primary.userId, siblings[index].deviceId),
        );
        await server.send(primary, request);
        await query(server, primary, [primary.userId]);
      }
      const verified = await both(primaries, (it) =>
        it.verifyBackup(siblingInfo(it)),
      );
      expectSame(verified, 'verifyBackup signed by a verified own device');
      expect(verified[0].result).toEqual({
        deviceState: Missing,
        userState: Missing,
        trusted: true,
      });
    },
  );
});
