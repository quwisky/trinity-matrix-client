/**
 * matrix-js-sdk's own crypto layer (`initRustCrypto`) on the native crypto shim, against a real
 * homeserver: clients on the shim (the crate's CLI as the bridge) and on plain WASM exchange
 * encrypted messages and must see the same thing. The same flows run with every client on WASM
 * as the control, so a broken test bed fails there too.
 *
 * Needs cargo (the CLI) and Docker (the disposable homeserver); see native-crypto-sdk-support.mjs.
 * The trust flows (cross-signing, backup, devices) are in native-crypto-sdk-trust.e2e.mjs.
 */
import { randomBytes } from 'node:crypto';
import * as wasm from '@matrix-org/matrix-sdk-crypto-wasm';
import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api/index.js';
import {
  api,
  closeBed,
  decrypted,
  deviceKeysOnServer,
  eventIn,
  joined,
  machineOf,
  missing,
  openBed,
  ORIENTATIONS,
  registerAndLogin,
  send,
  startClient,
  stopClient,
  until,
} from './native-crypto-sdk-support.mjs';

/** What a receiver reports about a decrypted event. */
const viewOf = async (party, event) => ({
  body: event.getClearContent().body,
  senderKey: event.getSenderKey(),
  claimedEd25519Key: event.getClaimedEd25519Key(),
  forwarder: event.getKeyForwardingUser?.() ?? null,
  info: await party.client.getCrypto().getEncryptionInfoForEvent(event),
});

describe.skipIf(missing)('matrix-js-sdk on the native crypto shim', () => {
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
        let roomId;
        const hasNative = aliceKind === 'native' || bobKind === 'native';
        const nativeName = aliceKind === 'native' ? 'alice' : 'bob';
        const otherName = nativeName === 'alice' ? 'bob' : 'alice';
        const message = {};

        afterAll(async () => {
          for (const party of Object.values(parties)) await stopClient(party);
        });

        it('logs in and uploads device keys the server accepts', async () => {
          const kinds = { alice: aliceKind, bob: bobKind, carol: 'wasm' };
          for (const [name, kind] of Object.entries(kinds)) {
            parties[name] = await startClient(
              kind,
              await registerAndLogin(name),
              {
                storeKey: kind === 'native' ? randomBytes(32) : undefined,
              },
            );
          }
          for (const party of Object.values(parties)) {
            expect(machineOf(party)).toBeInstanceOf(wasm.OlmMachine);
            expect(machineOf(party).__wbg_ptr === undefined).toBe(
              party.kind === 'native',
            );
            const own = await party.client.getCrypto().getOwnDeviceKeys();
            const { userId, deviceId } = party.account;
            for (const viewer of Object.values(parties)) {
              const devices = await until(
                async () =>
                  (await deviceKeysOnServer(viewer, party.account))[deviceId],
                `${userId}'s device keys on the server`,
              );
              expect(devices).toMatchObject({
                user_id: userId,
                device_id: deviceId,
                keys: {
                  [`ed25519:${deviceId}`]: own.ed25519,
                  [`curve25519:${deviceId}`]: own.curve25519,
                },
              });
            }
          }
          // A WASM client checks the signatures of what it downloads.
          const carol = parties.carol.client.getCrypto();
          for (const name of ['alice', 'bob']) {
            const { userId, deviceId } = parties[name].account;
            const devices = await carol.getUserDeviceInfo([userId], true);
            expect(devices.get(userId)?.get(deviceId)?.getIdentityKey()).toBe(
              (await parties[name].client.getCrypto().getOwnDeviceKeys())
                .curve25519,
            );
          }
        });

        it('creates an encrypted room that members join later, and decrypts both ways', async () => {
          const { alice, bob, carol } = parties;
          ({ room_id: roomId } = await alice.client.createRoom({
            initial_state: [
              {
                type: 'm.room.encryption',
                state_key: '',
                content: { algorithm: 'm.megolm.v1.aes-sha2' },
              },
            ],
          }));
          const encrypted = (party) =>
            until(
              () => party.client.getRoom(roomId)?.hasEncryptionStateEvent(),
              `${party.account.userId} to see the room encrypted`,
            );
          await encrypted(alice);
          message.alone = await send(alice, roomId, 'before anyone joined');
          await decrypted(alice, roomId, message.alone, 'its own message');
          for (const member of [bob, carol]) {
            await alice.client.invite(roomId, member.account.userId);
            await until(
              () => member.client.getRoom(roomId),
              `${member.account.userId} to get the invite`,
            );
            await member.client.joinRoom(roomId);
            await encrypted(member);
          }
          for (const viewer of [alice, bob, carol]) {
            for (const member of [alice, bob, carol]) {
              await joined(viewer, roomId, member.account.userId);
            }
          }
          message.fromAlice = await send(alice, roomId, 'hello from alice');
          message.fromBob = await send(bob, roomId, 'hello from bob');
          for (const [from, eventId, body] of [
            ['alice', message.fromAlice, 'hello from alice'],
            ['bob', message.fromBob, 'hello from bob'],
          ]) {
            for (const [name, party] of Object.entries(parties)) {
              const event = await decrypted(party, roomId, eventId, body);
              expect(
                event.getClearContent().body,
                `${name} reads ${from}`,
              ).toBe(body);
            }
          }
        });

        it('reports the same encryption info for an event as a WASM receiver', async () => {
          const { carol } = parties;
          // Each message has a receiver on each kind when one of alice and bob is native.
          for (const [sender, eventId] of [
            ['alice', message.fromAlice],
            ['bob', message.fromBob],
          ]) {
            const receiver = parties[sender === 'alice' ? 'bob' : 'alice'];
            const [mine, wasmView] = await Promise.all(
              [receiver, carol].map(async (party) =>
                viewOf(party, await decrypted(party, roomId, eventId, sender)),
              ),
            );
            expect(mine).toEqual(wasmView);
            expect(mine.info).not.toBeNull();
          }
        });

        it('decrypts after the other side rotates its session', async () => {
          for (const [sender, receivers] of [
            ['alice', ['bob', 'carol']],
            ['bob', ['alice', 'carol']],
          ]) {
            const party = parties[sender];
            const before = eventIn(
              party,
              roomId,
              message[sender === 'alice' ? 'fromAlice' : 'fromBob'],
            ).getWireContent().session_id;
            await party.client.getCrypto().forceDiscardSession(roomId);
            const eventId = await send(party, roomId, `rotated by ${sender}`);
            for (const name of receivers) {
              const event = await decrypted(
                parties[name],
                roomId,
                eventId,
                'a rotated session',
              );
              expect(event.getWireContent().session_id).not.toBe(before);
              expect(event.getClearContent().body).toBe(`rotated by ${sender}`);
            }
          }
        });

        it('decrypts a message whose room key arrives after it', async () => {
          for (const [sender, receiver] of [
            ['alice', 'bob'],
            ['bob', 'alice'],
          ]) {
            const to = parties[receiver];
            to.network.holding = true;
            await parties[sender].client
              .getCrypto()
              .forceDiscardSession(roomId);
            const eventId = await send(
              parties[sender],
              roomId,
              `late key from ${sender}`,
            );
            const failed = await until(() => {
              const event = eventIn(to, roomId, eventId);
              return event?.isDecryptionFailure() && event;
            }, `${receiver} to fail to decrypt before the key arrives`);
            expect(failed.decryptionFailureReason).toBe(
              DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID,
            );
            to.network.holding = false;
            const event = await decrypted(
              to,
              roomId,
              eventId,
              'once the key arrived',
            );
            expect(event.getClearContent().body).toBe(
              `late key from ${sender}`,
            );
          }
        });

        it.skipIf(!hasNative)(
          'restarts on the same store: old messages decrypt, the device stays, a wrong key fails closed',
          async () => {
            const native = parties[nativeName];
            const { account, storeKey } = native;
            const keysBefore = await native.client
              .getCrypto()
              .getOwnDeviceKeys();
            const deviceIds = async () =>
              (
                await api('/_matrix/client/v3/devices', {
                  token: account.accessToken,
                })
              ).devices
                .map((device) => device.device_id)
                .sort();
            const devicesBefore = await deviceIds();
            await stopClient(native);
            delete parties[nativeName];

            await expect(
              startClient('native', account, { storeKey: randomBytes(32) }),
            ).rejects.toThrow(/StoreError/);

            const again = await startClient('native', account, { storeKey });
            parties[nativeName] = again;
            expect(await again.client.getCrypto().getOwnDeviceKeys()).toEqual(
              keysBefore,
            );
            for (const [eventId, body] of [
              [message.fromAlice, 'hello from alice'],
              [message.fromBob, 'hello from bob'],
            ]) {
              const event = await decrypted(
                again,
                roomId,
                eventId,
                'an old message',
              );
              expect(event.getClearContent().body).toBe(body);
            }
            expect(await deviceIds()).toEqual(devicesBefore);
            const live = await send(
              parties[otherName],
              roomId,
              'after the restart',
            );
            await decrypted(again, roomId, live, 'a message after the restart');
            const reply = await send(again, roomId, 'back after the restart');
            await decrypted(
              parties[otherName],
              roomId,
              reply,
              'the restarted side',
            );
          },
          120_000,
        );

        it.skipIf(!hasNative)(
          'reloads a machine the crate dropped and goes on',
          async () => {
            const native = parties[nativeName];
            const other = parties[otherName];
            const { userId, deviceId } = native.account;
            const inits = () =>
              native.bridge.sent().filter((method) => method === 'init').length;
            const before = inits();
            // As a panic does: the crate drops the machine behind the shim's back.
            expect(
              JSON.parse(
                await native.bridge.call(
                  JSON.stringify({ method: 'close', userId, deviceId }),
                ),
              ),
            ).toEqual({ result: null });
            const fromOther = await send(other, roomId, 'after the drop');
            await decrypted(
              native,
              roomId,
              fromOther,
              'a message after the drop',
            );
            expect(inits()).toBe(before + 1);
            const fromNative = await send(
              native,
              roomId,
              'back after the drop',
            );
            await decrypted(other, roomId, fromNative, 'the reloaded side');
            expect(native.lost).toEqual([]);
          },
        );

        it.skipIf(!hasNative)(
          'loses the machine when the bridge dies: errors, no hang, no WASM fallback, and the sync waits',
          async () => {
            const native = parties[nativeName];
            const other = parties[otherName];
            native.bridge.kill();
            await until(() => native.lost.length > 0, 'the machine to be lost');
            // The sync in flight when the machine was lost may still go out once.
            await new Promise((done) => setTimeout(done, 1500));
            const syncs = native.network.syncs;
            await expect(
              native.client.getCrypto().forceDiscardSession(roomId),
            ).rejects.toThrow(/the machine is lost/);
            await expect(
              native.client.sendTextMessage(roomId, 'never sent'),
            ).rejects.toThrow();
            expect(machineOf(native).__wbg_ptr).toBeUndefined();

            // A new room key reaches the lost device's to-device inbox on the server.
            await other.client.getCrypto().forceDiscardSession(roomId);
            const eventId = await send(other, roomId, 'sent while lost');
            // A syncing client polls every second; this one waits on its sync input.
            await new Promise((done) => setTimeout(done, 3000));
            expect(native.network.syncs).toBe(syncs);
            expect(native.lost).toHaveLength(1);

            // The host stops the client; the next start on the same store gets the key.
            await stopClient(native);
            const again = await startClient('native', native.account, {
              storeKey: native.storeKey,
            });
            parties[nativeName] = again;
            const event = await decrypted(
              again,
              roomId,
              eventId,
              'the message sent while the machine was lost',
            );
            expect(event.getClearContent().body).toBe('sent while lost');
          },
          60_000,
        );
      },
    );
  }
});
