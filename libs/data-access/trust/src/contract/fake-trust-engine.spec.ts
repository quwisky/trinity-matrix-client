import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { decryptMegolmKeyFile } from '@trinity/util/matrix';
import { defineTrustEngineContract } from './trust-engine.contract';
import { FakeTrustEngine } from './fake-trust-engine';

defineTrustEngineContract(
  async () => {
    const engine = new FakeTrustEngine();
    return {
      engine,
      alice: engine.alice,
      password: engine.password,
      deviceId: engine.deviceIdOf(engine.alice),
      bob: '@bob:contract.invalid',
      addDevice: async () => engine.addDevice(engine.alice),
      publishIdentityElsewhere: async () =>
        engine.publishIdentityElsewhere(engine.alice),
      bobPublishesIdentity: async () =>
        engine.publishUserIdentity(engine.alice, '@bob:contract.invalid'),
      publishIdentity: async () => engine.publishIdentity(engine.alice),
      setServerDefaultKey: async (keyId) =>
        engine.setServerDefaultKey(engine.alice, keyId),
      secondDevice: async () => ({
        deviceId: 'SECOND',
        requestVerification: async () => {
          engine.receiveVerification(engine.alice, { otherDeviceId: 'SECOND' });
        },
      }),
      directRoom: async () => {
        const userId = '@bob:contract.invalid';
        engine.addUserIdentity(userId);
        return { userId, roomId: '!dm:contract.invalid' };
      },
      setUpRecoveryElsewhere: async (passphrase) =>
        engine.setUpRecoveryElsewhere(engine.alice, passphrase),
      strandUnpublishedIdentity: async () =>
        engine.strandUnpublishedIdentity(engine.alice),
      exportFromAnotherSession: (passphrase) =>
        engine.exportFromAnotherSession(passphrase),
      importInAnotherSession: async (fileText, passphrase) =>
        (
          JSON.parse(await decryptMegolmKeyFile(fileText, passphrase)) as {
            session_id: string;
          }[]
        ).map((key) => key.session_id),
      dispose: async () => undefined,
    };
  },
  { settleTimeoutMs: 1_000, testTimeoutMs: 5_000 },
);

describe('FakeTrustEngine identities', () => {
  it('withdrawing a verification clears wasVerified, and only that', async () => {
    const engine = new FakeTrustEngine();
    const bob = '@bob:contract.invalid';
    engine.setUserTrust(engine.alice, bob, {
      wasVerified: true,
      needsApproval: true,
    });

    await firstValueFrom(engine.withdrawVerification(engine.alice, bob));

    expect(await firstValueFrom(engine.userTrust(engine.alice, bob))).toEqual({
      ok: true,
      value: { verified: false, wasVerified: false, needsApproval: true },
    });
  });
});
