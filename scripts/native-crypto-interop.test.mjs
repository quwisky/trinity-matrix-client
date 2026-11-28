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
  covered,
  each,
  expectSame,
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
   * what each receiver answered (native first), with the receivers' own IDs and keys replaced,
   * and the view under which the two answers must be equal.
   */
  const exchange = async (server, senderKind) => {
    const sender = await device(senderKind);
    const receivers = [await device('native'), await device('wasm')];
    const users = [sender, ...receivers].map(({ userId }) => userId);
    const onReceivers = (run) => both(receivers, run);
    const toDevice = (events, rawEvent) =>
      events.map((event) => ({ ...event, rawEvent: rawEvent(event.rawEvent) }));
    const same = (view = (answer) => answer) => view;
    const roomId = `!${senderKind}:localhost`;
    await shareRoom(server, sender, receivers, roomId);
    // Nothing new to track: answers nothing on both sides.
    const tracked = await onReceivers((receiver) =>
      receiver.updateTrackedUsers(users),
    );
    const copies = receivers.map((receiver) => server.pending(receiver));

    const roomKey = await onReceivers((receiver) => server.sync(receiver));
    receivers.forEach((receiver, index) =>
      server.deliver(receiver, copies[index]),
    );
    const replay = await onReceivers((receiver) => server.sync(receiver));

    const content = { msgtype: 'm.text', body: `from ${senderKind}` };
    const encrypted = await each([sender], (it) =>
      it.encryptRoomEvent(roomId, 'm.room.message', JSON.stringify(content)),
    );
    const event = roomEvent(sender, roomId, encrypted[0]);
    const decrypted = await onReceivers((receiver) =>
      receiver.decryptRoomEvent(event, roomId),
    );
    const encryptionInfo = await onReceivers((receiver) =>
      receiver.getRoomEventEncryptionInfo(event, roomId),
    );

    const lonelyRoom = `!${senderKind}-alone:localhost`;
    await shareKey(server, sender, [sender.userId], lonelyRoom);
    const lonely = roomEvent(
      sender,
      lonelyRoom,
      await sender.encryptRoomEvent(lonelyRoom, 'm.room.message', '{}'),
    );
    const missingKey = await onReceivers((receiver) =>
      receiver.decryptRoomEvent(lonely, lonelyRoom),
    );

    await shareKey(server, sender, users, `!${senderKind}-later:localhost`);
    const afterReplay = await onReceivers((receiver) => server.sync(receiver));

    return {
      sender,
      content,
      encrypted,
      steps: {
        tracked: [tracked, same()],
        roomKey: [roomKey, same((events) => toDevice(events, JSON.parse))],
        // A replayed olm message carries fresh ciphertext per receiver: compare its shape.
        replay: [
          replay,
          same((events) => toDevice(events, (raw) => shape(JSON.parse(raw)))),
        ],
        decrypted: [decrypted, same()],
        encryptionInfo: [encryptionInfo, same()],
        missingKey: [missingKey, same()],
        afterReplay: [
          afterReplay,
          same((events) => events.map(({ type }) => type)),
        ],
      },
    };
  };

  /** Each step's native answer through its view. */
  const viewed = (steps) =>
    Object.fromEntries(
      Object.entries(steps).map(([step, [answers, view]]) => [
        step,
        view(answers[0]),
      ]),
    );

  describe.each(['native', 'wasm'])('%s sender', (senderKind) => {
    covered(
      [
        'OlmMachine.receiveSyncChanges',
        'OlmMachine.decryptRoomEvent',
        'OlmMachine.getRoomEventEncryptionInfo',
        'OlmMachine.updateTrackedUsers',
      ],
      'decrypts on native and WASM with the same results',
      async () => {
        const exchanged = await exchange(
          new Homeserver(requestShape),
          senderKind,
        );
        const { sender, content } = exchanged;
        for (const [step, [answers, view]] of Object.entries(exchanged.steps)) {
          expectSame(answers, step, view);
        }
        const steps = Object.fromEntries(
          Object.entries(exchanged.steps).map(([step, [answers, view]]) => [
            step,
            answers.map(view),
          ]),
        );

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

  // The first request of each type a native device sent (from outgoingRequests,
  // getMissingSessions, shareRoomKey) and the answer to marking it as sent are compared with
  // WASM's; so is the content each sender encrypted, by shape.
  covered(
    [
      'OlmMachine.outgoingRequests',
      'OlmMachine.markRequestAsSent',
      'OlmMachine.getMissingSessions',
      'OlmMachine.shareRoomKey',
      'OlmMachine.encryptRoomEvent',
    ],
    'emits the same request shapes as WASM and matches the golden file',
    async () => {
      const server = new Homeserver(requestShape);
      const native = await exchange(server, 'native');
      const other = await exchange(server, 'wasm');

      const { RequestType } = wasm;
      expect(Object.keys(server.shapes.wasm).map(Number).sort()).toEqual(
        [
          RequestType.KeysUpload,
          RequestType.KeysQuery,
          RequestType.KeysClaim,
          RequestType.ToDevice,
        ].sort(),
      );
      server.expectSameRequests();
      // Fresh ciphertext: the encrypted content by shape.
      expectSame(
        [native.encrypted, other.encrypted],
        'encryptRoomEvent',
        ([content]) => shape(JSON.parse(content)),
      );
      // The golden file predates the `tracked` step, which answers nothing.
      const responses = Object.fromEntries(
        Object.entries(viewed(native.steps))
          .filter(([step]) => step !== 'tracked')
          .map(([step, answer]) => [step, shape(answer)]),
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
