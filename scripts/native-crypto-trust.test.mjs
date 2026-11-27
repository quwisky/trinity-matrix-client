/**
 * Devices, user identities, trust and cross-signing: each step runs on a native observer and a
 * WASM observer that see the same other users through one homeserver, and both must answer the
 * same, by value. Trust answers (verified, cross-signing trusted, locally trusted, blacklisted,
 * needs approval, violation) are always compared by value; fresh keys and signatures by shape,
 * as each case says. A wrong `true` here is a security bug, so cases also pin the expected
 * answer, not only the agreement.
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import * as wasm from '@matrix-org/matrix-sdk-crypto-wasm';
import {
  Homeserver,
  anonymise,
  both,
  covered,
  each,
  expectSame,
  fromWasm,
  hasCargo,
  shape,
  skipped,
  useDevices,
} from './native-crypto-harness.mjs';

const { LocalTrust, RequestType, SignatureState } = wasm;
const BACKUP_ALGORITHM = 'm.megolm_backup.v1.curve25519-aes-sha2';

const result = (response) => {
  expect(response.error).toBeUndefined();
  return response.result;
};

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

/** An answer's identity through `identityTrust`, as a view for `expectSame`. */
const identityOf = (answer) => identityTrust(answer.result);

/** An answer's device trust, as a view for `expectSame`. */
const trustOf = (answer) => trust(answer.result);

/** A view for `expectSame`: an answered request by shape, for the device at each index. */
const requestOf = (devices) => (answer, index) =>
  requestShape(answer.result, devices[index]);

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

/** `/keys/query` for `users` now, as matrix-js-sdk does with `queryKeysForUsers` (setup). */
const fetchKeys = async (server, device, users) =>
  server.send(device, result(await device.queryKeysForUsers(users)));

/**
 * `/keys/query` for `users` on each device, compared: the request by shape (its ID is random)
 * and markRequestAsSent's answer by value.
 */
const query = async (server, devices, users, step) => {
  const answers = await each(devices, async (it) => {
    const request = await it.queryKeysForUsers(
      typeof users === 'function' ? users(it) : users,
    );
    return { request, marked: await server.send(it, result(request)) };
  });
  expectSame(answers, step, ({ request, marked }, index) => ({
    request: requestShape(request.result, devices[index]),
    marked,
  }));
};

/** Flips the first character of a base64 signature. */
const flip = (signature) =>
  (signature.startsWith('A') ? 'B' : 'A') + signature.slice(1);

/** Matrix canonical JSON (sorted keys, no whitespace): what a signature signs. */
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(',')}}`
      : JSON.stringify(value);

/** The bytes a Matrix signature on `object` covers. */
const signedBytes = (object) => {
  const signed = structuredClone(object);
  delete signed.signatures;
  delete signed.unsigned;
  return Buffer.from(canonical(signed));
};

/** Signs `object` with an exported ed25519 private key (base64 seed), as a client would. */
const signWithSeed = (object, seed) =>
  sign(
    null,
    signedBytes(object),
    createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.from(seed, 'base64'),
      ]),
      format: 'der',
      type: 'pkcs8',
    }),
  )
    .toString('base64')
    .replace(/=+$/, '');

/** Whether `signature` on `object` is valid for the ed25519 public key (base64). */
const validSignature = (object, publicKey, signature) =>
  verify(
    null,
    signedBytes(object),
    createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(publicKey, 'base64'),
      ]),
      format: 'der',
      type: 'spki',
    }),
    Buffer.from(signature, 'base64'),
  );

/** WASM's `CollectStrategy.deviceBasedStrategy` as the crate's strategy names, in WASM's order. */
const deviceBasedStrategy = (
  onlyAllowTrustedDevices,
  errorOnVerifiedUserProblem,
) => {
  if (onlyAllowTrustedDevices) return 'onlyTrustedDevices';
  if (errorOnVerifiedUserProblem) return 'errorOnUnverifiedUserProblem';
  return 'allDevices';
};

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
    expectSame(requests, 'verifyIdentity', requestOf(observers));
    expect(requests[0].result.type).toBe(RequestType.SignatureUpload);
    expect(requests[0].result.id).toBeUndefined();
    for (const [index, observer] of observers.entries()) {
      await server.send(observer, requests[index].result);
    }
    await query(server, observers, [user], 'query after verifyIdentity');
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
      expectSame(tracked, 'trackedUsers', ({ result: users }) =>
        [...users].sort(),
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
      await query(server, observers, [bob.userId], 'an unchanged query');
      expectSame(
        await both(observers, (it) => it.pollEvents()),
        'pollEvents after an unchanged query',
      );

      // The homeserver adds the display name outside the signed keys.
      server.deviceKeys.get(bob.userId)[bob.deviceId].unsigned = {
        device_display_name: "Bob's phone",
      };
      await query(server, observers, [bob.userId], 'query for a display name');
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
      'OtherUserIdentity.isVerified',
      'OtherUserIdentity.masterKey',
      'OtherUserIdentity.selfSigningKey',
      'OtherUserIdentity.wasPreviouslyVerified',
      'OtherUserIdentity.withdrawVerification',
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
        bootstrapped,
        'bootstrapCrossSigning',
        ({ result: requests }, index) => ({
          keys: requestShape(
            requests.uploadSigningKeysRequest,
            observers[index],
          ),
          signatures: requestShape(
            requests.uploadSignaturesRequest,
            observers[index],
          ),
        }),
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
      expectSame(verified, 'getIdentity once verified', identityOf);
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
      // Blacklisting does not undo cross-signing trust: `isVerified` stays true beside
      // `isBlacklisted`, which matrix-js-sdk's device converter therefore checks first.
      for (const state of [LocalTrust.BlackListed, LocalTrust.Unset]) {
        expectSame(
          await both(observers, (it) =>
            it.setLocalTrust(bob.userId, bob.deviceId, state),
          ),
          `setLocalTrust ${state} on a cross-signed device`,
        );
        const now = await both(observers, (it) =>
          it.getDevice(bob.userId, bob.deviceId),
        );
        expectSame(now, `getDevice after setLocalTrust ${state}`);
        expect(trust(now[0].result)).toEqual({
          isVerified: true,
          isCrossSigningTrusted: true,
          isCrossSignedByOwner: true,
          isLocallyTrusted: false,
          isBlacklisted: state === LocalTrust.BlackListed,
          localTrustState: state,
        });
      }

      // Bob resets his cross-signing keys: no longer verified, and the change must be flagged.
      await bootstrap(server, bob);
      await both(observers, (it) => it.pollEvents());
      await query(
        server,
        observers,
        [bob.userId],
        'query after the key change',
      );
      const changed = await both(observers, (it) => it.pollEvents());
      expectSame(changed, 'pollEvents after the key change');
      expect(changed[0].result.events).toContainEqual({
        type: 'userIdentityUpdated',
        userId: bob.userId,
      });
      const violated = await both(observers, (it) =>
        it.getIdentity(bob.userId),
      );
      expectSame(violated, 'getIdentity after the key change', identityOf);
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

      // Pinning the new key settles the approval, not the violation: only withdrawing does.
      expect(violated[0].result.identityNeedsUserApproval).toBe(true);
      expectSame(
        await both(observers, (it) => it.pinCurrentMasterKey(bob.userId)),
        'pinCurrentMasterKey of a violated identity',
      );
      const pinned = await both(observers, (it) => it.getIdentity(bob.userId));
      expectSame(
        pinned,
        'getIdentity once the violation is pinned',
        identityOf,
      );
      expect(pinned[0].result).toMatchObject({
        isVerified: false,
        wasPreviouslyVerified: true,
        hasVerificationViolation: true,
        identityNeedsUserApproval: false,
      });

      expectSame(
        await both(observers, (it) => it.withdrawVerification(bob.userId)),
        'withdrawVerification',
      );
      const withdrawn = await both(observers, (it) =>
        it.getIdentity(bob.userId),
      );
      expectSame(
        withdrawn,
        'getIdentity after withdrawVerification',
        identityOf,
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
      await query(
        server,
        observers,
        [bob.userId],
        'query after the key change',
      );
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
      const sibling = (it) => it.getDevice(it.userId, other(it));
      const siblingView = (answer) => ({
        trust: trust(answer.result),
        shape: shape(answer, freshKeys),
      });

      const before = await both(primaries, sibling);
      expectSame(before, 'getDevice of an own unsigned device', siblingView);
      expect(trust(before[0].result)).toEqual({
        ...UNTRUSTED,
        isCrossSignedByOwner: false,
      });
      const self = await both(primaries, (it) =>
        it.getDevice(it.userId, it.deviceId),
      );
      expectSame(self, 'getDevice of the device itself', trustOf);

      const identity = await both(primaries, (it) => it.getIdentity(it.userId));
      expectSame(identity, 'getIdentity of the own user', identityOf);
      expect(identity[0].result).toMatchObject({
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
      expectSame(requests, 'verifyDevice', requestOf(primaries));
      expect(requests[0].result.type).toBe(RequestType.SignatureUpload);
      for (const [index, primary] of primaries.entries()) {
        await server.send(primary, requests[index].result);
        await fetchKeys(server, primary, [primary.userId]);
      }
      const after = await both(primaries, sibling);
      expectSame(after, 'getDevice of an own device once signed', siblingView);
      expect(trust(after[0].result)).toMatchObject({
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
      const unverified = await both(importers, (it) =>
        it.getIdentity(it.userId),
      );
      expectSame(unverified, 'getIdentity before the import', identityOf);
      expect(unverified[0].result.isVerified).toBe(false);

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
      const verified = await both(importers, (it) => it.getIdentity(it.userId));
      expectSame(verified, 'getIdentity after the import', identityOf);
      expect(verified[0].result.isVerified).toBe(true);
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
      await fetchKeys(server, bob, [bob.userId]);
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
      const pending = () => each(observers, (it) => it.outgoingRequests());
      // The users each pending key query asks for, the observer itself as `<self>`.
      const queried = (requests, index) =>
        requests
          .filter(({ type }) => type === RequestType.KeysQuery)
          .map(({ body }) =>
            Object.keys(JSON.parse(body).device_keys)
              .map((user) =>
                user === observers[index].userId ? '<self>' : user,
              )
              .sort(),
          );
      const before = await pending();
      expectSame(before, 'key queries before', queried);
      expect(queried(before[0], 0)).toEqual([]);
      expectSame(
        await both(observers, (it) => it.markAllTrackedUsersAsDirty()),
        'markAllTrackedUsersAsDirty',
      );
      const after = await pending();
      expectSame(after, 'key queries once marked dirty', queried);
      expect(queried(after[0], 0)).toEqual([['<self>', bob.userId].sort()]);
      for (const observer of observers) await server.flush(observer);
      expectSame(await pending(), 'key queries once answered', queried);
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
        bootstrapped,
        'bootstrapCrossSigning before the keys upload',
        ({ result: requests }, index) =>
          Object.fromEntries(
            Object.entries(requests).map(([name, request]) => [
              name,
              requestShape(request, fresh[index]),
            ]),
          ),
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
      const self = await both(fresh, (it) =>
        it.getDevice(it.userId, it.deviceId),
      );
      expectSame(self, 'getDevice of the bootstrapped device', trustOf);
      expect(trust(self[0].result)).toMatchObject({
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
      expectSame(encrypted, 'encryptToDeviceEvent', ({ result: json }) =>
        shape(JSON.parse(json), freshKeys),
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
    // `sign` only makes the signatures here; its answer is compared in the contract test.
    ['OlmMachine.verifyBackup'],
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
        await fetchKeys(server, primary, [primary.userId]);
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
  covered(
    [
      'OwnUserIdentity.isVerified',
      'OwnUserIdentity.wasPreviouslyVerified',
      'OwnUserIdentity.withdrawVerification',
      'OwnUserIdentity.verify',
      'OlmMachine.crossSigningStatus',
    ],
    'flags a reset of its own identity and verifies it again as WASM does',
    async () => {
      const server = new Homeserver();
      const primaries = [await device('native'), await device('wasm')];
      // Another device of the same user, named after its primary so IDs anonymise alike.
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
      const own = (it) => it.getIdentity(it.userId);
      const before = await both(primaries, own);
      expectSame(before, 'getIdentity of the own user', identityOf);
      expect(before[0].result).toMatchObject({
        kind: 'own',
        isVerified: true,
        hasVerificationViolation: false,
      });

      // The sibling resets the user's cross-signing keys.
      for (const sibling of siblings) await bootstrap(server, sibling);
      await both(primaries, (it) => it.pollEvents());
      await query(
        server,
        primaries,
        (it) => [it.userId],
        'query after the own key change',
      );
      const changed = await both(primaries, (it) => it.pollEvents());
      expectSame(changed, 'pollEvents after the own key change');
      expect(changed[0].result.events).toContainEqual({
        type: 'userIdentityUpdated',
        userId: '<receiver>',
      });
      const violated = await both(primaries, own);
      expectSame(violated, 'getIdentity after the own key change', identityOf);
      expect(violated[0].result).toMatchObject({
        kind: 'own',
        isVerified: false,
        wasPreviouslyVerified: true,
        hasVerificationViolation: true,
      });
      expectSame(
        await both(primaries, (it) => it.crossSigningStatus()),
        'crossSigningStatus after the own key change',
      );

      expectSame(
        await both(primaries, (it) => it.withdrawVerification(it.userId)),
        'withdrawVerification of the own identity',
      );
      const withdrawn = await both(primaries, own);
      expectSame(
        withdrawn,
        'getIdentity after withdrawVerification',
        identityOf,
      );
      expect(withdrawn[0].result).toMatchObject({
        isVerified: false,
        wasPreviouslyVerified: false,
        hasVerificationViolation: false,
      });

      const requests = await each(primaries, (it) =>
        it.verifyIdentity(it.userId),
      );
      expectSame(
        requests,
        'verifyIdentity of the own identity',
        requestOf(primaries),
      );
      for (const [index, primary] of primaries.entries()) {
        await server.send(primary, requests[index].result);
      }
      await query(
        server,
        primaries,
        (it) => [it.userId],
        'query after verifyIdentity of the own identity',
      );
      const verified = await both(primaries, own);
      expectSame(verified, 'getIdentity once verified again', identityOf);
      expect(verified[0].result).toMatchObject({
        isVerified: true,
        hasVerificationViolation: false,
      });
    },
  );

  covered(
    ['OlmMachine.getIdentity', 'OlmMachine.getDevice'],
    'does not trust another user whose self-signing key their master key did not sign',
    async () => {
      const server = new Homeserver();
      // Two cross-signed users; the homeserver breaks one master-key signature of Bob's only.
      const honest = await device('wasm');
      const bob = await device('wasm');
      for (const it of [honest, bob]) {
        await server.flush(it);
        await bootstrap(server, it);
      }
      const { master_key: master, self_signing_key: selfSigning } =
        server.crossSigning.get(bob.userId);
      const [[masterId, masterKey]] = Object.entries(master.keys);
      const valid = selfSigning.signatures[bob.userId][masterId];
      expect(validSignature(selfSigning, masterKey, valid)).toBe(true);
      selfSigning.signatures[bob.userId][masterId] = flip(valid);
      expect(
        validSignature(
          selfSigning,
          masterKey,
          selfSigning.signatures[bob.userId][masterId],
        ),
      ).toBe(false);

      const observers = [await device('native'), await device('wasm')];
      for (const observer of observers) {
        await join(server, observer, [honest.userId, bob.userId]);
        await bootstrap(server, observer);
      }
      // Control: the same fixture without the broken signature is verified and trusted.
      await verifyUser(server, observers, honest.userId);
      const control = await both(observers, (it) =>
        it.getIdentity(honest.userId),
      );
      expectSame(control, 'getIdentity of the intact user', identityOf);
      expect(control[0].result.isVerified).toBe(true);
      const controlDevice = await both(observers, (it) =>
        it.getDevice(honest.userId, honest.deviceId),
      );
      expectSame(controlDevice, 'getDevice of the intact user', trustOf);
      expect(trust(controlDevice[0].result)).toMatchObject({
        isVerified: true,
        isCrossSigningTrusted: true,
      });

      const identity = await both(observers, (it) =>
        it.getIdentity(bob.userId),
      );
      expectSame(
        identity,
        'getIdentity with an unsigned self-signing key',
        identityOf,
      );
      // Rejected as a whole: no identity, so nothing about Bob can be verified.
      expect(identity[0].result).toBeNull();
      const found = await both(observers, (it) =>
        it.getDevice(bob.userId, bob.deviceId),
      );
      expectSame(found, 'getDevice with an unsigned self-signing key');
      expect(trust(found[0].result)).toEqual({
        ...UNTRUSTED,
        isCrossSignedByOwner: false,
      });
    },
  );

  covered(
    ['OtherUserIdentity.identityNeedsUserApproval', 'OlmMachine.getDevice'],
    "does not trust a user-signing signature on another user's master key made by a stranger's key",
    async () => {
      const { server, bob, observers } = await world();
      const honest = await device('wasm');
      const stranger = await device('wasm');
      for (const it of [honest, stranger]) {
        await server.flush(it);
        await bootstrap(server, it);
      }
      for (const observer of observers) {
        await join(server, observer, [bob.userId, honest.userId]);
        await bootstrap(server, observer);
      }
      // Control: a user verified with the observer's own user-signing key is verified.
      await verifyUser(server, observers, honest.userId);
      const control = await both(observers, (it) =>
        it.getIdentity(honest.userId),
      );
      expectSame(control, 'getIdentity of a truly verified user', identityOf);
      expect(control[0].result.isVerified).toBe(true);

      const requests = await each(observers, (it) =>
        it.verifyIdentity(bob.userId),
      );
      expectSame(requests, 'verifyIdentity', requestOf(observers));
      // The homeserver replaces the observer's signature with a valid one made by a
      // stranger's user-signing key, under the observer's key ID.
      const strangerSeed = result(
        await stranger.exportCrossSigningKeys(),
      ).userSigningKey;
      const [[, strangerKey]] = Object.entries(
        server.crossSigning.get(stranger.userId).user_signing_key.keys,
      );
      for (const [index, observer] of observers.entries()) {
        const { keys } = server.crossSigning.get(
          observer.userId,
        ).user_signing_key;
        const request = structuredClone(requests[index].result);
        const body = JSON.parse(request.body);
        // One master key, signed once by the observer.
        expect(Object.values(body[bob.userId])).toHaveLength(1);
        for (const key of Object.values(body[bob.userId])) {
          const signatures = key.signatures[observer.userId];
          expect(Object.keys(signatures)).toHaveLength(1);
          for (const [id, genuine] of Object.entries(signatures)) {
            const forged = signWithSeed(key, strangerSeed);
            expect(validSignature(key, keys[id], genuine)).toBe(true);
            expect(validSignature(key, strangerKey, forged)).toBe(true);
            expect(validSignature(key, keys[id], forged)).toBe(false);
            signatures[id] = forged;
          }
        }
        request.body = JSON.stringify(body);
        await server.send(observer, request);
      }
      await query(server, observers, [bob.userId], 'query after the forgery');
      const identity = await both(observers, (it) =>
        it.getIdentity(bob.userId),
      );
      expectSame(identity, 'getIdentity with a forged signature', identityOf);
      expect(identity[0].result).toMatchObject({
        isVerified: false,
        wasPreviouslyVerified: false,
        hasVerificationViolation: false,
      });
      const found = await both(observers, (it) =>
        it.getDevice(bob.userId, bob.deviceId),
      );
      expectSame(found, 'getDevice of a user with a forged signature');
      expect(trust(found[0].result)).toEqual({
        ...UNTRUSTED,
        isCrossSignedByOwner: true,
      });
    },
  );

  covered(
    ['Device.isCrossSigningTrusted', 'Device.isCrossSignedByOwner'],
    "does not trust a device cross-signed by another user's self-signing key",
    async () => {
      const server = new Homeserver();
      const bob = await device('wasm');
      await server.flush(bob);
      await bootstrap(server, bob);
      // A second device of Bob that Bob never signed.
      const stray = await device('wasm', {
        userId: bob.userId,
        deviceId: `${bob.deviceId}C`,
      });
      await server.flush(stray);
      const carol = await device('wasm');
      await server.flush(carol);
      await bootstrap(server, carol);

      // Carol's self-signing key signs Bob's device: a valid signature by the wrong user.
      const exported = result(await carol.exportCrossSigningKeys());
      const [[carolKeyId, carolKey]] = Object.entries(
        server.crossSigning.get(carol.userId).self_signing_key.keys,
      );
      const strayKeys = server.deviceKeys.get(bob.userId)[stray.deviceId];
      const signature = signWithSeed(strayKeys, exported.self_signing_key);
      expect(validSignature(strayKeys, carolKey, signature)).toBe(true);
      strayKeys.signatures[carol.userId] = { [carolKeyId]: signature };

      const observers = [await device('native'), await device('wasm')];
      for (const observer of observers) {
        await join(server, observer, [bob.userId, carol.userId]);
        await bootstrap(server, observer);
      }
      await verifyUser(server, observers, bob.userId);
      await verifyUser(server, observers, carol.userId);

      const control = await both(observers, (it) =>
        it.getDevice(bob.userId, bob.deviceId),
      );
      expectSame(control, 'getDevice signed by its owner');
      expect(control[0].result.isCrossSigningTrusted).toBe(true);
      const foreign = await both(observers, (it) =>
        it.getDevice(bob.userId, stray.deviceId),
      );
      expectSame(foreign, "getDevice signed by another user's key");
      expect(trust(foreign[0].result)).toEqual({
        ...UNTRUSTED,
        isCrossSignedByOwner: false,
      });
    },
  );

  covered(
    ['OlmMachine.shareRoomKey', 'OlmMachine.getMissingSessions'],
    'maps deviceBasedStrategy onto the same devices as WASM',
    async () => {
      const server = new Homeserver();
      const bob = await device('wasm');
      await server.flush(bob);
      await bootstrap(server, bob);
      // Bob's second device, which Bob never signed: unverified once Bob is verified.
      const stray = await device('wasm', {
        userId: bob.userId,
        deviceId: `${bob.deviceId}C`,
      });
      await server.flush(stray);
      const observers = [await device('native'), await device('wasm')];
      for (const observer of observers) {
        await join(server, observer, [bob.userId]);
        await bootstrap(server, observer);
      }
      await verifyUser(server, observers, bob.userId);
      // One claim for both of Bob's devices: the request by shape (its ID is random).
      const claims = await each(observers, (it) =>
        it.getMissingSessions([bob.userId]),
      );
      expectSame(
        claims,
        'getMissingSessions for two devices',
        (request, index) => requestShape(request, observers[index]),
      );
      expect(
        Object.keys(
          JSON.parse(claims[0].body).one_time_keys[bob.userId],
        ).sort(),
      ).toEqual([bob.deviceId, stray.deviceId].sort());
      for (const [index, observer] of observers.entries()) {
        await server.send(observer, claims[index]);
      }

      // Which devices get the key and which a withheld notice, or the error.
      const recipients = (answer) =>
        answer.error
          ? { error: answer.error }
          : Object.fromEntries(
              answer.result.map(({ event_type: type, body }) => [
                type,
                Object.entries(JSON.parse(body).messages)
                  .flatMap(([user, devices]) =>
                    Object.keys(devices).map((id) => `${user} ${id}`),
                  )
                  .sort(),
              ]),
            );
      const all = `${bob.userId} ${bob.deviceId}`;
      const strayId = `${bob.userId} ${stray.deviceId}`;
      const expected = {
        allDevices: { 'm.room.encrypted': [all, strayId].sort() },
        onlyTrustedDevices: {
          'm.room.encrypted': [all],
          'm.room_key.withheld': [strayId],
        },
        // Bob is verified and has an unverified device.
        errorOnUnverifiedUserProblem: {
          error: {
            code: 'CryptoError',
            message:
              'encryption failed due to an error collecting the recipient devices: one or more verified users have unsigned devices',
          },
        },
      };
      for (const only of [false, true]) {
        for (const error of [false, true]) {
          const roomId = `!strategy-${only}-${error}:localhost`;
          // `{ result }` or `{ error }` on both sides, so an unknown strategy name cannot pass
          // for the refusal WASM gives.
          const shared = await each(observers, (it) =>
            it.kind === 'native'
              ? it.respond('shareRoomKey', {
                  roomId,
                  users: [bob.userId],
                  encryptionSettings: {
                    sharingStrategy: deviceBasedStrategy(only, error),
                  },
                })
              : fromWasm.response(() =>
                  it.shareRoomKey(
                    roomId,
                    [bob.userId],
                    wasm.CollectStrategy.deviceBasedStrategy(only, error),
                  ),
                ),
          );
          const step = `deviceBasedStrategy(${only}, ${error})`;
          expectSame(shared, step, recipients);
          expect(recipients(shared[0]), step).toEqual(
            expected[deviceBasedStrategy(only, error)],
          );
        }
      }
    },
  );
});
