import { TestBed } from '@angular/core/testing';
import { describe, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { defineTrustEngineContract } from '../../contract/trust-engine.contract';
import { JsSdkTrustEngine } from './js-sdk-trust-engine';
import type { MatrixClient } from 'matrix-js-sdk';
import {
  baseUrl,
  cs,
  localpart,
  login,
  publishIdentityElsewhere,
  register,
  startSecondDevice,
  startSession,
  useSynapseSuite,
} from './synapse.spec-harness';

// Real Rust crypto: the WASM loads from the package's Node entry, not a served asset.
vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const { from: rxFrom, map: rxMap } = await import('rxjs');
  const { initAsync } = await import('@matrix-org/matrix-sdk-crypto-wasm');
  return {
    ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
    preloadCryptoWasm: () => rxFrom(initAsync()).pipe(rxMap(() => undefined)),
  };
});

// Runs the trust contract against a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS is set.
describe.skipIf(!baseUrl)('JsSdkTrustEngine against Synapse', () => {
  useSynapseSuite();

  defineTrustEngineContract(
    async () => {
      const session = await startSession(await register(localpart('alice')));
      const devices: MatrixClient[] = [];
      const bob = await register(localpart('bob'));
      const crypto = () => {
        const found = TestBed.inject(JS_SDK_CLIENTS)
          .clientFor(session.userId)
          ?.getCrypto();
        if (!found) throw new Error('No crypto for alice');
        return found;
      };
      let sharedRoom = false;
      return {
        engine: TestBed.inject(JsSdkTrustEngine),
        alice: session.userId,
        password: session.password,
        deviceId: session.deviceId,
        bob: bob.userId,
        addDevice: async () => (await login(session)).device_id,
        publishIdentityElsewhere: () => publishIdentityElsewhere(session),
        bobPublishesIdentity: async () => {
          // A shared encrypted room makes alice track bob, so his key changes reach her.
          if (!sharedRoom) {
            const { room_id: roomId } = (await cs(
              bob.accessToken,
              'POST',
              '/createRoom',
              {
                invite: [session.userId],
                initial_state: [
                  {
                    type: 'm.room.encryption',
                    state_key: '',
                    content: { algorithm: 'm.megolm.v1.aes-sha2' },
                  },
                ],
              },
            )) as { room_id: string };
            await cs(
              session.accessToken,
              'POST',
              `/join/${encodeURIComponent(roomId)}`,
              {},
            );
          }
          await publishIdentityElsewhere(bob);
          if (sharedRoom) return;
          sharedRoom = true;
          // Bob's first identity must be pinned before a change can need approval.
          for (let i = 0; i < 120; i++) {
            if (await crypto().userHasCrossSigningKeys(bob.userId)) return;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          throw new Error("Alice never saw bob's identity");
        },
        publishIdentity: async () => {
          await crypto().bootstrapCrossSigning({
            setupNewCrossSigning: true,
            authUploadDeviceSigningKeys: async (makeRequest) => {
              await makeRequest({
                type: 'm.login.password',
                identifier: { type: 'm.id.user', user: session.userId },
                password: session.password,
              });
            },
          });
        },
        setServerDefaultKey: async (keyId) => {
          await cs(
            session.accessToken,
            'PUT',
            `/user/${encodeURIComponent(session.userId)}/account_data/m.secret_storage.default_key`,
            { key: keyId },
          );
        },
        secondDevice: async () => {
          const { client, deviceId } = await startSecondDevice(session);
          devices.push(client);
          const crypto = client.getCrypto();
          if (!crypto) throw new Error('No crypto on the second device');
          return {
            deviceId,
            requestVerification: async () => {
              // The second device must know the identity it asks to be verified against.
              await crypto.userHasCrossSigningKeys(session.userId, true);
              await crypto.requestOwnUserVerification();
            },
          };
        },
        directRoom: async () => {
          const bob = await register(localpart('bob'));
          await publishIdentityElsewhere(bob);
          const { room_id: roomId } = (await cs(
            session.accessToken,
            'POST',
            '/createRoom',
            {
              invite: [bob.userId],
              is_direct: true,
              preset: 'trusted_private_chat',
              initial_state: [
                {
                  type: 'm.room.encryption',
                  state_key: '',
                  content: { algorithm: 'm.megolm.v1.aes-sha2' },
                },
              ],
            },
          )) as { room_id: string };
          await cs(
            bob.accessToken,
            'POST',
            `/join/${encodeURIComponent(roomId)}`,
            {},
          );
          return { userId: bob.userId, roomId };
        },
        dispose: async () => {
          for (const device of devices) device.stopClient();
          await session.dispose();
        },
      };
    },
    { settleTimeoutMs: 30_000, testTimeoutMs: 180_000 },
  );
});
