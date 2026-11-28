/**
 * Secrets, room key bundles (history sharing), dehydrated devices and the remaining machine
 * calls: each step runs on a native and a WASM device and both must answer the same, by value;
 * fresh keys, IDs and ciphertext by shape, as each case says. Where two parties take part, the
 * cases run in both mixed pairings (a WASM sender with a native receiver, and the reverse), and
 * the step compared is the one both receivers (or both senders) take.
 */
import * as wasm from '@matrix-org/matrix-sdk-crypto-wasm';
import {
  Homeserver,
  anonymise,
  both,
  covered,
  each,
  expectSame,
  hasCargo,
  roomEvent,
  shape,
  shareRoom,
  skipped,
  useDevices,
} from './native-crypto-harness.mjs';

const { LocalTrust, HistoryVisibility, RequestType } = wasm;
const BACKUP_SECRET = 'm.megolm_backup.v1';

const result = (response) => {
  expect(response.error).toBeUndefined();
  return response.result;
};

const ofType = (polled, type) =>
  polled.result.events.filter((event) => event.type === type);

/** Base64 keys (fresh on each side) in JSON keys, such as `ed25519:<key>`. */
const freshKeys = (name) => name.replace(/[A-Za-z0-9+/]{43}/g, '<key>');

/** Replaces `device`'s IDs and keys in `value` with `<label…>` placeholders. */
const named = (value, device, label) =>
  JSON.parse(
    JSON.stringify(value)
      .replaceAll(device.userId, `<${label}>`)
      .replaceAll(device.deviceId, `<${label} device>`)
      .replaceAll(device.identityKeys.ed25519, `<${label} ed25519>`)
      .replaceAll(device.identityKeys.curve25519, `<${label} curve25519>`),
  );

/** Uploads every device's keys first, then has each track `users` and fetch their keys. */
const meet = async (server, devices, users) => {
  for (const it of devices) await server.flush(it);
  for (const it of devices) {
    await it.updateTrackedUsers(users);
    await server.flush(it);
    await fetchKeys(server, it, users);
  }
};

/** Creates and uploads `device`'s cross-signing keys and signs its device with them. */
const bootstrap = async (server, device) => {
  const requests = result(await device.bootstrapCrossSigning(true));
  if (requests.uploadKeysRequest) {
    await server.send(device, requests.uploadKeysRequest);
  }
  server.uploadSigningKeys(device, requests.uploadSigningKeysRequest);
  await server.send(device, requests.uploadSignaturesRequest);
};

/** `/keys/query` for `users` now (setup). */
const fetchKeys = async (server, device, users) =>
  server.send(device, result(await device.queryKeysForUsers(users)));

/** Olm sessions from `device` to every device of `users` (setup). */
const claimSessions = async (server, device, users) => {
  const claim = await device.getMissingSessions(users);
  if (claim) await server.send(device, claim);
};

/** A sync's answer with `content.secret` taken out of each decrypted secret event. */
const withoutSecret = (answer) =>
  answer.map((event) => {
    if (!event.rawEvent) return event;
    const raw = JSON.parse(event.rawEvent);
    if (raw.content) delete raw.content.secret;
    return { ...event, rawEvent: raw };
  });

/** The types of the events a sync returned, in order. */
const syncedTypes = (answer) =>
  (answer.result ?? answer).map(({ type, rawEvent }) => [
    type,
    rawEvent && JSON.parse(rawEvent).type,
  ]);

describe.skipIf(!hasCargo)(
  `native crypto secrets, bundles and dehydration with WASM${skipped}`,
  () => {
    const device = useDevices();
    let next = 0;
    /** A second device of `of`'s user. */
    const sibling = (kind, of) =>
      device(kind, {
        userId: of.userId,
        deviceId: `${kind.toUpperCase()}SIBLING${next++}`,
      });

    /**
     * Two own-device pairs: a WASM sender with a native receiver and a native sender with a
     * WASM receiver, all knowing their own user's devices and the sender holding the backup
     * key. `trusted` is whether each receiver trusts its sender (each sender trusts its
     * receiver). A third own device of the other kind, which the sender does not trust, has an
     * Olm session too. Returned in native-first order for `both`.
     */
    const ownPairs = async (server, backupKey, trusted) => {
      const pair = async (senderKind, receiverKind) => {
        const sender = await device(senderKind);
        const receiver = await sibling(receiverKind, sender);
        const bystander = await sibling(senderKind, sender);
        await meet(server, [sender, receiver, bystander], [sender.userId]);
        result(await sender.saveBackupDecryptionKey(backupKey, '1'));
        result(
          await sender.setLocalTrust(
            receiver.userId,
            receiver.deviceId,
            LocalTrust.Verified,
          ),
        );
        if (trusted) {
          result(
            await receiver.setLocalTrust(
              sender.userId,
              sender.deviceId,
              LocalTrust.Verified,
            ),
          );
        }
        await claimSessions(server, sender, [sender.userId]);
        return { sender, receiver, bystander };
      };
      const toNative = await pair('wasm', 'native');
      const toWasm = await pair('native', 'wasm');
      return {
        senders: [toWasm.sender, toNative.sender],
        receivers: [toNative.receiver, toWasm.receiver],
        bystanders: [toWasm.bystander, toNative.bystander],
      };
    };

    /** Each sender pushes the backup key; each receiver syncs. */
    const push = async (server, { senders, receivers, bystanders }) => {
      const pushed = await both(senders, (it) =>
        it.pushSecretToVerifiedDevices(BACKUP_SECRET),
      );
      expectSame(pushed, 'pushSecretToVerifiedDevices');
      expect(pushed[0]).toEqual({ result: null });
      // Only the verified own device is sent the secret, not the untrusted third one.
      const outgoing = await each(senders, (it) => it.outgoingRequests());
      const recipients = (requests, index) => {
        const label = {
          [receivers[1 - index].deviceId]: 'receiver',
          [bystanders[index].deviceId]: 'bystander',
        };
        return requests
          .filter(({ type }) => type === RequestType.ToDevice)
          .flatMap(({ body }) =>
            Object.values(JSON.parse(body).messages).flatMap((devices) =>
              Object.keys(devices).map((id) => label[id] ?? id),
            ),
          );
      };
      expectSame(outgoing, 'push recipients', recipients);
      expect(recipients(outgoing[0], 0)).toEqual(['receiver']);
      for (const sender of senders) await server.flush(sender);
      const untrusted = await both(bystanders, (it) => server.sync(it));
      expectSame(untrusted, 'the untrusted own device gets nothing');
      expect(untrusted[0]).toEqual([]);
      const synced = await both(receivers, (it) => server.sync(it));
      // Each receiver got its own sender's push, signatures fresh; the crate leaves out the value.
      expectSame(synced, 'sync the push', (answer, index) =>
        JSON.parse(
          JSON.stringify(
            named(withoutSecret(answer), senders[1 - index], 'sender'),
          ).replace(/[A-Za-z0-9+/]{86}/g, '<signature>'),
        ),
      );
      return synced;
    };

    covered(
      [
        'OlmMachine.pushSecretToVerifiedDevices',
        'OlmMachine.registerReceiveSecretCallback',
        'OlmMachine.getSecretsFromInbox',
        'OlmMachine.deleteSecretsFromInbox',
      ],
      'takes a secret pushed by a verified own device into the inbox, in both pairings',
      async () => {
        const server = new Homeserver();
        const backupKey = wasm.BackupDecryptionKey.createRandomKey().toBase64();
        const pairs = await ownPairs(server, backupKey, true);
        const synced = await push(server, pairs);
        expect(syncedTypes(synced[0])).toEqual([
          [
            wasm.ProcessedToDeviceEventType.Decrypted,
            'io.element.msc4385.secret.push',
          ],
        ]);
        const { receivers } = pairs;
        // Unlike WASM's, the crate's decrypted push has no `content.secret`; the rest is equal.
        expect(
          synced.map((answer) => JSON.stringify(answer).includes(backupKey)),
        ).toEqual([false, true]);
        expect(JSON.parse(synced[0][0].rawEvent).content).toEqual({
          name: BACKUP_SECRET,
        });

        // The event names the secret only; WASM's callback also gets the value.
        const polled = await both(receivers, (it) => it.pollEvents());
        expectSame(polled, 'secretReceived', (answer) =>
          ofType(answer, 'secretReceived'),
        );
        expect(ofType(polled[0], 'secretReceived')).toEqual([
          { type: 'secretReceived', name: BACKUP_SECRET },
        ]);
        expect(JSON.stringify(polled[0])).not.toContain(backupKey);
        expect(receivers[1].secretValues).toEqual([backupKey]);

        const inbox = await both(receivers, (it) =>
          it.getSecretsFromInbox(BACKUP_SECRET),
        );
        expectSame(inbox, 'getSecretsFromInbox');
        expect(inbox[0]).toEqual({ result: [backupKey] });
        expectSame(
          await both(receivers, (it) => it.getSecretsFromInbox('m.other')),
          'getSecretsFromInbox of another name',
        );
        const deleted = await both(receivers, (it) =>
          it.deleteSecretsFromInbox(BACKUP_SECRET),
        );
        expectSame(deleted, 'deleteSecretsFromInbox');
        expect(deleted[0]).toEqual({ result: null });
        const emptied = await both(receivers, (it) =>
          it.getSecretsFromInbox(BACKUP_SECRET),
        );
        expectSame(emptied, 'getSecretsFromInbox after delete');
        expect(emptied[0]).toEqual({ result: [] });
      },
    );

    covered(
      [
        'OlmMachine.pushSecretToVerifiedDevices',
        'OlmMachine.getSecretsFromInbox',
      ],
      'ignores a secret pushed by an unverified own device, and refuses to push a missing one',
      async () => {
        const server = new Homeserver();
        const backupKey = wasm.BackupDecryptionKey.createRandomKey().toBase64();
        const pairs = await ownPairs(server, backupKey, false);
        await push(server, pairs);
        const { receivers } = pairs;
        const polled = await both(receivers, (it) => it.pollEvents());
        expectSame(polled, 'no secretReceived', (answer) =>
          ofType(answer, 'secretReceived'),
        );
        expect(ofType(polled[0], 'secretReceived')).toEqual([]);
        const inbox = await both(receivers, (it) =>
          it.getSecretsFromInbox(BACKUP_SECRET),
        );
        expectSame(inbox, 'getSecretsFromInbox');
        expect(inbox[0]).toEqual({ result: [] });
        expect(receivers[1].secretValues).toEqual([]);

        // A device without the backup key has nothing to push.
        const missing = await both(receivers, (it) =>
          it.pushSecretToVerifiedDevices(BACKUP_SECRET),
        );
        expectSame(missing, 'push a secret the device does not have');
        expect(missing[0].error.code).toBe('CryptoError');
      },
    );

    covered(
      ['OlmMachine.exportSecretsBundle', 'OlmMachine.importSecretsBundle'],
      'exports a secrets bundle the other side imports into the same cross-signing and backup state',
      async () => {
        const server = new Homeserver();
        const backupKey = wasm.BackupDecryptionKey.createRandomKey().toBase64();
        const exporters = [await device('native'), await device('wasm')];

        const early = await both(exporters, (it) => it.exportSecretsBundle());
        expectSame(early, 'exportSecretsBundle without cross-signing keys');
        expect(early[0].error.code).toBe('CryptoError');

        for (const it of exporters) {
          await server.flush(it);
          await bootstrap(server, it);
        }
        // Without a backup key the bundle has no backup part.
        const noBackup = await both(exporters, (it) =>
          it.exportSecretsBundle(),
        );
        expectSame(noBackup, 'exportSecretsBundle without a backup key', (a) =>
          shape(a),
        );
        for (const it of exporters) {
          result(await it.saveBackupDecryptionKey(backupKey, '1'));
        }
        const bundles = await each(exporters, (it) => it.exportSecretsBundle());
        // Each side's own cross-signing seeds (fresh) by shape, the shared backup key by value.
        expectSame(bundles, 'exportSecretsBundle', (answer) => shape(answer));
        expectSame(bundles, 'exportSecretsBundle backup', (answer) =>
          defined(answer.result.backup),
        );
        expect(bundles[0].result.backup).toEqual({
          algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
          key: backupKey,
          backup_version: '1',
        });
        // The seeds are the ones exportCrossSigningKeys gives.
        for (const [index, it] of exporters.entries()) {
          const keys = result(await it.exportCrossSigningKeys());
          expect(bundles[index].result.cross_signing).toEqual({
            master_key: keys.masterKey,
            self_signing_key: keys.self_signing_key,
            user_signing_key: keys.userSigningKey,
          });
        }

        // Each importer is a new device of the other side's user.
        const importers = [
          await sibling('native', exporters[1]),
          await sibling('wasm', exporters[0]),
        ];
        const crossed = [bundles[1].result, bundles[0].result];
        expectSame(
          await both(importers, (it) => it.crossSigningStatus()),
          'crossSigningStatus before import',
        );
        const imported = await both(importers, (it) =>
          it.importSecretsBundle(crossed[importers.indexOf(it)]),
        );
        expectSame(imported, 'importSecretsBundle');
        expect(imported[0]).toEqual({ result: null });
        const status = await both(importers, (it) => it.crossSigningStatus());
        expectSame(status, 'crossSigningStatus after import');
        expect(status[0].result).toEqual({
          hasMaster: true,
          hasSelfSigning: true,
          hasUserSigning: true,
        });
        const backup = await both(importers, (it) => it.getBackupKeys());
        expectSame(backup, 'getBackupKeys after import');
        expect(backup[0].result).toEqual({
          decryptionKeyBase64: backupKey,
          backupVersion: '1',
        });
        // The importer now exports exactly the bundle it was given.
        const again = await both(importers, (it) => it.exportSecretsBundle());
        expectSame(again, 'exportSecretsBundle after import', (answer, index) =>
          equalTo(answer.result, crossed[index]),
        );
        expect(again[0].result).toEqual(crossed[0]);
      },
    );

    covered(
      [
        'DehydratedDevices.getDehydratedDeviceKey',
        'DehydratedDevices.saveDehydratedDeviceKey',
        'DehydratedDevice.keysForUpload',
        'DehydratedDevices.rehydrate',
        'RehydratedDevice.receiveEvents',
        'RehydratedDevice.free',
      ],
      'creates a dehydrated device the other side rehydrates to collect its room keys, in both pairings',
      async () => {
        const server = new Homeserver();
        const key = wasm.DehydratedDeviceKey.createRandomKey().toBase64();
        const wrongKey = wasm.DehydratedDeviceKey.createRandomKey().toBase64();
        const creators = [await device('native'), await device('wasm')];
        const step = async (devices, name, run) => {
          const answers = await both(devices, run);
          expectSame(answers, name);
          return answers[0];
        };

        expect(
          await step(creators, 'getDehydratedDeviceKey before save', (it) =>
            it.getDehydratedDeviceKey(),
          ),
        ).toEqual({ result: null });
        await step(creators, 'saveDehydratedDeviceKey', (it) =>
          it.saveDehydratedDeviceKey(key),
        );
        expect(
          await step(creators, 'getDehydratedDeviceKey', (it) =>
            it.getDehydratedDeviceKey(),
          ),
        ).toEqual({ result: key });

        // The device keys are signed with the self-signing key, so cross-signing comes first.
        const unsigned = await step(
          creators,
          'createDehydratedDevice without cross-signing',
          (it) => it.createDehydratedDevice('Dehydrated device', key),
        );
        expect(unsigned.error.code).toBe('CryptoError');
        for (const it of creators) {
          await server.flush(it);
          await bootstrap(server, it);
        }
        const created = await each(creators, (it) =>
          it.createDehydratedDevice('Dehydrated device', key),
        );
        // A new device each time: its ID, keys and pickle by shape.
        expectSame(created, 'createDehydratedDevice', (answer, index) => {
          const body = JSON.parse(answer.result.body);
          return {
            ...shape(named(body, creators[index], 'creator'), freshKeys),
            initial_device_display_name: body.initial_device_display_name,
            dehydrated: body.device_keys.dehydrated,
          };
        });
        const ids = creators.map((it, index) =>
          server.putDehydratedDevice(it, result(created[index])),
        );
        expect(JSON.parse(created[0].result.body)).toMatchObject({
          initial_device_display_name: 'Dehydrated device',
          device_keys: { dehydrated: true },
        });

        // A WASM user shares a room key with both users, dehydrated devices included.
        const roomId = '!dehydrated:localhost';
        const alice = await device('wasm');
        const users = [alice.userId, ...creators.map(({ userId }) => userId)];
        await meet(server, [alice], users);
        await claimSessions(server, alice, users.slice(1));
        for (const share of await alice.shareRoomKey(roomId, users)) {
          await server.send(alice, share);
        }
        const event = roomEvent(
          alice,
          roomId,
          await alice.encryptRoomEvent(roomId, 'm.room.message', '{}'),
        );

        // Each rehydrator is a device of the other side's user.
        const rehydrators = [
          await sibling('native', creators[1]),
          await sibling('wasm', creators[0]),
        ];
        const lane = (it) => 1 - rehydrators.indexOf(it);
        const deviceData = (it) =>
          JSON.stringify(
            server.dehydrated.get(creators[lane(it)].userId).device_data,
          );
        const keysBefore = await each(rehydrators, (it) => it.exportRoomKeys());

        const wrong = await step(
          rehydrators,
          'rehydrate with the wrong key',
          (it) => it.rehydrateDevice(wrongKey, ids[lane(it)], deviceData(it)),
        );
        expect(wrong.error.code).toBe('CryptoError');
        expect(
          await step(rehydrators, 'rehydrateDevice', (it) =>
            it.rehydrateDevice(key, ids[lane(it)], deviceData(it)),
          ),
        ).toEqual({ result: null });
        const toDevice = rehydrators.map((it) =>
          JSON.stringify(server.take(it.userId, ids[lane(it)])),
        );
        const received = await both(rehydrators, (it) =>
          it.receiveRehydratedEvents(
            ids[lane(it)],
            toDevice[rehydrators.indexOf(it)],
          ),
        );
        // Alice's one session reached both dehydrated devices: compared by value.
        expectSame(received, 'receiveEvents');
        expect(received[0].result).toHaveLength(1);
        expect(received[0].result[0]).toMatchObject({
          roomId,
          senderKey: alice.identityKeys.curve25519,
        });
        expectSame(
          await both(rehydrators, (it) => it.pollEvents()),
          'roomKeysReceived after rehydration',
          (answer) => ofType(answer, 'roomKeysReceived'),
        );
        const decrypted = await both(rehydrators, (it) =>
          it.decryptRoomEvent(event, roomId),
        );
        expectSame(decrypted, 'decrypt with the rehydrated keys');
        expect(decrypted[0].result.sender).toBe(alice.userId);
        expect(
          await step(rehydrators, 'free the rehydrated device', (it) =>
            it.dropRehydratedDevice(ids[lane(it)]),
          ),
        ).toEqual({ result: null });

        // The rehydrators kept their own identity; only the room key entered their stores.
        expect(result(await rehydrators[0].respond('identityKeys'))).toEqual(
          rehydrators[0].identityKeys,
        );
        expect(rehydrators[1].machine.identityKeys.ed25519.toBase64()).toBe(
          rehydrators[1].identityKeys.ed25519,
        );
        for (const [index, it] of rehydrators.entries()) {
          expect(JSON.parse(result(keysBefore[index]))).toEqual([]);
          const after = JSON.parse(result(await it.exportRoomKeys()));
          expect(after.map(({ room_id: room }) => room)).toEqual([roomId]);
        }

        // A freed device cannot take more events. WASM's freed object cannot be called at all
        // (matrix-js-sdk never does), so only native is asked.
        const late = await rehydrators[0].receiveRehydratedEvents(ids[1], '[]');
        expect(late.error.code).toBe('UnknownRehydration');
      },
    );

    covered(
      [
        'OlmMachine.hasDownloadedAllRoomKeys',
        'OlmMachine.setHasDownloadedAllRoomKeys',
        'OlmMachine.buildRoomKeyBundle',
        'OlmMachine.shareRoomKeyBundleData',
        'OlmMachine.storeRoomPendingKeyBundle',
        'OlmMachine.getPendingKeyBundleDetailsForRoom',
        'OlmMachine.getAllRoomsPendingKeyBundles',
        'OlmMachine.getReceivedRoomKeyBundleData',
        'OlmMachine.receiveRoomKeyBundle',
        'OlmMachine.clearRoomPendingKeyBundle',
      ],
      'shares room history through a key bundle the other side imports only from a known sender for the right room',
      async () => {
        const server = new Homeserver();
        const roomId = '!history:localhost';
        const otherRoom = '!elsewhere:localhost';
        const inviters = [await device('native'), await device('wasm')];
        // invitees[0] (native) is invited by the WASM inviter, invitees[1] by the native one.
        const invitees = [await device('native'), await device('wasm')];
        const inviterOf = (it) => inviters[1 - invitees.indexOf(it)];
        const inviteeOf = (it) => invitees[1 - inviters.indexOf(it)];
        for (const it of [...inviters, ...invitees]) {
          await server.flush(it);
          await bootstrap(server, it);
        }
        const step = async (devices, name, run, view) => {
          const answers = await both(devices, run);
          expectSame(answers, name, view);
          return answers[0];
        };

        // The inviter's own room key, made with shared history.
        for (const it of inviters) {
          await it.updateTrackedUsers([it.userId]);
          await server.flush(it);
          for (const share of await it.shareRoomKey(
            roomId,
            [it.userId],
            undefined,
            HistoryVisibility.Shared,
          )) {
            await server.send(it, share);
          }
        }
        const events = await Promise.all(
          inviters.map(async (it) =>
            roomEvent(
              it,
              roomId,
              await it.encryptRoomEvent(
                roomId,
                'm.room.message',
                '{"body":"history"}',
              ),
            ),
          ),
        );
        const eventFor = (it) => events[inviters.indexOf(inviterOf(it))];

        expect(
          await step(inviters, 'hasDownloadedAllRoomKeys', (it) =>
            it.hasDownloadedAllRoomKeys(roomId),
          ),
        ).toEqual({ result: false });
        await step(inviters, 'setHasDownloadedAllRoomKeys', (it) =>
          it.setHasDownloadedAllRoomKeys(roomId),
        );
        expect(
          await step(inviters, 'hasDownloadedAllRoomKeys after set', (it) =>
            it.hasDownloadedAllRoomKeys(roomId),
          ),
        ).toEqual({ result: true });

        expect(
          await step(inviters, 'buildRoomKeyBundle with no keys', (it) =>
            it.buildRoomKeyBundle(otherRoom),
          ),
        ).toEqual({ result: null });
        const built = await each(inviters, (it) =>
          it.buildRoomKeyBundle(roomId),
        );
        // Fresh ciphertext and file keys: by shape. The contents, decrypted, also by shape.
        expectSame(built, 'buildRoomKeyBundle', (answer) => shape(answer));
        const contents = built.map(
          ({ result: { encryptedData, mediaEncryptionInfo } }) =>
            JSON.parse(
              new TextDecoder().decode(
                wasm.Attachment.decrypt(
                  new wasm.EncryptedAttachment(
                    new Uint8Array(Buffer.from(encryptedData, 'base64')),
                    mediaEncryptionInfo,
                  ),
                ),
              ),
            ),
        );
        expect(shape(named(contents[0], inviters[0], 'inviter'))).toEqual(
          shape(named(contents[1], inviters[1], 'inviter')),
        );
        expect(contents[0].room_keys).toHaveLength(1);
        expect(contents[0].room_keys[0].room_id).toBe(roomId);
        const urls = built.map(({ result: { encryptedData } }) =>
          server.upload(encryptedData),
        );
        const urlOf = (it) => urls[inviters.indexOf(it)];
        const infoOf = (it) =>
          built[inviters.indexOf(it)].result.mediaEncryptionInfo;

        // The inviter tells the invitee's devices where the bundle is, for the room and (as a
        // forged claim with the same file) for another room.
        for (const it of inviters) {
          await fetchKeys(server, it, [inviteeOf(it).userId]);
          await claimSessions(server, it, [inviteeOf(it).userId]);
        }
        for (const room of [roomId, otherRoom]) {
          const shares = await each(inviters, (it) =>
            it.shareRoomKeyBundleData(
              inviteeOf(it).userId,
              room,
              urlOf(it),
              infoOf(it),
              'identityBasedStrategy',
            ),
          );
          expectSame(
            shares,
            `shareRoomKeyBundleData for ${room}`,
            (answer, index) =>
              shape(
                named(
                  named(answer, inviters[index], 'inviter'),
                  inviteeOf(inviters[index]),
                  'invitee',
                ),
                freshKeys,
              ),
          );
          expect(shares[0].result).toHaveLength(1);
          expect(shares[0].result[0].type).toBe(RequestType.ToDevice);
          for (const [index, it] of inviters.entries()) {
            for (const share of shares[index].result)
              await server.send(it, share);
          }
        }
        const noInfo = await both(inviters, (it) =>
          it.shareRoomKeyBundleData(
            inviteeOf(it).userId,
            roomId,
            urlOf(it),
            undefined,
            'identityBasedStrategy',
          ),
        );
        expectSame(noInfo, 'shareRoomKeyBundleData without encryption info');
        expect(noInfo[0].error.code).toBe('CryptoError');

        // The invitee joined, so waits for a bundle.
        const started = Date.now();
        await step(invitees, 'storeRoomPendingKeyBundle', (it) =>
          it.storeRoomPendingKeyBundle(roomId, inviterOf(it).userId),
        );
        const acceptedAt = (answer, index) =>
          answer.result &&
          named(
            {
              ...answer.result,
              inviteAcceptedAtMillis:
                answer.result.inviteAcceptedAtMillis >= started - 1000 &&
                answer.result.inviteAcceptedAtMillis <= Date.now(),
            },
            inviterOf(invitees[index]),
            'inviter',
          );
        expect(
          await step(
            invitees,
            'getPendingKeyBundleDetailsForRoom',
            (it) => it.getPendingKeyBundleDetailsForRoom(roomId),
            acceptedAt,
          ),
        ).toMatchObject({ result: { roomId } });
        await step(
          invitees,
          'getAllRoomsPendingKeyBundles',
          (it) => it.getAllRoomsPendingKeyBundles(),
          (answer, index) => ({
            result: answer.result.map((details) =>
              acceptedAt({ result: details }, index),
            ),
          }),
        );

        const synced = await both(invitees, (it) => server.sync(it));
        expectSame(synced, 'sync the bundle data', syncedTypes);
        const dataView = (answer, index) =>
          answer.result
            ? {
                ...named(answer.result, inviterOf(invitees[index]), 'inviter'),
                url: answer.result.url === urlOf(inviterOf(invitees[index])),
                encryptionInfo: shape(JSON.parse(answer.result.encryptionInfo)),
              }
            : answer;
        const received = await each(invitees, (it) =>
          it.getReceivedRoomKeyBundleData(roomId, inviterOf(it).userId),
        );
        expectSame(received, 'getReceivedRoomKeyBundleData', dataView);
        expect(dataView(received[0], 0)).toMatchObject({
          senderUser: '<inviter>',
          roomId,
          url: true,
        });
        expect(
          await step(
            invitees,
            'getReceivedRoomKeyBundleData from a non-member',
            (it) =>
              it.getReceivedRoomKeyBundleData(roomId, '@stranger:localhost'),
          ),
        ).toEqual({ result: null });
        const dataOf = (it) => received[invitees.indexOf(it)].result;
        const download = (it) => server.media.get(dataOf(it).url);
        // Each invitee decrypts its own inviter's event: the event's ID and time differ.
        const decryptView = (answer, index) => {
          const view = named(answer, inviterOf(invitees[index]), 'inviter');
          if (view.result) {
            const {
              event_id: _,
              origin_server_ts: __,
              ...event
            } = JSON.parse(view.result.event);
            view.result.event = event;
          }
          return view;
        };
        const keyEvents = (answer, index) =>
          named(
            ofType(answer, 'roomKeysReceived'),
            inviterOf(invitees[index]),
            'inviter',
          ).map((event) => ({
            ...event,
            keys: event.keys.map((info) => ({ ...info, sessionId: 'session' })),
          }));

        // The invitee has not fetched the inviter's keys: an unknown sender, ignored.
        await step(
          invitees,
          'receiveRoomKeyBundle from an unknown sender',
          (it) => it.receiveRoomKeyBundle(dataOf(it), download(it)),
        );
        const unknown = await both(invitees, (it) => it.pollEvents());
        expectSame(unknown, 'no room keys from an unknown sender', keyEvents);
        expect(ofType(unknown[0], 'roomKeysReceived')).toEqual([]);
        const undecryptable = await step(
          invitees,
          'decrypt before an accepted bundle',
          (it) => it.decryptRoomEvent(eventFor(it), roomId),
          decryptView,
        );
        expect(undecryptable.error.code).toBe('MegolmDecryptionError');

        // Known now, though unverified: still nothing from the bundle claimed for another room.
        for (const it of invitees)
          await fetchKeys(server, it, [inviterOf(it).userId]);
        const elsewhere = await each(invitees, (it) =>
          it.getReceivedRoomKeyBundleData(otherRoom, inviterOf(it).userId),
        );
        expectSame(
          elsewhere,
          'getReceivedRoomKeyBundleData for another room',
          dataView,
        );
        await step(invitees, 'receiveRoomKeyBundle for another room', (it) =>
          it.receiveRoomKeyBundle(
            elsewhere[invitees.indexOf(it)].result,
            download(it),
          ),
        );
        const mismatched = await both(invitees, (it) => it.pollEvents());
        expectSame(mismatched, 'no room keys for the wrong room', keyEvents);
        expect(ofType(mismatched[0], 'roomKeysReceived')).toEqual([]);

        // A tampered file fails its hash on both sides.
        const tampered = await step(
          invitees,
          'receiveRoomKeyBundle tampered',
          (it) => {
            const bytes = Buffer.from(download(it), 'base64');
            bytes[0] ^= 1;
            return it.receiveRoomKeyBundle(
              dataOf(it),
              bytes.toString('base64'),
            );
          },
        );
        expect(tampered.error.code).toBe('CryptoError');

        expect(
          await step(invitees, 'receiveRoomKeyBundle', (it) =>
            it.receiveRoomKeyBundle(dataOf(it), download(it)),
          ),
        ).toEqual({ result: null });
        const imported = await both(invitees, (it) => it.pollEvents());
        expectSame(imported, 'room keys from the bundle', keyEvents);
        expect(ofType(imported[0], 'roomKeysReceived')).toHaveLength(1);
        const decrypted = await step(
          invitees,
          'decrypt with the bundle keys',
          (it) => it.decryptRoomEvent(eventFor(it), roomId),
          decryptView,
        );
        expect(JSON.parse(decrypted.result.event).content).toEqual({
          body: 'history',
        });

        // The crate reads the bundle data again by room and inviter (WASM's object cannot be
        // forged in JavaScript): none stored, or a newer one than the file downloaded, is refused.
        const [nativeInvitee] = invitees;
        const stored = dataOf(nativeInvitee);
        expect(
          (
            await nativeInvitee.receiveRoomKeyBundle(
              { ...stored, senderUser: '@stranger:localhost' },
              download(nativeInvitee),
            )
          ).error.code,
        ).toBe('UnknownBundle');
        expect(
          (
            await nativeInvitee.receiveRoomKeyBundle(
              { ...stored, url: 'mxc://localhost/other' },
              download(nativeInvitee),
            )
          ).error.code,
        ).toBe('StaleObject');

        await step(invitees, 'clearRoomPendingKeyBundle', (it) =>
          it.clearRoomPendingKeyBundle(roomId),
        );
        expect(
          await step(
            invitees,
            'getPendingKeyBundleDetailsForRoom after clear',
            (it) => it.getPendingKeyBundleDetailsForRoom(roomId),
          ),
        ).toEqual({ result: null });
        expect(
          await step(
            invitees,
            'getAllRoomsPendingKeyBundles after clear',
            (it) => it.getAllRoomsPendingKeyBundles(),
          ),
        ).toEqual({ result: [] });
      },
    );

    /** A native and a WASM sender, each with a receiver of the other kind in `roomId`. */
    const crossedSenders = async (roomId) => {
      const server = new Homeserver();
      const senders = [await device('native'), await device('wasm')];
      const receivers = [await device('wasm'), await device('native')];
      for (const [index, sender] of senders.entries()) {
        await shareRoom(server, sender, [receivers[index]], roomId);
        await server.sync(receivers[index]);
      }
      return { server, senders, receivers };
    };

    covered(
      ['OlmMachine.encryptStateEvent', 'OlmMachine.invalidateGroupSession'],
      'encrypts a state event the other side decrypts with its packed state key, and rotates the session',
      async () => {
        const roomId = '!state:localhost';
        const { server, senders, receivers } = await crossedSenders(roomId);
        const encrypted = await each(senders, (it) =>
          it.encryptStateEvent(
            roomId,
            'm.room.topic',
            '',
            '{"topic":"hidden"}',
          ),
        );
        // Fresh ciphertext: by shape.
        expectSame(encrypted, 'encryptStateEvent', (answer) =>
          shape(JSON.parse(answer.result)),
        );
        // Receivers in native-first order: receivers[1] decrypts what senders[1] sent.
        const readers = [receivers[1], receivers[0]];
        const stateEvent = (it, stateKey) => {
          const sender = senders[1 - readers.indexOf(it)];
          const event = JSON.parse(
            roomEvent(
              sender,
              roomId,
              encrypted[senders.indexOf(sender)].result,
            ),
          );
          return JSON.stringify({
            ...event,
            event_id: '$state:localhost',
            origin_server_ts: 1,
            state_key: stateKey,
          });
        };
        const view = (answer, index) =>
          named(answer, senders[1 - index], 'sender');
        const decrypted = await both(readers, (it) =>
          it.decryptRoomEvent(stateEvent(it, 'm.room.topic:'), roomId),
        );
        expectSame(decrypted, 'decrypt the state event', view);
        expect(JSON.parse(decrypted[0].result.event)).toMatchObject({
          type: 'm.room.topic',
          state_key: '',
          content: { topic: 'hidden' },
        });
        const wrong = await both(readers, (it) =>
          it.decryptRoomEvent(stateEvent(it, 'm.room.name:'), roomId),
        );
        expectSame(wrong, 'decrypt with another packed state key', view);
        expect(wrong[0].error).toBeDefined();

        const step = async (name, run) => {
          const answers = await both(senders, run);
          expectSame(answers, name);
          return answers[0];
        };
        expect(
          await step('invalidateGroupSession', (it) =>
            it.invalidateGroupSession(roomId),
          ),
        ).toEqual({ result: true });
        // The invalidated session stays cached until the next share replaces it.
        expect(
          await step('invalidateGroupSession again', (it) =>
            it.invalidateGroupSession(roomId),
          ),
        ).toEqual({ result: true });
        expect(
          await step('invalidateGroupSession of a room without one', (it) =>
            it.invalidateGroupSession('!none:localhost'),
          ),
        ).toEqual({ result: false });
        // The next share is a new session for the receiver.
        const shares = await each(senders, (it) =>
          it.shareRoomKey(roomId, [
            it.userId,
            receivers[senders.indexOf(it)].userId,
          ]),
        );
        expect(shares.map((list) => list.length)).toEqual([1, 1]);
        for (const [index, it] of senders.entries()) {
          for (const share of shares[index]) await server.send(it, share);
        }
      },
    );

    covered(
      ['OlmMachine.getRoomSettings', 'OlmMachine.setRoomSettings'],
      'keeps room settings and refuses a downgrade or an invalid algorithm as WASM does',
      async () => {
        const devices = [await device('native'), await device('wasm')];
        const step = async (name, run) => {
          const answers = await both(devices, run);
          expectSame(answers, name);
          return answers[0];
        };
        const roomId = '!settings:localhost';
        const settings = {
          algorithm: wasm.EncryptionAlgorithm.MegolmV1AesSha2,
          encryptStateEvents: true,
          onlyAllowTrustedDevices: true,
          sessionRotationPeriodMs: 604800000,
          sessionRotationPeriodMessages: 100,
        };
        expect(
          await step('getRoomSettings unset', (it) =>
            it.getRoomSettings(roomId),
          ),
        ).toEqual({ result: null });
        expect(
          await step('setRoomSettings', (it) =>
            it.setRoomSettings(roomId, settings),
          ),
        ).toEqual({ result: null });
        expect(
          await step('getRoomSettings', (it) => it.getRoomSettings(roomId)),
        ).toEqual({ result: settings });
        expect(
          await step('setRoomSettings the same again', (it) =>
            it.setRoomSettings(roomId, settings),
          ),
        ).toEqual({ result: null });
        const downgrade = await step('setRoomSettings downgrade', (it) =>
          it.setRoomSettings(roomId, {
            ...settings,
            onlyAllowTrustedDevices: false,
          }),
        );
        expect(downgrade.error).toEqual({
          code: 'CryptoError',
          message:
            'the new settings would cause a downgrade of encryption security',
        });
        expect(
          await step('getRoomSettings after the refused downgrade', (it) =>
            it.getRoomSettings(roomId),
          ),
        ).toEqual({ result: settings });
        const olm = await step('setRoomSettings with Olm', (it) =>
          it.setRoomSettings('!olm:localhost', {
            algorithm: wasm.EncryptionAlgorithm.OlmV1Curve25519AesSha2,
          }),
        );
        expect(olm.error).toEqual({
          code: 'CryptoError',
          message: 'the new settings are invalid',
        });
        // Defaults: only the algorithm set; the optional fields stay unset.
        await step('setRoomSettings defaults', (it) =>
          it.setRoomSettings('!defaults:localhost', {}),
        );
        expect(
          await step('getRoomSettings defaults', (it) =>
            it.getRoomSettings('!defaults:localhost'),
          ),
        ).toEqual({
          result: {
            algorithm: wasm.EncryptionAlgorithm.MegolmV1AesSha2,
            encryptStateEvents: false,
            onlyAllowTrustedDevices: false,
          },
        });
      },
    );

    covered(
      ['OlmMachine.roomKeyRequestsEnabled'],
      'reads and sets whether room keys are requested as WASM does',
      async () => {
        const devices = [await device('native'), await device('wasm')];
        const answers = [];
        for (const enabled of [undefined, false, undefined, true]) {
          const step = await both(devices, (it) =>
            it.roomKeyRequestsEnabled(enabled),
          );
          expectSame(step, `roomKeyRequestsEnabled ${enabled}`);
          answers.push(step[0].result);
        }
        expect(answers).toEqual([true, false, false, true]);
      },
    );

    covered(
      ['OlmMachine.receiveSyncChangesMsc4186'],
      'takes sliding-sync input as the classic input, except for missing key counts',
      async () => {
        const server = new Homeserver();
        const sender = await device('wasm');
        const sliding = [await device('native'), await device('wasm')];
        const classic = [await device('native'), await device('wasm')];
        const roomId = '!sliding:localhost';
        await shareRoom(server, sender, [...sliding, ...classic], roomId);
        const viaSliding = await both(sliding, (it) =>
          server.sync(it, { msc4186: true }),
        );
        const viaClassic = await both(classic, (it) => server.sync(it));
        const view = (answer, index, devices) =>
          anonymise(answer.result ?? answer, devices[index]);
        expectSame(
          viaSliding,
          'receiveSyncChangesMsc4186 with a room key',
          (a, i) => view(a, i, sliding),
        );
        // The same data through the classic call answers the same.
        expect(view(viaSliding[0], 0, sliding)).toEqual(
          view(viaClassic[0], 0, classic),
        );
        expect(syncedTypes(viaSliding[0])).toEqual([
          [wasm.ProcessedToDeviceEventType.Decrypted, 'm.room_key'],
        ]);

        // No counts: unchanged under MSC4186, zero (so upload more) under sync v2.
        const uploads = async (devices, run) => {
          const answers = await each(devices, async (it) => {
            const synced = await run(it);
            // The upload also carries a new fallback key: count the one-time keys in it.
            const requests = await it.outgoingRequests();
            const upload = requests.find(
              ({ type }) => type === RequestType.KeysUpload,
            );
            return {
              synced,
              oneTimeKeys: Object.keys(
                JSON.parse(upload?.body ?? '{}').one_time_keys ?? {},
              ).length,
            };
          });
          return answers;
        };
        // Fresh devices whose keys are uploaded: the server holds all they want.
        const fresh = [await device('native'), await device('wasm')];
        const again = [await device('native'), await device('wasm')];
        for (const it of [...fresh, ...again]) await server.flush(it);
        const unchanged = await uploads(fresh, (it) =>
          it.receiveSyncChangesMsc4186('[]', {}),
        );
        expectSame(unchanged, 'receiveSyncChangesMsc4186 without counts');
        expect(unchanged[0]).toEqual({
          synced: { result: [] },
          oneTimeKeys: 0,
        });
        const zero = await uploads(again, async (it) => ({
          result: await it.receiveSyncChanges('[]', {}),
        }));
        expect(zero.map(({ oneTimeKeys }) => oneTimeKeys > 0)).toEqual([
          true,
          true,
        ]);
      },
    );
  },
);

/** Drops `undefined` fields. */
const defined = (value) => JSON.parse(JSON.stringify(value ?? null));

/** Whether `answer` equals `expected`, as a view both sides answer `true` to. */
const equalTo = (answer, expected) =>
  JSON.stringify(sortKeys(answer)) === JSON.stringify(sortKeys(expected));

const sortKeys = (value) =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sortKeys(value[key])]),
        )
      : value;
