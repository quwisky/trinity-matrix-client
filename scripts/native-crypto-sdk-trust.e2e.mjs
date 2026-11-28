/**
 * matrix-js-sdk's trust paths on the native crypto shim against a real homeserver: cross-signing,
 * user and device verification, local trust and blacklisting, secret storage, key backup, room
 * key export and import, identity resets, restarts, and a device replaced under its ID. Each
 * orientation puts the shim on one user's first device and on the other user's second device,
 * so every flow runs with the shim on both ends; the control runs them all on WASM.
 *
 * matrix-js-sdk has no non-interactive way to verify another user (only interactive
 * verification, which slice 4 brings to the shim): the bed signs the other identity with the
 * machine's own `OtherUserIdentity.verify()` and sends the request through js-sdk. The
 * stale-device case swaps the machine's `getDevice` for one answer, the device read before it
 * was replaced, because js-sdk's own read and use of it sit in one function.
 *
 * Needs cargo and Docker; see native-crypto-sdk-support.mjs.
 */
import { randomBytes } from 'node:crypto';
import * as wasm from '@matrix-org/matrix-sdk-crypto-wasm';
import {
  CrossSigningKey,
  CryptoEvent,
  ImportRoomKeyStage,
} from 'matrix-js-sdk/lib/crypto-api/index.js';
import {
  api,
  closeBed,
  decrypted,
  deleteDevice,
  encryptedRoom,
  joined,
  login,
  machineOf,
  missing,
  openBed,
  ORIENTATIONS,
  registerAndLogin,
  send,
  startClient,
  startParty,
  stopClient,
  uiaWith,
  undecryptable,
  until,
} from './native-crypto-sdk-support.mjs';

const crypto = (party) => party.client.getCrypto();
const other = (kind) => (kind === 'native' ? 'wasm' : 'native');

/** Queries every tracked user's keys again, as a device list change would. */
const refresh = async (party) => {
  await machineOf(party).markAllTrackedUsersAsDirty();
  await crypto(party).outgoingRequestsManager.doProcessOutgoingRequests();
};

/** Waits for `check`, querying keys again now and then. */
const eventually = (party, check, what, timeoutMs) => {
  let tries = 0;
  return until(
    async () => {
      const value = await check();
      if (!value && ++tries % 10 === 0) await refresh(party);
      return value;
    },
    what,
    timeoutMs,
  );
};

/** Secret storage callbacks holding one user's key (bootstrap caches it, the others read it). */
const storageOf = (secrets) => ({
  cryptoCallbacks: {
    getSecretStorageKey: async ({ keys }) =>
      secrets.privateKey && keys[secrets.keyId]
        ? [secrets.keyId, secrets.privateKey]
        : null,
    cacheSecretStorageKey: (keyId, _info, privateKey) => {
      secrets.keyId = keyId;
      secrets.privateKey = privateKey;
    },
  },
});

const userStatus = (viewer, subject) =>
  crypto(viewer).getUserVerificationStatus(subject.account.userId);
const deviceStatus = (viewer, subject) =>
  crypto(viewer).getDeviceVerificationStatus(
    subject.account.userId,
    subject.account.deviceId,
  );
const masterKeyId = async (party) =>
  crypto(party).getCrossSigningKeyId(CrossSigningKey.Master);
const onlyKey = (key) => Object.values(key.keys)[0];

const resetCrossSigning = async (party) => {
  await crypto(party).bootstrapCrossSigning({
    setupNewCrossSigning: true,
    authUploadDeviceSigningKeys: uiaWith(party.account),
  });
  // Let the key query this upload causes on the party's own sync finish first: upstream drops
  // private keys that differ from the identity a query answers, so a query from this reset
  // answered after a later one would wipe the newer keys.
  const syncs = party.network.syncs;
  await until(() => party.network.syncs >= syncs + 2, 'two more syncs');
  await refresh(party);
};

/**
 * The viewer verifies the subject's identity by signing it (`OtherUserIdentity.verify()`, on
 * the shim's stand-in or WASM's object) and sends the signature through js-sdk.
 */
const signIdentity = async (viewer, subject) => {
  const { userId } = subject.account;
  const identity = await machineOf(viewer).getIdentity(new wasm.UserId(userId));
  expect(identity).toBeInstanceOf(wasm.OtherUserIdentity);
  const request = await identity.verify();
  identity.free();
  expect(request).toBeInstanceOf(wasm.SignatureUploadRequest);
  await crypto(viewer).outgoingRequestProcessor.makeOutgoingRequest(request);
  await eventually(
    viewer,
    async () => (await userStatus(viewer, subject)).isCrossSigningVerified(),
    `${viewer.account.userId} to see ${userId} verified`,
  );
};

const backedUpSessions = async (party, version) =>
  (
    await api(
      `/_matrix/client/v3/room_keys/keys?version=${encodeURIComponent(version)}`,
      { token: party.account.accessToken },
    )
  ).rooms;

const sessionOf = (party, roomId, eventId) =>
  party.client
    .getRoom(roomId)
    .getLiveTimeline()
    .getEvents()
    .find((event) => event.getId() === eventId)
    .getWireContent().session_id;

const lastLoadKeys = (progress) =>
  progress
    .filter((update) => update.stage === ImportRoomKeyStage.LoadKeys)
    .at(-1);

describe.skipIf(missing)(
  'matrix-js-sdk trust paths on the native crypto shim',
  () => {
    let invocation;
    beforeAll(async () => {
      invocation = await openBed();
    });
    afterAll(() => closeBed(invocation));

    for (const [mode, orientations] of Object.entries(ORIENTATIONS)) {
      describe.each(orientations)(
        `${mode}: alice on %s, bob on %s`,
        (aliceKind, bobKind) => {
          const parties = {};
          const secrets = { alice: {}, bob: {} };
          const message = {};
          let roomId;
          const hasNative = mode === 'shim';
          const users = () => [
            [parties.alice, parties.bob],
            [parties.bob, parties.alice],
          ];

          afterAll(async () => {
            for (const party of Object.values(parties)) await stopClient(party);
          });

          it('bootstraps cross-signing on each side, and each sees the other identity', async () => {
            const kinds = { alice: aliceKind, bob: bobKind, carol: 'wasm' };
            for (const [name, kind] of Object.entries(kinds)) {
              parties[name] = await startParty(
                kind,
                await registerAndLogin(name),
                secrets[name] && storageOf(secrets[name]),
              );
            }
            const { alice, bob, carol } = parties;
            roomId = await encryptedRoom(alice, [bob, carol]);
            message.before = await send(alice, roomId, 'before cross-signing');
            for (const party of [bob, carol])
              await decrypted(
                party,
                roomId,
                message.before,
                'the first message',
              );

            for (const [party, otherParty] of users()) {
              expect(await crypto(party).userHasCrossSigningKeys()).toBe(false);
              expect(
                await crypto(party).getUserCrossSigningKeys(
                  otherParty.account.userId,
                ),
              ).toBeNull();
              expect(
                await machineOf(party).getIdentity(
                  new wasm.UserId(party.account.userId),
                ),
              ).toBeUndefined();
            }
            for (const [party] of users()) await resetCrossSigning(party);

            for (const [party, otherParty] of users()) {
              const own = crypto(party);
              expect(await own.isCrossSigningReady()).toBe(true);
              expect(await own.userHasCrossSigningKeys()).toBe(true);
              expect(await own.getCrossSigningStatus()).toEqual({
                publicKeysOnDevice: true,
                privateKeysInSecretStorage: false,
                privateKeysCachedLocally: {
                  masterKey: true,
                  selfSigningKey: true,
                  userSigningKey: true,
                },
              });
              expect(await masterKeyId(party)).toEqual(expect.any(String));
              const ownDevice = await deviceStatus(party, party);
              expect(ownDevice.crossSigningVerified).toBe(true);
              expect(ownDevice.signedByOwner).toBe(true);
              const ownIdentity = await machineOf(party).getIdentity(
                new wasm.UserId(party.account.userId),
              );
              expect(ownIdentity).toBeInstanceOf(wasm.OwnUserIdentity);
              expect(ownIdentity.isVerified()).toBe(true);
              expect(ownIdentity.__wbg_ptr === undefined).toBe(
                party.kind === 'native',
              );
              ownIdentity.free();

              // The other user's identity, as published.
              const theirMaster = await masterKeyId(otherParty);
              const keys = await eventually(
                party,
                async () => {
                  const found = await own.getUserCrossSigningKeys(
                    otherParty.account.userId,
                  );
                  return (
                    found && onlyKey(found.master_key) === theirMaster && found
                  );
                },
                `${party.account.userId} to see ${otherParty.account.userId}'s identity`,
              );
              expect(keys.user_signing_key).toBeUndefined();
              expect(onlyKey(keys.self_signing_key)).toBe(
                await crypto(otherParty).getCrossSigningKeyId(
                  CrossSigningKey.SelfSigning,
                ),
              );
              const identity = await machineOf(party).getIdentity(
                new wasm.UserId(otherParty.account.userId),
              );
              expect(identity).toBeInstanceOf(wasm.OtherUserIdentity);
              expect('userSigningKey' in identity).toBe(false);
              identity.free();
              const status = await userStatus(party, otherParty);
              expect(status.isCrossSigningVerified()).toBe(false);
              expect(status.wasCrossSigningVerified()).toBe(false);
              expect(status.needsUserApproval).toBe(false);
              const theirDevice = await eventually(
                party,
                async () => {
                  const found = await deviceStatus(party, otherParty);
                  return found?.signedByOwner && found;
                },
                `${party.account.userId} to see ${otherParty.account.userId}'s device signed`,
              );
              expect(theirDevice.crossSigningVerified).toBe(false);
              expect(theirDevice.isVerified()).toBe(false);
            }
          });

          it('verifies the other user by signing their identity, on both ends', async () => {
            for (const [viewer, subject] of users()) {
              const { userId } = subject.account;
              const trustChanged = new Promise((done) =>
                viewer.client.on(
                  CryptoEvent.UserTrustStatusChanged,
                  (user, status) => {
                    if (user === userId && status.isCrossSigningVerified())
                      done();
                  },
                ),
              );
              await signIdentity(viewer, subject);
              await trustChanged;
              const device = await deviceStatus(viewer, subject);
              expect(device.crossSigningVerified).toBe(true);
              expect(device.isVerified()).toBe(true);
              // The subject's master key carries the viewer's user-signing signature on the server.
              const viewerUsk = await crypto(viewer).getCrossSigningKeyId(
                CrossSigningKey.UserSigning,
              );
              const query = await api('/_matrix/client/v3/keys/query', {
                token: viewer.account.accessToken,
                method: 'POST',
                body: { device_keys: { [userId]: [] } },
              });
              expect(
                query.master_keys[userId].signatures[viewer.account.userId],
              ).toHaveProperty(`ed25519:${viewerUsk}`);
              // The subject still trusts itself, and sees the viewer as before.
              expect(await crypto(subject).isCrossSigningReady()).toBe(true);
            }
          });

          it('local trust and blacklisting decide which devices get room keys', async () => {
            const { carol } = parties;
            for (const [sender, receiver] of users()) {
              const own = crypto(sender);
              const { userId, deviceId } = carol.account;
              const status = () => deviceStatus(sender, carol);
              const sendAndRead = async (body, carolReads) => {
                await own.forceDiscardSession(roomId);
                const eventId = await send(sender, roomId, body);
                await decrypted(receiver, roomId, eventId, body);
                if (carolReads) await decrypted(carol, roomId, eventId, body);
                else await undecryptable(carol, roomId, eventId, body);
              };
              expect(await status()).toMatchObject({
                localVerified: false,
                crossSigningVerified: false,
              });
              expect((await status()).isVerified()).toBe(false);

              await own.setDeviceBlocked(userId, deviceId, true);
              expect((await status()).blocked).toBe(true);
              await sendAndRead(`blocked by ${sender.account.userId}`, false);
              await own.setDeviceBlocked(userId, deviceId, false);
              expect((await status()).blocked).toBe(false);
              await sendAndRead(`unblocked by ${sender.account.userId}`, true);

              own.globalBlacklistUnverifiedDevices = true;
              try {
                await sendAndRead(
                  `only verified, by ${sender.account.userId}`,
                  false,
                );
                await own.setDeviceVerified(userId, deviceId, true);
                expect((await status()).localVerified).toBe(true);
                expect((await status()).isVerified()).toBe(true);
                await sendAndRead(`verified by ${sender.account.userId}`, true);
              } finally {
                own.globalBlacklistUnverifiedDevices = false;
              }
              await own.setDeviceVerified(userId, deviceId, false);
              expect((await status()).localVerified).toBe(false);

              // Read after write on the same object: WASM's Device shows its own change at
              // once, and so must the stand-in (each sender is on the other kind in shim mode).
              const held = await machineOf(sender).getDevice(
                new wasm.UserId(userId),
                new wasm.DeviceId(deviceId),
              );
              const seen = [];
              for (const trust of [
                wasm.LocalTrust.BlackListed,
                wasm.LocalTrust.Verified,
                wasm.LocalTrust.Unset,
              ]) {
                await held.setLocalTrust(trust);
                seen.push([
                  held.localTrustState,
                  held.isBlacklisted(),
                  held.isLocallyTrusted(),
                  held.isVerified(),
                ]);
              }
              held.free();
              expect(seen).toEqual([
                [wasm.LocalTrust.BlackListed, true, false, false],
                [wasm.LocalTrust.Verified, false, true, true],
                [wasm.LocalTrust.Unset, false, false, false],
              ]);
            }
          }, 180_000);

          it('sets up secret storage and a key backup that each side trusts', async () => {
            for (const [party] of users()) {
              const own = crypto(party);
              await own.bootstrapSecretStorage({
                createSecretStorageKey: () =>
                  own.createRecoveryKeyFromPassphrase(),
                setupNewKeyBackup: true,
              });
              const info = await own.getKeyBackupInfo();
              expect(info?.version).toEqual(expect.any(String));
              expect(await own.isKeyBackupTrusted(info)).toEqual({
                trusted: true,
                matchesDecryptionKey: true,
              });
              await until(
                async () =>
                  (await own.getActiveSessionBackupVersion()) === info.version,
                'the backup to be active',
              );
              expect(await own.getSessionBackupPrivateKey()).toHaveLength(32);
              expect(
                (await own.getCrossSigningStatus()).privateKeysInSecretStorage,
              ).toBe(true);
              const session = sessionOf(party, roomId, message.before);
              await until(
                async () =>
                  (await backedUpSessions(party, info.version))[roomId]
                    ?.sessions?.[session],
                'the first room key in the backup',
                60_000,
              );
            }
          }, 120_000);

          it("imports one device's room keys on the user's second device, with progress", async () => {
            for (const name of ['alice', 'bob']) {
              const first = parties[name];
              const { version } = await crypto(first).getKeyBackupInfo();
              const second = await startParty(
                hasNative ? other(first.kind) : 'wasm',
                await login(first.account),
                storageOf(secrets[name]),
              );
              parties[`${name}2`] = second;
              await until(
                () => second.client.getRoom(roomId),
                'the room on the second device',
              );
              await undecryptable(
                second,
                roomId,
                message.before,
                'a message from before it',
              );

              const json = await crypto(first).exportRoomKeysAsJson();
              const exported = JSON.parse(json);
              expect(exported.length).toBeGreaterThan(0);
              // As a backup restore hands them over, with one session that does not parse.
              const backedUp = [];
              await crypto(second).importBackedUpRoomKeys(
                [
                  ...exported,
                  { room_id: roomId, session_id: 'broken', algorithm: 'nope' },
                ],
                version,
                { progressCallback: (update) => backedUp.push(update) },
              );
              // The final update only (native replays the listener's last call): WASM reports
              // the index of the last valid key, valid plus failed keys, and the failures.
              expect(lastLoadKeys(backedUp)).toEqual({
                stage: ImportRoomKeyStage.LoadKeys,
                successes: exported.length - 1,
                total: exported.length + 1,
                failures: 1,
              });
              await decrypted(
                second,
                roomId,
                message.before,
                'the imported key',
              );

              const fromExport = [];
              await crypto(second).importRoomKeysAsJson(json, {
                progressCallback: (update) => fromExport.push(update),
              });
              expect(lastLoadKeys(fromExport)).toEqual({
                stage: ImportRoomKeyStage.LoadKeys,
                successes: exported.length - 1,
                total: exported.length,
                failures: 0,
              });
            }
          }, 120_000);

          it('trusts the backup on the second device once it imports cross-signing; a wrong key is refused, the right one restores', async () => {
            for (const name of ['alice', 'bob']) {
              const first = parties[name];
              const second = parties[`${name}2`];
              const own = crypto(second);
              const info = await own.getKeyBackupInfo();
              expect((await own.isKeyBackupTrusted(info)).trusted).toBe(false);
              expect(await own.isCrossSigningReady()).toBe(false);
              expect(await own.getCrossSigningStatus()).toMatchObject({
                publicKeysOnDevice: true,
                privateKeysInSecretStorage: true,
                privateKeysCachedLocally: {
                  masterKey: false,
                  selfSigningKey: false,
                  userSigningKey: false,
                },
              });
              const unsigned = await eventually(
                first,
                () => deviceStatus(first, second),
                `${name}'s first device to see the second`,
              );
              expect(unsigned.signedByOwner).toBe(false);

              // A message only the backup holds the key for.
              second.network.holding = true;
              await crypto(first).forceDiscardSession(roomId);
              message[name] = await send(first, roomId, `backed up by ${name}`);
              await undecryptable(
                second,
                roomId,
                message[name],
                'a message whose key is held back',
              );
              const session = sessionOf(first, roomId, message[name]);
              await until(
                async () =>
                  (await backedUpSessions(first, info.version))[roomId]
                    ?.sessions?.[session],
                'the new room key in the backup',
                60_000,
              );

              await own.storeSessionBackupPrivateKey(
                randomBytes(32),
                info.version,
              );
              await expect(own.restoreKeyBackup()).rejects.toThrow(
                /does not match/,
              );

              await own.bootstrapCrossSigning({
                authUploadDeviceSigningKeys: uiaWith(second.account),
              });
              expect(await own.isCrossSigningReady()).toBe(true);
              // Imported, not reset: the first device's identity.
              expect(await masterKeyId(second)).toBe(await masterKeyId(first));
              await eventually(
                second,
                async () =>
                  (await deviceStatus(second, second)).crossSigningVerified,
                `${name}'s second device to see itself signed`,
              );
              expect(
                (await deviceStatus(second, first)).crossSigningVerified,
              ).toBe(true);
              await eventually(
                first,
                async () =>
                  (await deviceStatus(first, second))?.crossSigningVerified,
                `${name}'s first device to see the second signed`,
              );
              expect(await own.isKeyBackupTrusted(info)).toEqual({
                trusted: true,
                matchesDecryptionKey: false,
              });

              await own.loadSessionBackupPrivateKeyFromSecretStorage();
              expect(
                (await own.isKeyBackupTrusted(info)).matchesDecryptionKey,
              ).toBe(true);
              const progress = [];
              const restored = await own.restoreKeyBackup({
                progressCallback: (update) => progress.push(update),
              });
              expect(restored.total).toBeGreaterThan(0);
              expect(progress[0]).toEqual({ stage: ImportRoomKeyStage.Fetch });
              expect(lastLoadKeys(progress)).toMatchObject({
                successes: restored.total,
                total: restored.total,
                failures: 0,
              });
              await decrypted(
                second,
                roomId,
                message[name],
                'the restored key',
              );
              second.network.holding = false;
            }
          }, 240_000);

          it.skipIf(!hasNative)(
            'restarts the native devices on the same store with cross-signing and backup intact',
            async () => {
              for (const name of ['alice', 'bob', 'alice2', 'bob2']) {
                const party = parties[name];
                if (party.kind !== 'native') continue;
                const before = {
                  masterKey: await masterKeyId(party),
                  backup: await crypto(party).getSessionBackupPrivateKey(),
                  version: await crypto(party).getActiveSessionBackupVersion(),
                };
                await stopClient(party);
                const again = await startClient('native', party.account, {
                  storeKey: party.storeKey,
                  clientOptions: party.clientOptions,
                });
                parties[name] = again;
                const own = crypto(again);
                expect(await own.isCrossSigningReady()).toBe(true);
                expect(await masterKeyId(again)).toBe(before.masterKey);
                expect(await own.getSessionBackupPrivateKey()).toEqual(
                  before.backup,
                );
                await until(
                  async () =>
                    (await own.getActiveSessionBackupVersion()) ===
                    before.version,
                  'the backup to be active again',
                );
                if (name === 'alice' || name === 'bob') {
                  const otherUser = parties[name === 'alice' ? 'bob' : 'alice'];
                  expect(
                    (
                      await userStatus(again, otherUser)
                    ).isCrossSigningVerified(),
                  ).toBe(true);
                }
              }
            },
            180_000,
          );

          it('reports a reset identity as a violation; withdrawing and pinning approve it', async () => {
            for (const [viewer, subject] of users()) {
              const { userId } = subject.account;
              const own = crypto(viewer);
              // A reset of the viewer's own identity (the previous round) drops its signatures.
              await signIdentity(viewer, subject);
              const held = await machineOf(viewer).getIdentity(
                new wasm.UserId(userId),
              );

              const oldMaster = await masterKeyId(subject);
              await resetCrossSigning(subject);
              expect(await crypto(subject).isCrossSigningReady()).toBe(true);
              expect(await masterKeyId(subject)).not.toBe(oldMaster);
              const violation = await eventually(
                viewer,
                async () => {
                  const status = await userStatus(viewer, subject);
                  return status.needsUserApproval && status;
                },
                `${viewer.account.userId} to see ${userId}'s reset`,
              );
              expect(violation.isCrossSigningVerified()).toBe(false);
              expect(violation.wasCrossSigningVerified()).toBe(true);

              if (viewer.kind === 'native') {
                // The identity read before the reset: refused, and nothing changes.
                await expect(held.withdrawVerification()).rejects.toMatchObject(
                  {
                    code: 'StaleObject',
                  },
                );
                await expect(held.pinCurrentMasterKey()).rejects.toMatchObject({
                  code: 'StaleObject',
                });
                expect(
                  (await userStatus(viewer, subject)).needsUserApproval,
                ).toBe(true);
              }
              held.free();

              // Read after write on the same object, as WASM's object answers it.
              const live = await machineOf(viewer).getIdentity(
                new wasm.UserId(userId),
              );
              expect(live.wasPreviouslyVerified()).toBe(true);
              await live.withdrawVerification();
              expect(live.wasPreviouslyVerified()).toBe(false);
              expect(live.identityNeedsUserApproval()).toBe(false);
              live.free();
              // And through matrix-js-sdk (nothing left to withdraw).
              await own.withdrawVerificationRequirement(userId);
              const withdrawn = await userStatus(viewer, subject);
              expect(withdrawn.wasCrossSigningVerified()).toBe(false);
              expect(withdrawn.needsUserApproval).toBe(false);

              await resetCrossSigning(subject);
              await eventually(
                viewer,
                async () =>
                  (await userStatus(viewer, subject)).needsUserApproval,
                `${viewer.account.userId} to see ${userId}'s second reset`,
              );
              await expect(
                own.pinCurrentUserIdentity(viewer.account.userId),
              ).rejects.toThrow(/own user/);
              const changed = await machineOf(viewer).getIdentity(
                new wasm.UserId(userId),
              );
              expect(changed.identityNeedsUserApproval()).toBe(true);
              await changed.pinCurrentMasterKey();
              expect(changed.identityNeedsUserApproval()).toBe(false);
              changed.free();
              await own.pinCurrentUserIdentity(userId);
              const pinned = await userStatus(viewer, subject);
              expect(pinned.needsUserApproval).toBe(false);
              expect(pinned.isCrossSigningVerified()).toBe(false);
            }
          }, 180_000);

          it.skipIf(!hasNative)(
            'refuses to trust a device replaced under its ID after it was read',
            async () => {
              const viewer = [parties.alice, parties.bob].find(
                (party) => party.kind === 'native',
              );
              const dave = await startParty(
                'wasm',
                await registerAndLogin('dave'),
              );
              // Carol (WASM, not cross-signed) invites: a cross-signed inviter shares room history
              // (MSC4268 key bundles), which the shim leaves to slice 4.
              await parties.carol.client.invite(roomId, dave.account.userId);
              await until(
                () => dave.client.getRoom(roomId),
                'dave to get the invite',
              );
              await dave.client.joinRoom(roomId);
              await joined(viewer, roomId, dave.account.userId);
              const { userId, deviceId } = dave.account;
              const ids = () => [
                new wasm.UserId(userId),
                new wasm.DeviceId(deviceId),
              ];
              const machine = machineOf(viewer);
              const held = await eventually(
                viewer,
                () => machine.getDevice(...ids()),
                "the viewer to know dave's device",
              );
              expect(held).toBeInstanceOf(wasm.Device);
              const heldKey = [...held.keys]
                .find(([id]) => id.toString() === `ed25519:${deviceId}`)[1]
                .toBase64();

              // Dave logs in again under the same device ID, with new keys.
              await stopClient(dave);
              await deleteDevice(dave.account, deviceId);
              const daveAgain = await startParty(
                'wasm',
                await login(dave.account, deviceId),
              );
              parties.dave = daveAgain;
              const newKey = (await crypto(daveAgain).getOwnDeviceKeys())
                .ed25519;
              expect(newKey).not.toBe(heldKey);
              await eventually(
                viewer,
                async () =>
                  (await crypto(viewer).getUserDeviceInfo([userId]))
                    .get(userId)
                    ?.get(deviceId)
                    ?.getFingerprint() === newKey,
                "the viewer to see dave's new device keys",
              );

              // js-sdk reads the device and acts on it at once; this read answers the old one.
              machine.getDevice = async () => held;
              try {
                await expect(
                  crypto(viewer).setDeviceVerified(userId, deviceId, true),
                ).rejects.toMatchObject({ code: 'StaleObject' });
                await expect(
                  crypto(viewer).setDeviceBlocked(userId, deviceId, true),
                ).rejects.toMatchObject({ code: 'StaleObject' });
                await expect(
                  crypto(viewer).crossSignDevice(deviceId),
                ).rejects.toMatchObject({
                  code: 'StaleObject',
                });
              } finally {
                delete machine.getDevice;
              }
              await expect(held.verify()).rejects.toMatchObject({
                code: 'StaleObject',
              });
              await expect(
                held.encryptToDeviceEvent('m.test', { body: 'never' }),
              ).rejects.toMatchObject({ code: 'StaleObject' });

              const status = await crypto(viewer).getDeviceVerificationStatus(
                userId,
                deviceId,
              );
              expect(status).toMatchObject({
                localVerified: false,
                blocked: false,
              });
              expect(status.isVerified()).toBe(false);
              // The device as it is now can be trusted: the refusal was the stale read.
              await crypto(viewer).setDeviceVerified(userId, deviceId, true);
              expect(
                (
                  await crypto(viewer).getDeviceVerificationStatus(
                    userId,
                    deviceId,
                  )
                ).localVerified,
              ).toBe(true);
            },
            120_000,
          );
        },
      );
    }
  },
);
