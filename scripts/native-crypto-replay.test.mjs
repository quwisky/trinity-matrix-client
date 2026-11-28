/**
 * What the shim relies on when it replays a sync input after the crate dropped a machine
 * (libs/native/crypto-backend/src/native/machine.ts, REPLAYABLE): the machine is reloaded from its
 * store with `init` and gets the same `receiveSyncChanges` input again.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as wasm from '@matrix-org/matrix-sdk-crypto-wasm';
import {
  Homeserver,
  hasCargo,
  roomEvent,
  shareRoom,
  skipped,
  useDevices,
} from './native-crypto-harness.mjs';

const { Decrypted, UnableToDecrypt } = wasm.ProcessedToDeviceEventType;

describe.skipIf(!hasCargo)(
  `a sync input replayed on a reloaded machine${skipped}`,
  () => {
    const device = useDevices();
    const directory = mkdtempSync(join(tmpdir(), 'native-crypto-replay-'));
    afterAll(() => rmSync(directory, { recursive: true, force: true }));

    it('keeps the room key, answers the replayed Olm message as undecryptable and uploads no published one-time key again', async () => {
      const init = {
        storePath: join(directory, 'store'),
        storeKey: randomBytes(32).toString('base64'),
      };
      const server = new Homeserver();
      const sender = await device('wasm');
      const receiver = await device('native', { init });
      const roomId = '!replay:localhost';
      await shareRoom(server, sender, [receiver], roomId);
      const ownKeys = () =>
        server.oneTimeKeys.get(`${receiver.userId}|${receiver.deviceId}`) ?? [];
      const input = [
        JSON.stringify(server.pending(receiver)),
        { signed_curve25519: ownKeys().length },
      ];
      server.take(receiver.userId, receiver.deviceId);

      const first = await receiver.receiveSyncChanges(...input);
      expect(first.map(({ type }) => type)).toEqual([Decrypted]);
      await server.flush(receiver);
      const published = new Set(ownKeys().map(([id]) => id));
      expect(published.size).toBeGreaterThan(0);

      // As after a panic: the machine is gone, `init` reloads it from the store.
      expect((await receiver.respond('close')).error).toBeUndefined();
      expect((await receiver.respond('init', init)).error).toBeUndefined();
      const replayed = await receiver.receiveSyncChanges(...input);
      expect(replayed.map(({ type }) => type)).toEqual([UnableToDecrypt]);

      const content = { msgtype: 'm.text', body: 'after the replay' };
      const encrypted = await sender.encryptRoomEvent(
        roomId,
        'm.room.message',
        JSON.stringify(content),
      );
      const decrypted = await receiver.decryptRoomEvent(
        roomEvent(sender, roomId, encrypted),
        roomId,
      );
      expect(decrypted.error).toBeUndefined();
      expect(JSON.parse(decrypted.result.event).content).toEqual(content);

      for (const request of await receiver.outgoingRequests()) {
        if (request.type !== wasm.RequestType.KeysUpload) continue;
        const uploaded = Object.keys(
          JSON.parse(request.body).one_time_keys ?? {},
        );
        expect(uploaded.filter((id) => published.has(id))).toEqual([]);
      }
    });
  },
);
