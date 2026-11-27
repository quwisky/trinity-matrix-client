/**
 * The native crypto crate (native/crypto) and the WASM package the web app ships must
 * interoperate as two devices, and emit the same request shapes for the same step. The
 * native side runs as its JSON-lines CLI; a tiny in-test homeserver carries the keys and
 * to-device messages between them (scripts/native-crypto-harness.mjs).
 */
import { resolve } from 'node:path';
import * as wasm from '@matrix-org/matrix-sdk-crypto-wasm';
import { format, resolveConfig } from 'prettier';
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

/** Placeholders for IDs and key IDs, so two runs of the same request compare equal. */
const requestShape = (request, device) => {
  const key = (name) =>
    name
      .replaceAll(device.userId, '<user>')
      .replace(/^@[^:]+:localhost$/, '<other user>')
      .replace(
        /^(signed_curve25519|curve25519|ed25519):(.+)$/,
        (_, algorithm, id) =>
          `${algorithm}:${id === device.deviceId ? '<device>' : '<key>'}`,
      )
      .replace(new RegExp(`^${device.deviceId}$`), '<device>')
      .replace(/^[A-Z]+\d+$/, '<other device>')
      .replace(/^[A-Za-z0-9+/]{43}$/, '<curve25519 key>');
  return shape({ ...request, body: JSON.parse(request.body) }, key);
};

const { Decrypted, UnableToDecrypt } = wasm.ProcessedToDeviceEventType;

describe.skipIf(!hasCargo)(`native crypto interop with WASM${skipped}`, () => {
  const device = useDevices();

  /**
   * One sender, a native and a WASM receiver, the same messages to both. Returns, per step,
   * what each receiver answered (native first), with the receivers' own IDs and keys replaced.
   */
  const exchange = async (server, senderKind) => {
    const sender = await device(senderKind);
    const receivers = [await device('native'), await device('wasm')];
    const users = [sender, ...receivers].map(({ userId }) => userId);
    const each = (run) => both(receivers, run);
    const toDevice = (events, rawEvent) =>
      events.map((event) => ({ ...event, rawEvent: rawEvent(event.rawEvent) }));
    const roomId = `!${senderKind}:localhost`;
    await shareRoom(server, sender, receivers, roomId);
    const copies = receivers.map((receiver) => server.pending(receiver));

    const roomKey = await each(async (receiver) =>
      toDevice(await server.sync(receiver), JSON.parse),
    );
    receivers.forEach((receiver, index) =>
      server.deliver(receiver, copies[index]),
    );
    // A replayed olm message carries fresh ciphertext per receiver: compare its shape.
    const replay = await each(async (receiver) =>
      toDevice(await server.sync(receiver), (raw) => raw),
    ).then((answers) =>
      answers.map((events) =>
        toDevice(events, (raw) => shape(JSON.parse(raw))),
      ),
    );

    const content = { msgtype: 'm.text', body: `from ${senderKind}` };
    const event = roomEvent(
      sender,
      roomId,
      await sender.encryptRoomEvent(
        roomId,
        'm.room.message',
        JSON.stringify(content),
      ),
    );
    const decrypted = await each((receiver) =>
      receiver.decryptRoomEvent(event, roomId),
    );
    const encryptionInfo = await each((receiver) =>
      receiver.getRoomEventEncryptionInfo(event, roomId),
    );

    const lonelyRoom = `!${senderKind}-alone:localhost`;
    await shareKey(server, sender, [sender.userId], lonelyRoom);
    const lonely = roomEvent(
      sender,
      lonelyRoom,
      await sender.encryptRoomEvent(lonelyRoom, 'm.room.message', '{}'),
    );
    const missingKey = await each((receiver) =>
      receiver.decryptRoomEvent(lonely, lonelyRoom),
    );

    await shareKey(server, sender, users, `!${senderKind}-later:localhost`);
    const afterReplay = await each(async (receiver) =>
      (await server.sync(receiver)).map(({ type }) => type),
    );

    return {
      sender,
      content,
      steps: {
        roomKey,
        replay,
        decrypted,
        encryptionInfo,
        missingKey,
        afterReplay,
      },
    };
  };

  describe.each(['native', 'wasm'])('%s sender', (senderKind) => {
    covered(
      [
        'OlmMachine.receiveSyncChanges',
        'OlmMachine.decryptRoomEvent',
        'OlmMachine.getRoomEventEncryptionInfo',
      ],
      'decrypts on native and WASM with the same results',
      async () => {
        const { sender, content, steps } = await exchange(
          new Homeserver(requestShape),
          senderKind,
        );
        for (const [step, [native, wasmAnswer]] of Object.entries(steps)) {
          expect(native, step).toEqual(wasmAnswer);
        }

        expect(steps.roomKey[0].map(({ type }) => type)).toEqual([Decrypted]);
        expect(steps.roomKey[0][0].rawEvent.type).toBe('m.room_key');
        expect(steps.replay[0].map(({ type }) => type)).toEqual([
          UnableToDecrypt,
        ]);
        expect(steps.afterReplay[0]).toEqual([Decrypted]);

        const { result } = steps.decrypted[0];
        expect(JSON.parse(result.event).content).toEqual(content);
        expect(result.sender).toBe(sender.userId);
        expect(result.senderCurve25519Key).toBe(sender.identityKeys.curve25519);
        expect(result.senderClaimedEd25519Key).toBe(
          sender.identityKeys.ed25519,
        );
        // Neither device is cross-signed, so the shield is red.
        expect(result.shieldState.lax.color).toBe(wasm.ShieldColor.Red);
        expect(steps.missingKey[0].error.details.code).toBe(
          wasm.DecryptionErrorCode.MissingRoomKey,
        );
      },
    );
  });

  // Every request of the native-sender exchange is compared with WASM's by shape, so all of
  // that exchange counts as compared; the setup calls are only checked here.
  covered(
    [
      'OlmMachine.outgoingRequests',
      'OlmMachine.markRequestAsSent',
      'OlmMachine.updateTrackedUsers',
      'OlmMachine.getMissingSessions',
      'OlmMachine.shareRoomKey',
      'OlmMachine.encryptRoomEvent',
    ],
    'emits the same request shapes as WASM and matches the golden file',
    async () => {
      const server = new Homeserver(requestShape);
      const { steps } = await compared(() => exchange(server, 'native'));
      await exchange(server, 'wasm');

      const { RequestType } = wasm;
      expect(Object.keys(server.shapes.wasm).map(Number).sort()).toEqual(
        [
          RequestType.KeysUpload,
          RequestType.KeysQuery,
          RequestType.KeysClaim,
          RequestType.ToDevice,
        ].sort(),
      );
      expect(server.shapes.native).toEqual(server.shapes.wasm);
      const responses = Object.fromEntries(
        Object.entries(steps).map(([step, [native]]) => [step, shape(native)]),
      );
      // Written as Prettier writes it, so `pnpm format:check` accepts the updated file.
      const golden = resolve(
        import.meta.dirname,
        'native-crypto-interop.golden.json',
      );
      const options = { ...(await resolveConfig(golden)), filepath: golden };
      await expect(
        await format(
          JSON.stringify({ requests: server.shapes.wasm, responses }),
          options,
        ),
      ).toMatchFileSnapshot(golden);
    },
  );
});
