import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixError } from 'matrix-js-sdk';
import { setup } from './trust.spec-harness';

// PBKDF2 (WebCrypto subtle) isn't available in the test environment, so stub the
// passphrase derivation while keeping the real encode/decode + CryptoEvent.
vi.mock('matrix-js-sdk/lib/crypto-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('matrix-js-sdk/lib/crypto-api')>();
  return {
    ...actual,
    deriveRecoveryKeyFromPassphrase: vi.fn(async () => new Uint8Array(32)),
  };
});

beforeEach(() => TestBed.resetTestingModule());

// TrustService over the js-sdk engine on SDK doubles: the setup guards end to end. The
// upload's password handling is in js-sdk/js-sdk-trust-engine.reset.spec.ts.

describe('setUp', () => {
  it('bootstraps cross-signing, secret storage and key backup, returning the recovery key', async () => {
    const { svc, crypto } = setup({
      crossSigningReady: true,
      secretStorageReady: true,
      defaultKeyId: 'k',
      recoveryKey: {
        encodedPrivateKey: 'EsTShown',
        privateKey: new Uint8Array(32),
      },
    });

    const shown = await firstValueFrom(svc.setUp(async () => 'pw'));

    expect(shown).toBe('EsTShown');
    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledOnce();
    expect(
      crypto.bootstrapCrossSigning.mock.calls[0][0].authUploadDeviceSigningKeys,
    ).toBeTypeOf('function');

    const ssOpts = crypto.bootstrapSecretStorage.mock.calls[0][0];
    expect(ssOpts.setupNewKeyBackup).toBe(true);
    // createSecretStorageKey yields the pre-generated key so we control the display.
    await expect(ssOpts.createSecretStorageKey()).resolves.toMatchObject({
      encodedPrivateKey: 'EsTShown',
    });
  });

  it('asks the SERVER whether the account already has a 4S key', async () => {
    const { svc, client } = setup();

    await firstValueFrom(svc.setUp(async () => 'pw'));

    expect(client.http.authedRequest).toHaveBeenCalledWith(
      'GET',
      '/user/%40me%3Ahs/account_data/m.secret_storage.default_key',
    );
  });

  it('refuses to mint a second 4S key when the account already has one', async () => {
    // The destination of the hazard: `needs-setup` is derived from the LOCAL store, and
    // a lost /sync echo leaves that store reading null for up to the ~110s the sync loop
    // takes to notice. Setting up again from there mints a new 4S key over the user's
    // still-valid one and deletes every key-backup version, on one click.
    const { svc, crypto, client } = setup({ defaultKeyId: null });
    client.http.authedRequest.mockResolvedValue({ key: 'still-valid' });

    await expect(firstValueFrom(svc.setUp(async () => 'pw'))).rejects.toThrow(
      /already has a recovery key/i,
    );

    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
    expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
    expect(crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
  });

  it('does not trust this device’s own view of the pointer for that refusal', async () => {
    // The local store is exactly what is wrong in the scenario this guards, so a
    // getDefaultKeyId() read would answer null and wave the destruction through.
    const { svc, secretStorage, client } = setup({ defaultKeyId: null });
    client.http.authedRequest.mockResolvedValue({ key: 'still-valid' });

    await expect(firstValueFrom(svc.setUp(async () => 'pw'))).rejects.toThrow(
      /already has a recovery key/i,
    );

    expect(secretStorage.getDefaultKeyId).not.toHaveBeenCalled();
  });

  for (const [label, failure] of [
    [
      'the account genuinely has none',
      new MatrixError({ errcode: 'M_NOT_FOUND' }, 404),
    ],
    ['the read itself fails', new Error('network down')],
  ] as const) {
    it(`goes ahead when ${label}`, async () => {
      // Fails OPEN on purpose: this exists to stop a known-destructive action, not to
      // become a new way for genuine first-run setup to fail.
      const { svc, crypto, client } = setup();
      client.http.authedRequest.mockRejectedValue(failure);

      await expect(firstValueFrom(svc.setUp(async () => 'pw'))).resolves.toBe(
        'EsTRecoveryKey',
      );
      expect(crypto.bootstrapSecretStorage).toHaveBeenCalledOnce();
    });
  }

  it('refuses to replace an identity another device holds', async () => {
    const { svc, crypto } = setup({ identityOnServer: true });

    await expect(
      firstValueFrom(svc.setUp(async () => 'pw')),
    ).rejects.toMatchObject({
      operation: 'setup',
      kind: 'stale-state',
      recovery: 'verify-another-device',
      message: expect.stringMatching(/already has encryption set up/i),
    });

    expect(crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
    expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
  });

  it('asks an unverified device to verify with the device that holds the identity', async () => {
    const { svc } = setup({ identityOnServer: true, deviceVerified: false });

    await expect(
      firstValueFrom(svc.setUp(async () => 'pw')),
    ).rejects.toMatchObject({
      kind: 'stale-state',
      message: expect.stringMatching(/verify this device with that device/i),
    });
  });

  it('sends a verified device to set up recovery where the identity is held', async () => {
    // Already verified with that device, so "verify with it" would be a dead end.
    const { svc, crypto } = setup({
      identityOnServer: true,
      deviceVerified: true,
    });

    const failure = firstValueFrom(svc.setUp(async () => 'pw'));
    await expect(failure).rejects.toMatchObject({
      operation: 'setup',
      kind: 'stale-state',
      recovery: 'review-security-settings',
      message: expect.stringMatching(/set up recovery on that device/i),
    });
    await expect(failure).rejects.not.toMatchObject({
      message: expect.stringMatching(/verify this device/i),
    });
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it('still refuses when it cannot tell whether this device is verified', async () => {
    const { svc, crypto } = setup({ identityOnServer: true });
    crypto.getDeviceVerificationStatus.mockRejectedValue(new Error('store'));

    await expect(
      firstValueFrom(svc.setUp(async () => 'pw')),
    ).rejects.toMatchObject({
      kind: 'stale-state',
      message: expect.stringMatching(/verify this device with that device/i),
    });
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it('asks the server even when this device has not yet seen the identity', async () => {
    // Right after sign-in the own identity may not be downloaded yet, so the local
    // cross-signing status reads "no identity". The server is the authority here.
    const { svc, crypto } = setup({
      identityOnServer: false,
      masterKeyOnServer: true,
    });
    crypto.userHasCrossSigningKeys.mockResolvedValue(true);

    await expect(
      firstValueFrom(svc.setUp(async () => 'pw')),
    ).rejects.toMatchObject({ kind: 'stale-state' });

    expect(crypto.userHasCrossSigningKeys).toHaveBeenCalledWith(
      undefined,
      true,
    );
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it('goes ahead when this device holds the identity and only recovery is missing', async () => {
    // A device that completed setup: the privates are cached and the own identity
    // verifies against them, which is what isCrossSigningReady() reports.
    const { svc, crypto } = setup({
      identityOnServer: true,
      privatesCachedLocally: true,
      crossSigningReady: true,
    });

    await expect(firstValueFrom(svc.setUp(async () => 'pw'))).resolves.toBe(
      'EsTRecoveryKey',
    );
    expect(crypto.bootstrapSecretStorage).toHaveBeenCalledOnce();
  });

  it('refuses when the privates this device holds are not the published identity', async () => {
    // A reset cancelled at the password prompt: resetCrossSigning rotated all three
    // privates locally and never uploaded them. Setting up here would store those
    // unpublished seeds in 4S, minting a recovery key that can never verify a device.
    const { svc, crypto } = setup({
      identityOnServer: true,
      privatesCachedLocally: true,
      crossSigningReady: false,
    });

    await expect(
      firstValueFrom(svc.setUp(async () => 'pw')),
    ).rejects.toMatchObject({
      operation: 'setup',
      kind: 'stale-state',
      message: expect.stringMatching(/already has encryption set up/i),
    });

    expect(crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
    expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
  });

  it('judges the held privates only after re-reading the identity from the server', async () => {
    // userHasCrossSigningKeys(own, true) re-queries the own identity, so asking it
    // first means the local match is judged against the published copy.
    const { svc, crypto } = setup({
      identityOnServer: true,
      privatesCachedLocally: true,
      crossSigningReady: true,
    });

    await firstValueFrom(svc.setUp(async () => 'pw'));

    const serverRead =
      crypto.userHasCrossSigningKeys.mock.invocationCallOrder[0];
    expect(serverRead).toBeLessThan(
      crypto.isCrossSigningReady.mock.invocationCallOrder[0],
    );
    expect(serverRead).toBeLessThan(
      crypto.getCrossSigningStatus.mock.invocationCallOrder[0],
    );
  });

  it('stops asking once the server knows no identity, so a failing key query cannot block a fresh account', async () => {
    const { svc, crypto, client } = setup();
    client.downloadKeysForUsers.mockRejectedValue(new Error('offline'));

    await expect(firstValueFrom(svc.setUp(async () => 'pw'))).resolves.toBe(
      'EsTRecoveryKey',
    );
    // No identity after the re-query: no key query and no local identity read.
    expect(client.downloadKeysForUsers).not.toHaveBeenCalled();
    expect(crypto.getCrossSigningKeyId).not.toHaveBeenCalled();
  });

  it('shows a refused identity query as a permission refusal', async () => {
    const { svc, crypto } = setup();
    crypto.userHasCrossSigningKeys.mockRejectedValue(
      new MatrixError({ errcode: 'M_FORBIDDEN' }, 403),
    );

    await expect(
      firstValueFrom(svc.setUp(async () => 'pw')),
    ).rejects.toMatchObject({
      operation: 'setup',
      kind: 'permission-denied',
      recovery: 'retry',
    });
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it('goes ahead on a fresh account, whose server holds no identity yet', async () => {
    const { svc, crypto } = setup();

    await expect(firstValueFrom(svc.setUp(async () => 'pw'))).resolves.toBe(
      'EsTRecoveryKey',
    );
    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledOnce();
    // The SDK's own first-run path: nothing local, so it creates and uploads keys.
    expect(
      crypto.bootstrapCrossSigning.mock.calls[0][0].setupNewCrossSigning,
    ).toBeUndefined();
    expect(crypto.bootstrapSecretStorage).toHaveBeenCalledOnce();
  });

  describe('after a first setup that never uploaded its keys (#1225)', () => {
    /**
     * A first setup cancelled at the password prompt: resetCrossSigning created all
     * three keys on the device (CrossSigningIdentity.ts:139-167) and uploaded none. The
     * olm machine keeps the identity it made and marks it verified, so the device reads
     * as holding an identity while the server has none.
     */
    function unpublishedKeysOnDevice() {
      const fixture = setup({
        privatesCachedLocally: true,
        crossSigningReady: true,
        masterKeyOnServer: false,
      });
      fixture.crypto.userHasCrossSigningKeys.mockResolvedValue(true);
      return fixture;
    }

    it('creates and uploads new keys, since the server has none to replace', async () => {
      // Without setupNewCrossSigning, bootstrapCrossSigning sees privates on the device
      // and no secret storage and does nothing (CrossSigningIdentity.ts:72-78), so 4S
      // would then store keys no server ever saw.
      const { svc, crypto } = unpublishedKeysOnDevice();

      await expect(firstValueFrom(svc.setUp(async () => 'pw'))).resolves.toBe(
        'EsTRecoveryKey',
      );

      const opts = crypto.bootstrapCrossSigning.mock.calls[0][0];
      expect(opts.setupNewCrossSigning).toBe(true);
      expect(opts.authUploadDeviceSigningKeys).toBeTypeOf('function');
      expect(
        crypto.bootstrapCrossSigning.mock.invocationCallOrder[0],
      ).toBeLessThan(crypto.bootstrapSecretStorage.mock.invocationCallOrder[0]);
    });

    it('asks the server whether the identity was published, not this device', async () => {
      const { svc, client } = unpublishedKeysOnDevice();

      await firstValueFrom(svc.setUp(async () => 'pw'));

      expect(client.downloadKeysForUsers).toHaveBeenCalledWith(['@me:hs']);
    });

    it('still refuses when the server holds an identity this device does not', async () => {
      // #1214's guarantee: privates that do not match the published identity are not
      // the identity, and setup must never replace the one on the server.
      const { svc, crypto } = setup({
        privatesCachedLocally: true,
        crossSigningReady: false,
        masterKeyOnServer: true,
      });
      crypto.userHasCrossSigningKeys.mockResolvedValue(true);

      await expect(
        firstValueFrom(svc.setUp(async () => 'pw')),
      ).rejects.toMatchObject({ operation: 'setup', kind: 'stale-state' });

      expect(crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
      expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
      expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
    });

    it('refuses when the reads disagree and this device holds no identity', async () => {
      // The first read saw an identity, a lagging second read missed it, and this device
      // has none of its keys: creating new ones would replace an identity the server has.
      const { svc, crypto } = setup({
        identityOnServer: true,
        masterKeyOnServer: false,
      });

      await expect(
        firstValueFrom(svc.setUp(async () => 'pw')),
      ).rejects.toMatchObject({
        operation: 'setup',
        kind: 'server-failure',
        recovery: 'retry',
      });

      expect(crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
      expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
      expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
    });

    it('refuses when this device holds a different identity from the published one', async () => {
      // Another device published between this device's two reads: its own leftover
      // identity still reads as held, but it is not the one on the server.
      const { svc, crypto } = setup({
        identityOnServer: true,
        privatesCachedLocally: true,
        crossSigningReady: true,
        localMasterKey: 'OTHER',
      });

      await expect(
        firstValueFrom(svc.setUp(async () => 'pw')),
      ).rejects.toMatchObject({ operation: 'setup', kind: 'stale-state' });

      expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
      expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
    });

    it('keeps the published identity when this device holds it', async () => {
      const { svc, crypto } = setup({
        identityOnServer: true,
        privatesCachedLocally: true,
        crossSigningReady: true,
      });

      await firstValueFrom(svc.setUp(async () => 'pw'));

      expect(
        crypto.bootstrapCrossSigning.mock.calls[0][0].setupNewCrossSigning,
      ).toBeUndefined();
    });

    it('fails closed when the server cannot say whether the identity was published', async () => {
      const { svc, crypto, client } = unpublishedKeysOnDevice();
      client.downloadKeysForUsers.mockRejectedValue(new Error('offline'));

      await expect(
        firstValueFrom(svc.setUp(async () => 'pw')),
      ).rejects.toMatchObject({
        operation: 'setup',
        kind: 'server-failure',
        recovery: 'retry',
      });

      expect(crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
      expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
      expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
    });

    it('fails closed when the server never says whether the identity was published', async () => {
      vi.useFakeTimers();
      try {
        const { svc, crypto, client } = unpublishedKeysOnDevice();
        client.downloadKeysForUsers.mockReturnValue(
          new Promise(() => undefined),
        );

        const failure = firstValueFrom(svc.setUp(async () => 'pw'));
        const assertion = expect(failure).rejects.toMatchObject({
          operation: 'setup',
          kind: 'server-failure',
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await assertion;

        expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('fails closed when the server cannot say whether an identity exists', async () => {
    const { svc, crypto } = setup();
    crypto.userHasCrossSigningKeys.mockRejectedValue(new Error('offline'));

    await expect(
      firstValueFrom(svc.setUp(async () => 'pw')),
    ).rejects.toMatchObject({
      operation: 'setup',
      kind: 'server-failure',
      recovery: 'retry',
    });

    expect(crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
    expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
  });

  it('fails closed when the server never answers whether an identity exists', async () => {
    vi.useFakeTimers();
    try {
      const { svc, crypto } = setup();
      crypto.userHasCrossSigningKeys.mockReturnValue(
        new Promise(() => undefined),
      );

      const failure = firstValueFrom(svc.setUp(async () => 'pw'));
      const assertion = expect(failure).rejects.toMatchObject({
        operation: 'setup',
        kind: 'server-failure',
        recovery: 'retry',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;

      expect(crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
      expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
      expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('setUp failures', () => {
  it('propagates a bootstrap failure to the caller', async () => {
    const { svc, crypto } = setup({});
    crypto.bootstrapSecretStorage.mockRejectedValue(new Error('boom'));
    await expect(
      firstValueFrom(svc.setUp(async () => 'pw')),
    ).rejects.toMatchObject({
      operation: 'setup',
      kind: 'server-failure',
      recovery: 'retry',
    });
  });
});
