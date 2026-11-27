/**
 * Every native call marked `done` in native/crypto/surface.json runs the same step as WASM and
 * answers the same, compared by value; where WASM's answer is random by nature (fresh keys,
 * ciphertext, request IDs), by shape, as each case says. Each `covered` case names the
 * manifest entries it proves (scripts/native-crypto-surface.spec.mjs checks the list).
 *
 * `verifyBackup` with cross-signing (a known but unverified own device, a master-key signature)
 * is in native-crypto-trust.test.mjs, which has the cross-signing fixture.
 */
import * as wasm from '@matrix-org/matrix-sdk-crypto-wasm';
import {
  Homeserver,
  both,
  compared,
  covered,
  hasCargo,
  roomEvent,
  shape,
  shareKey,
  shareRoom,
  skipped,
  useDevices,
} from './native-crypto-harness.mjs';

const KEYS_BACKUP = wasm.RequestType.KeysBackup;
const BACKUP_ALGORITHM = 'm.megolm_backup.v1.curve25519-aes-sha2';

const expectSame = ([native, wasmAnswer], step) =>
  expect(native, step).toEqual(wasmAnswer);

const result = (response) => {
  expect(response.error).toBeUndefined();
  return response.result;
};

const ofType = (polled, type) =>
  polled.result.events.filter((event) => event.type === type);

const bySession = (keys) =>
  [...keys].sort((a, b) => a.session_id.localeCompare(b.session_id));

describe.skipIf(!hasCargo)(`native crypto contract with WASM${skipped}`, () => {
  const device = useDevices();

  /** A WASM sender, and a native and a WASM receiver that both hold its room key. */
  const receiversWithARoomKey = async (roomId) => {
    const server = new Homeserver();
    const sender = await device('wasm');
    const receivers = [await device('native'), await device('wasm')];
    await shareRoom(server, sender, receivers, roomId);
    for (const receiver of receivers) await server.sync(receiver);
    return { server, sender, receivers };
  };

  covered(
    [
      'OlmMachine.initFromStore',
      'OlmMachine.userId',
      'OlmMachine.deviceId',
      'OlmMachine.deviceCreationTimeMs',
      'OlmMachine.identityKeys',
      'OlmMachine.close',
    ],
    'opens and closes a machine as WASM does',
    async () => {
      const started = Date.now();
      const [native, wasmSide] = await compared(async () => [
        await device('native'),
        await device('wasm'),
      ]);
      const { machine } = wasmSide;
      const fromMachine = {
        userId: machine.userId.toString(),
        deviceId: machine.deviceId.toString(),
        identityKeys: {
          ed25519: machine.identityKeys.ed25519.toBase64(),
          curve25519: machine.identityKeys.curve25519.toBase64(),
        },
        deviceCreationTimeMs: machine.deviceCreationTimeMs,
      };
      // Fresh keys and IDs on each side: same fields and types, own IDs, a creation time now.
      expect(shape(native.description)).toEqual(shape(fromMachine));
      expect(native.description.userId).toBe(native.userId);
      expect(native.description.deviceId).toBe(native.deviceId);
      for (const { deviceCreationTimeMs } of [
        native.description,
        fromMachine,
      ]) {
        expect(deviceCreationTimeMs).toBeGreaterThanOrEqual(started - 1000);
        expect(deviceCreationTimeMs).toBeLessThanOrEqual(Date.now());
      }
      await compared(async () => {
        expect(result(await native.respond('identityKeys'))).toEqual(
          native.identityKeys,
        );
        await native.close();
        wasmSide.close();
        expect((await native.respond('identityKeys')).error.code).toBe(
          'UnknownMachine',
        );
        expect(() => machine.identityKeys).toThrow();
      });
    },
  );

  covered(
    [
      'OlmMachine.registerRoomKeyUpdatedCallback',
      'OlmMachine.exportRoomKeys',
      'OlmMachine.importExportedRoomKeys',
      'OlmMachine.roomKeyCounts',
    ],
    'reports received room keys and exports keys the other side imports',
    async () => {
      const roomId = '!export:localhost';
      const { sender, receivers } = await receiversWithARoomKey(roomId);
      const received = await both(receivers, (receiver) =>
        receiver.pollEvents(),
      );
      // Key queries also queue devicesUpdated, naming the other receiver: compared in
      // native-crypto-trust.test.mjs.
      expectSame(
        received.map((polled) => ofType(polled, 'roomKeysReceived')),
        'roomKeysReceived',
      );
      const keyEvents = ofType(received[0], 'roomKeysReceived');
      expect(keyEvents).toHaveLength(1);
      expect(keyEvents[0].keys[0].roomId).toBe(roomId);

      const exports = await both(receivers, async (receiver) =>
        bySession(JSON.parse(result(await receiver.exportRoomKeys()))),
      );
      expectSame(exports, 'exportRoomKeys');
      expect(exports[0]).toHaveLength(1);
      expectSame(
        await both(receivers, (receiver) => receiver.roomKeyCounts()),
        'roomKeyCounts',
      );

      // Each side imports what the other exported.
      const importers = [await device('native'), await device('wasm')];
      const raw = await Promise.all(
        receivers.map(async (receiver) =>
          result(await receiver.exportRoomKeys()),
        ),
      );
      const crossed = [raw[1], raw[0]];
      const imported = await both(importers, (importer) =>
        importer.importExportedRoomKeys(crossed[importers.indexOf(importer)]),
      );
      expectSame(imported, 'importExportedRoomKeys');
      // WASM's progress listener last saw (index of the last key, total).
      expect(imported[0].result.lastProgress).toEqual([0, 1]);
      expectSame(
        await both(importers, (importer) => importer.pollEvents()),
        'roomKeysReceived after import',
      );
      const again = await both(importers, (importer) =>
        importer.importExportedRoomKeys(crossed[importers.indexOf(importer)]),
      );
      expectSame(again, 'importExportedRoomKeys again');
      expect(again[0].result.importedCount).toBe(0);
      expectSame(
        await both(importers, (importer) => importer.roomKeyCounts()),
        'roomKeyCounts after import',
      );

      const event = roomEvent(
        sender,
        roomId,
        await sender.encryptRoomEvent(roomId, 'm.room.message', '{}'),
      );
      const decrypted = await both(importers, (importer) =>
        importer.decryptRoomEvent(event, roomId),
      );
      expectSame(decrypted, 'decrypt with imported keys');
      expect(decrypted[0].result.sender).toBe(sender.userId);
    },
  );

  covered(
    ['OlmMachine.registerRoomKeysWithheldCallback'],
    'reports withheld room keys as WASM does',
    async () => {
      const { server, sender, receivers } = await receiversWithARoomKey(
        '!withheld:localhost',
      );
      await both(receivers, (receiver) => receiver.pollEvents());
      await shareKey(
        server,
        sender,
        [sender, ...receivers].map(({ userId }) => userId),
        '!withheld-trusted:localhost',
        'onlyTrustedDevices',
      );
      await server.flush(sender);
      for (const receiver of receivers) await server.sync(receiver);

      const withheld = await both(receivers, (receiver) =>
        receiver.pollEvents(),
      );
      expectSame(withheld, 'roomKeysWithheld');
      const [event] = ofType(withheld[0], 'roomKeysWithheld');
      expect(event.keys[0].withheldCode).toBe('m.unverified');
      expect(event.keys[0].sender).toBe(sender.userId);
    },
  );

  /** The decrypted sessions of a backup request's body, as matrix-js-sdk passes them. */
  const restore = (request, key) =>
    Object.fromEntries(
      Object.entries(JSON.parse(request.body).rooms).map(
        ([roomId, { sessions }]) => [
          roomId,
          Object.fromEntries(
            Object.entries(sessions).map(([id, { session_data: data }]) => [
              id,
              JSON.parse(
                key.decryptV1(data.ephemeral, data.mac, data.ciphertext),
              ),
            ]),
          ),
        ],
      ),
    );

  covered(
    [
      'OlmMachine.enableBackupV1',
      'OlmMachine.isBackupEnabled',
      'OlmMachine.backupRoomKeys',
      'OlmMachine.markRequestAsSent',
      'OlmMachine.roomKeyCounts',
      'OlmMachine.importBackedUpRoomKeys',
      'OlmMachine.disableBackup',
    ],
    'backs up room keys that restore on the other side, and not with the wrong key',
    async () => {
      const roomId = '!backup:localhost';
      const { receivers } = await receiversWithARoomKey(roomId);
      const key = wasm.BackupDecryptionKey.createRandomKey();
      const publicKey = key.megolmV1PublicKey.publicKeyBase64;
      const step = async (name, run) => {
        const answers = await both(receivers, run);
        expectSame(answers, name);
        return answers[0];
      };

      expect(
        await step('isBackupEnabled', (receiver) => receiver.isBackupEnabled()),
      ).toEqual({ result: false });
      await step('enableBackupV1', (receiver) =>
        receiver.enableBackupV1(publicKey, '1'),
      );
      expect(
        await step('isBackupEnabled', (receiver) => receiver.isBackupEnabled()),
      ).toEqual({ result: true });
      expect(
        await step('roomKeyCounts', (receiver) => receiver.roomKeyCounts()),
      ).toEqual({ result: { total: 1, backedUp: 0 } });

      const requests = await Promise.all(
        receivers.map(async (receiver) =>
          result(await receiver.backupRoomKeys()),
        ),
      );
      // The session data is fresh ciphertext and the ID random: compare those by shape.
      const comparable = ({ id, body, ...rest }) => {
        const rooms = JSON.parse(body).rooms;
        for (const { sessions } of Object.values(rooms)) {
          for (const session of Object.values(sessions)) {
            session.session_data = shape(session.session_data);
          }
        }
        return { id: typeof id, ...rest, rooms };
      };
      expectSame(requests.map(comparable), 'backupRoomKeys');
      expect(requests[0]).toMatchObject({ type: KEYS_BACKUP, version: '1' });

      await step('markRequestAsSent', async (receiver) => {
        const request = requests[receivers.indexOf(receiver)];
        return receiver.markRequestAsSent(
          request.id,
          KEYS_BACKUP,
          JSON.stringify({ etag: '1', count: 1 }),
        );
      });
      expect(
        await step('roomKeyCounts', (receiver) => receiver.roomKeyCounts()),
      ).toEqual({ result: { total: 1, backedUp: 1 } });
      expect(
        await step('backupRoomKeys', (receiver) => receiver.backupRoomKeys()),
      ).toEqual({ result: null });

      // Each side restores the backup the other made; a session that does not parse is skipped
      // and counted, and WASM's listener last saw (progress, valid + failed, failed).
      const restorers = [await device('native'), await device('wasm')];
      const restored = await both(restorers, (restorer) => {
        const made = requests[1 - restorers.indexOf(restorer)];
        const rooms = restore(made, key);
        rooms[roomId].broken = { algorithm: 'nope' };
        return restorer.importBackedUpRoomKeys(rooms, '1');
      });
      expectSame(restored, 'importBackedUpRoomKeys');
      expect(restored[0].result).toMatchObject({
        importedCount: 1,
        totalCount: 1,
        failures: 1,
        lastProgress: [0, 2, 1],
      });
      expectSame(
        await both(restorers, (restorer) => restorer.roomKeyCounts()),
        'roomKeyCounts after restore',
      );

      // The wrong key cannot open either side's backup.
      const wrong = wasm.BackupDecryptionKey.createRandomKey();
      const failures = requests.map((request) => {
        try {
          restore(request, wrong);
          return 'decrypted';
        } catch (error) {
          return String(error.message ?? error);
        }
      });
      expect(failures[0]).not.toBe('decrypted');
      expect(failures[0]).toBe(failures[1]);

      await step('disableBackup', (receiver) => receiver.disableBackup());
      expect(
        await step('isBackupEnabled', (receiver) => receiver.isBackupEnabled()),
      ).toEqual({ result: false });
      expect(
        await step('roomKeyCounts', (receiver) => receiver.roomKeyCounts()),
      ).toEqual({ result: { total: 1, backedUp: 0 } });
    },
  );

  covered(
    [
      'OlmMachine.saveBackupDecryptionKey',
      'OlmMachine.getBackupKeys',
      'BackupKeys.decryptionKey',
      'BackupKeys.backupVersion',
      'OlmMachine.enableBackupV1',
    ],
    'keeps the backup key and rejects a malformed one as WASM does',
    async () => {
      const devices = [await device('native'), await device('wasm')];
      const key = wasm.BackupDecryptionKey.createRandomKey().toBase64();
      expectSame(
        await both(devices, (it) => it.getBackupKeys()),
        'getBackupKeys empty',
      );
      expectSame(
        await both(devices, (it) => it.saveBackupDecryptionKey(key, '7')),
        'saveBackupDecryptionKey',
      );
      const saved = await both(devices, (it) => it.getBackupKeys());
      expectSame(saved, 'getBackupKeys');
      expect(saved[0]).toEqual({
        result: { decryptionKeyBase64: key, backupVersion: '7' },
      });

      for (const bad of ['not a key', 'AAAA']) {
        const [native, wasmAnswer] = await both(devices, (it) =>
          it.saveBackupDecryptionKey(bad, '8'),
        );
        // Same code; native's message is fixed on purpose, as WASM's names a character of the
        // key and its offset.
        expect(native.error).toEqual({
          code: 'CryptoError',
          message: 'invalid backup decryption key',
        });
        expect(wasmAnswer.error.code).toBe('CryptoError');
        const enabled = await both(devices, (it) =>
          it.enableBackupV1(bad, '8'),
        );
        expectSame(enabled, `enableBackupV1 ${bad}`);
        expect(enabled[0].error.code).toBe('CryptoError');
      }
      expectSame(
        await both(devices, (it) => it.getBackupKeys()),
        'getBackupKeys after malformed keys',
      );
    },
  );

  covered(
    ['OlmMachine.sign', 'OlmMachine.verifyBackup'],
    'signs backup info and rejects a tampered signature as WASM does',
    async () => {
      const devices = [await device('native'), await device('wasm')];
      const publicKey =
        wasm.BackupDecryptionKey.createRandomKey().megolmV1PublicKey
          .publicKeyBase64;
      const otherKey =
        wasm.BackupDecryptionKey.createRandomKey().megolmV1PublicKey
          .publicKeyBase64;
      const info = (public_key, signatures) => ({
        algorithm: BACKUP_ALGORITHM,
        auth_data: { public_key, signatures },
      });
      const signatures = new Map();
      const signed = await both(devices, async (it) => {
        const answer = await it.sign(JSON.stringify({ public_key: publicKey }));
        signatures.set(it, answer.result);
        return shape(answer);
      });
      expectSame(signed, 'sign');
      expect(signed[0]).toEqual({
        result: { '<receiver>': { 'ed25519:<receiver device>': 'string' } },
      });

      const flipped = (own) => {
        const [[user, keys]] = Object.entries(own);
        const [[keyId, signature]] = Object.entries(keys);
        const first = signature.startsWith('A') ? 'B' : 'A';
        return { [user]: { [keyId]: first + signature.slice(1) } };
      };
      const cases = {
        'signed by itself': (it) => info(publicKey, signatures.get(it)),
        'another public key': (it) => info(otherKey, signatures.get(it)),
        'a flipped signature': (it) =>
          info(publicKey, flipped(signatures.get(it))),
        unsigned: () => info(publicKey, {}),
        'signed by the other device': (it) =>
          info(publicKey, signatures.get(devices[1 - devices.indexOf(it)])),
      };
      const answers = {};
      for (const [name, backupInfo] of Object.entries(cases)) {
        const verified = await both(devices, (it) =>
          it.verifyBackup(backupInfo(it)),
        );
        expectSame(verified, name);
        answers[name] = verified[0].result;
      }
      const { Missing, Invalid, ValidAndTrusted } = wasm.SignatureState;
      expect(answers).toEqual({
        'signed by itself': {
          deviceState: ValidAndTrusted,
          userState: Missing,
          trusted: true,
        },
        'another public key': {
          deviceState: Invalid,
          userState: Missing,
          trusted: false,
        },
        'a flipped signature': {
          deviceState: Invalid,
          userState: Missing,
          trusted: false,
        },
        unsigned: { deviceState: Missing, userState: Missing, trusted: false },
        'signed by the other device': {
          deviceState: Missing,
          userState: Missing,
          trusted: false,
        },
      });
    },
  );
});
