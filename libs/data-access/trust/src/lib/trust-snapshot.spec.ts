import { describe, expect, it, vi } from 'vitest';
import type {
  TrustCryptoApi,
  TrustMatrixClient,
} from '@trinity/data-access/matrix-client';
import {
  holdsCrossSigningIdentity,
  identityHeldElsewhere,
  readTrustSnapshot,
} from './trust-snapshot';

interface AccountState {
  crossSigningReady?: boolean;
  secretStorageReady?: boolean;
  backupVersion?: string | null;
  defaultKeyId?: string | null;
  deviceVerified?: boolean;
  publicKeysOnDevice?: boolean;
  privates?: { master: boolean; selfSigning: boolean; userSigning: boolean };
  /**
   * Whether `/keys/query` returns the account's master key. Defaults to
   * `crossSigningReady`: a device normally reads ready only after its upload.
   */
  masterKeyOnServer?: boolean;
}

function account(state: AccountState = {}) {
  const privates = state.privates ?? {
    master: false,
    selfSigning: false,
    userSigning: false,
  };
  const crypto = {
    isCrossSigningReady: vi.fn(async () => state.crossSigningReady ?? false),
    isSecretStorageReady: vi.fn(async () => state.secretStorageReady ?? false),
    getActiveSessionBackupVersion: vi.fn(
      async () => state.backupVersion ?? null,
    ),
    getDeviceVerificationStatus: vi.fn(async () => ({
      crossSigningVerified: state.deviceVerified ?? false,
    })),
    getCrossSigningStatus: vi.fn(async () => ({
      publicKeysOnDevice: state.publicKeysOnDevice ?? false,
      privateKeysInSecretStorage: false,
      privateKeysCachedLocally: {
        masterKey: privates.master,
        selfSigningKey: privates.selfSigning,
        userSigningKey: privates.userSigning,
      },
    })),
  };
  const client = {
    getDeviceId: () => 'DEVICE',
    getUserId: () => '@me:hs',
    secretStorage: {
      getDefaultKeyId: vi.fn(async () => state.defaultKeyId ?? null),
    },
    downloadKeysForUsers: vi.fn(async (userIds: string[]) =>
      (state.masterKeyOnServer ?? state.crossSigningReady ?? false)
        ? {
            master_keys: {
              [userIds[0]]: {
                user_id: userIds[0],
                usage: ['master'],
                keys: { 'ed25519:MASTER': 'MASTER' },
              },
            },
          }
        : {},
    ),
  };
  return {
    client: client as unknown as TrustMatrixClient,
    crypto: crypto as unknown as TrustCryptoApi,
    downloadKeysForUsers: client.downloadKeysForUsers,
  };
}

const ALL_PRIVATES = { master: true, selfSigning: true, userSigning: true };

describe('readTrustSnapshot', () => {
  it('is ready when cross-signing and secret storage are both ready', async () => {
    const { client, crypto } = account({
      crossSigningReady: true,
      secretStorageReady: true,
      backupVersion: '3',
      deviceVerified: true,
      defaultKeyId: 'k',
    });

    await expect(readTrustSnapshot(client, crypto)).resolves.toEqual({
      status: 'ready',
      keyBackupActive: true,
      thisDeviceVerified: true,
      identityElsewhere: false,
    });
  });

  describe('an identity this device made but never published (#1225)', () => {
    // A first setup cancelled at the password prompt created the keys on this device and
    // uploaded none; a retry then stored them in secret storage. Every local read says
    // ready, but no other device can ever use that recovery key.
    const unpublished = {
      crossSigningReady: true,
      secretStorageReady: true,
      backupVersion: '3',
      deviceVerified: true,
      defaultKeyId: 'k',
      privates: ALL_PRIVATES,
      masterKeyOnServer: false,
    } satisfies AccountState;

    it('is not ready while the server has no master key', async () => {
      const { client, crypto, downloadKeysForUsers } = account(unpublished);

      await expect(readTrustSnapshot(client, crypto)).resolves.toMatchObject({
        status: 'needs-recovery',
      });
      expect(downloadKeysForUsers).toHaveBeenCalledWith(['@me:hs']);
    });

    it('stays ready when the server cannot be asked', async () => {
      // A status read must not flip a ready device whenever it is offline.
      const { client, crypto, downloadKeysForUsers } = account(unpublished);
      downloadKeysForUsers.mockRejectedValue(new Error('offline'));

      await expect(readTrustSnapshot(client, crypto)).resolves.toMatchObject({
        status: 'ready',
      });
    });

    it('asks the server only when this device reads ready', async () => {
      const { client, crypto, downloadKeysForUsers } = account({
        defaultKeyId: 'k',
      });

      await readTrustSnapshot(client, crypto);

      expect(downloadKeysForUsers).not.toHaveBeenCalled();
    });

    it('asks again until the server has the identity, then stops asking', async () => {
      const { client, crypto, downloadKeysForUsers } = account(unpublished);

      await readTrustSnapshot(client, crypto);
      await readTrustSnapshot(client, crypto);
      expect(downloadKeysForUsers).toHaveBeenCalledTimes(2);

      downloadKeysForUsers.mockResolvedValue({
        master_keys: { '@me:hs': { keys: { 'ed25519:M': 'M' } } },
      });
      await expect(readTrustSnapshot(client, crypto)).resolves.toMatchObject({
        status: 'ready',
      });
      await readTrustSnapshot(client, crypto);
      expect(downloadKeysForUsers).toHaveBeenCalledTimes(3);
    });
  });

  it('needs recovery when the account has secret storage this device has not unlocked', async () => {
    const { client, crypto } = account({
      defaultKeyId: 'k',
      publicKeysOnDevice: true,
    });

    await expect(readTrustSnapshot(client, crypto)).resolves.toMatchObject({
      status: 'needs-recovery',
    });
  });

  it('needs verification when another device published an identity and there is no recovery', async () => {
    const { client, crypto } = account({ publicKeysOnDevice: true });

    await expect(readTrustSnapshot(client, crypto)).resolves.toMatchObject({
      status: 'needs-verification',
      thisDeviceVerified: false,
      identityElsewhere: true,
    });
  });

  it('needs setup when the account has no identity at all', async () => {
    const { client, crypto } = account();

    await expect(readTrustSnapshot(client, crypto)).resolves.toMatchObject({
      status: 'needs-setup',
    });
  });

  it('needs setup when this device holds the identity and only recovery is missing', async () => {
    // A device that completed setup: its privates verify the published identity.
    const { client, crypto } = account({
      publicKeysOnDevice: true,
      privates: ALL_PRIVATES,
      crossSigningReady: true,
      deviceVerified: true,
    });

    await expect(readTrustSnapshot(client, crypto)).resolves.toMatchObject({
      status: 'needs-setup',
      identityElsewhere: false,
    });
  });

  // A reset cancelled at the password prompt rotates all three privates in the olm
  // machine and never uploads them, so the own identity does not verify against them.
  // Those privates are not the identity: offering setup here would store them in 4S.
  it('does not count privates that fail to verify the published identity as holding it', async () => {
    const { client, crypto } = account({
      publicKeysOnDevice: true,
      privates: ALL_PRIVATES,
      crossSigningReady: false,
    });

    await expect(readTrustSnapshot(client, crypto)).resolves.toMatchObject({
      status: 'needs-verification',
      identityElsewhere: true,
    });
  });

  it('says a verified device holding stranded privates still lacks the identity', async () => {
    const { client, crypto } = account({
      publicKeysOnDevice: true,
      privates: ALL_PRIVATES,
      crossSigningReady: false,
      deviceVerified: true,
    });

    await expect(readTrustSnapshot(client, crypto)).resolves.toMatchObject({
      thisDeviceVerified: true,
      identityElsewhere: true,
    });
  });

  it('propagates a failed crypto read instead of reporting needs-setup', async () => {
    const { client, crypto } = account({ publicKeysOnDevice: true });
    vi.mocked(crypto.getCrossSigningStatus).mockRejectedValue(
      new Error('olm machine closed'),
    );

    await expect(readTrustSnapshot(client, crypto)).rejects.toThrow(
      'olm machine closed',
    );
  });

  it('propagates a failed readiness read instead of reporting needs-setup', async () => {
    const { client, crypto } = account();
    vi.mocked(crypto.isCrossSigningReady).mockRejectedValue(
      new Error('store unavailable'),
    );

    await expect(readTrustSnapshot(client, crypto)).rejects.toThrow(
      'store unavailable',
    );
  });

  it('does not ask a device that is already verified to verify again', async () => {
    const { client, crypto } = account({
      publicKeysOnDevice: true,
      deviceVerified: true,
    });

    await expect(readTrustSnapshot(client, crypto)).resolves.toMatchObject({
      status: 'needs-setup',
      thisDeviceVerified: true,
    });
  });

  // A device verified by another one, on an Account without secret storage, never
  // receives the cross-signing privates (matrix-js-sdk 43 does not request missing
  // secrets after verification). Setup here would replace the identity, so consumers
  // need to know that only the holding device can set up recovery.
  it('says the identity is held elsewhere when a verified device lacks its private keys', async () => {
    const { client, crypto } = account({
      publicKeysOnDevice: true,
      deviceVerified: true,
    });

    await expect(readTrustSnapshot(client, crypto)).resolves.toMatchObject({
      status: 'needs-setup',
      thisDeviceVerified: true,
      identityElsewhere: true,
    });
  });

  it('does not say the identity is held elsewhere when there is none or this device holds it', async () => {
    const none = account({ deviceVerified: true });
    const held = account({
      publicKeysOnDevice: true,
      deviceVerified: true,
      privates: ALL_PRIVATES,
      crossSigningReady: true,
    });

    await expect(
      readTrustSnapshot(none.client, none.crypto),
    ).resolves.toMatchObject({
      status: 'needs-setup',
      identityElsewhere: false,
    });
    await expect(
      readTrustSnapshot(held.client, held.crypto),
    ).resolves.toMatchObject({
      status: 'needs-setup',
      identityElsewhere: false,
    });
  });

  it('only reports the identity as held elsewhere when the account has no recovery', async () => {
    // With secret storage the privates are reachable through recovery, so "elsewhere"
    // would mislead: the answer there is the recovery key, not the other device.
    const { client, crypto } = account({
      defaultKeyId: 'k',
      publicKeysOnDevice: true,
    });

    await expect(readTrustSnapshot(client, crypto)).resolves.toMatchObject({
      status: 'needs-recovery',
      identityElsewhere: false,
    });
  });
});

describe('identityHeldElsewhere', () => {
  it('is true when this device holds only some of the private keys', async () => {
    const { crypto } = account({
      publicKeysOnDevice: true,
      privates: { master: true, selfSigning: false, userSigning: true },
    });

    await expect(identityHeldElsewhere(crypto, false)).resolves.toBe(true);
  });

  it('is true when this device holds all three privates but they do not match', async () => {
    const { crypto } = account({
      publicKeysOnDevice: true,
      privates: ALL_PRIVATES,
    });

    await expect(identityHeldElsewhere(crypto, false)).resolves.toBe(true);
  });

  it('is false when this device holds the matching private keys', async () => {
    const { crypto } = account({
      publicKeysOnDevice: true,
      privates: ALL_PRIVATES,
    });

    await expect(identityHeldElsewhere(crypto, true)).resolves.toBe(false);
  });

  it('is false when the account has no published identity', async () => {
    const { crypto } = account({ privates: ALL_PRIVATES });

    await expect(identityHeldElsewhere(crypto, false)).resolves.toBe(false);
  });
});

describe('holdsCrossSigningIdentity', () => {
  const status = (
    master: boolean,
    selfSigning: boolean,
    userSigning: boolean,
  ) =>
    ({
      publicKeysOnDevice: true,
      privateKeysInSecretStorage: false,
      privateKeysCachedLocally: {
        masterKey: master,
        selfSigningKey: selfSigning,
        userSigningKey: userSigning,
      },
    }) as Parameters<typeof holdsCrossSigningIdentity>[0];

  it('is true only when all three private keys are cached locally', () => {
    expect(holdsCrossSigningIdentity(status(true, true, true), true)).toBe(
      true,
    );
    expect(holdsCrossSigningIdentity(status(true, true, false), true)).toBe(
      false,
    );
    expect(holdsCrossSigningIdentity(status(false, false, false), true)).toBe(
      false,
    );
  });

  it('is false for a full set of privates the published identity does not verify', () => {
    expect(holdsCrossSigningIdentity(status(true, true, true), false)).toBe(
      false,
    );
  });
});
