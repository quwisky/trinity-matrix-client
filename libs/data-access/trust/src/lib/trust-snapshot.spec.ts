import { describe, expect, it, vi } from 'vitest';
import type {
  TrustCryptoApi,
  TrustMatrixClient,
} from '@trinity/data-access/matrix-client';
import {
  holdsAllCrossSigningPrivates,
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
  };
  return {
    client: client as unknown as TrustMatrixClient,
    crypto: crypto as unknown as TrustCryptoApi,
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
    const { client, crypto } = account({
      publicKeysOnDevice: true,
      privates: ALL_PRIVATES,
    });

    await expect(readTrustSnapshot(client, crypto)).resolves.toMatchObject({
      status: 'needs-setup',
    });
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

    await expect(identityHeldElsewhere(crypto)).resolves.toBe(true);
  });

  it('is false when the account has no published identity', async () => {
    const { crypto } = account({ privates: ALL_PRIVATES });

    await expect(identityHeldElsewhere(crypto)).resolves.toBe(false);
  });
});
describe('holdsAllCrossSigningPrivates', () => {
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
    }) as Parameters<typeof holdsAllCrossSigningPrivates>[0];

  it('is true only when all three private keys are cached locally', () => {
    expect(holdsAllCrossSigningPrivates(status(true, true, true))).toBe(true);
    expect(holdsAllCrossSigningPrivates(status(true, true, false))).toBe(false);
    expect(holdsAllCrossSigningPrivates(status(false, false, false))).toBe(
      false,
    );
  });
});
