import { TestBed } from '@angular/core/testing';
import { ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionError, MatrixError } from 'matrix-js-sdk';
import { type BootstrapCrossSigningOpts } from 'matrix-js-sdk/lib/crypto-api';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { UiaCancelledError, UiaUnsupportedError } from '@trinity/util/matrix';
import { setup, ssoOnlyUiaError, uiaError } from './trust.spec-harness';

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

describe('resetRecovery', () => {
  it('publishes the new identity, then re-bootstraps 4S and returns the NEW key', async () => {
    const { svc, crypto } = setup({
      recoveryKey: {
        encodedPrivateKey: 'EsTAfterReset',
        privateKey: new Uint8Array(32),
      },
    });

    const shown = await firstValueFrom(svc.resetRecovery(async () => 'pw'));

    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledWith(
      expect.objectContaining({ setupNewCrossSigning: true }),
    );
    expect(shown).toBe('EsTAfterReset');
    const ssOpts = crypto.bootstrapSecretStorage.mock.calls[0][0];
    await expect(ssOpts.createSecretStorageKey()).resolves.toMatchObject({
      encodedPrivateKey: 'EsTAfterReset',
    });
  });

  // THE test. Call counts alone pass on the old, destructive ordering; only the
  // sequence distinguishes "authenticate, then destroy" from "destroy, then ask".
  it('authenticates BEFORE anything destructive runs', async () => {
    const order: string[] = [];
    const { svc, crypto, secretStorage } = setup({ defaultKeyId: 'old-key' });
    secretStorage.setDefaultKeyId.mockImplementation(
      async () => void order.push('park'),
    );
    crypto.bootstrapCrossSigning.mockImplementation(
      async () => void order.push('upload'),
    );
    crypto.bootstrapSecretStorage.mockImplementation(
      async () => void order.push('destroy'),
    );

    await firstValueFrom(svc.resetRecovery(async () => 'pw'));

    expect(order).toEqual(['park', 'upload', 'destroy']);
  });

  it('asks for a new key backup, because nothing else now makes one', async () => {
    // The inverse of what this flow needed while it called resetEncryption, which made
    // the backup itself. `setupKeyBackup` opens by deleting every existing version, so
    // this single call is the whole destructive tail.
    const { svc, crypto } = setup();

    await firstValueFrom(svc.resetRecovery(async () => 'pw'));

    expect(
      crypto.bootstrapSecretStorage.mock.calls[0][0].setupNewKeyBackup,
    ).toBe(true);
  });

  it('parks the 4S pointer so the rotation can reach the upload', async () => {
    // resetCrossSigning exports the rotated privates into the CURRENT 4S key first, but
    // only when one is set — and this user cannot open theirs, so it would die there.
    const { svc, secretStorage } = setup({ defaultKeyId: 'old-key' });

    await firstValueFrom(svc.resetRecovery(async () => 'pw'));

    expect(secretStorage.setDefaultKeyId).toHaveBeenCalledWith(null);
  });

  it('leaves the pointer alone when the account has no 4S', async () => {
    const { svc, secretStorage, client } = setup({ defaultKeyId: null });

    await firstValueFrom(svc.resetRecovery(async () => 'pw'));

    expect(secretStorage.setDefaultKeyId).not.toHaveBeenCalled();
    // The restore's PUT is unconditional given a pointer to restore; there wasn't one.
    expect(client.setAccountDataRaw).not.toHaveBeenCalled();
  });

  it('drives the upload through the password UIA callback', async () => {
    const { svc, crypto } = setup();

    await firstValueFrom(svc.resetRecovery(async () => 'pw'));

    expect(
      crypto.bootstrapCrossSigning.mock.calls[0][0].authUploadDeviceSigningKeys,
    ).toBeTypeOf('function');
  });

  it('recomputes status, so the UI stops reporting the old posture', async () => {
    const { svc } = setup({
      crossSigningReady: true,
      secretStorageReady: true,
      defaultKeyId: 'k',
    });

    await firstValueFrom(svc.resetRecovery(async () => 'pw'));

    expect(svc.status()).toBe('ready');
  });

  it('drops the orphaned key description once the new pointer lands', async () => {
    const { svc, secretStorage } = setup({ defaultKeyId: 'old-key' });
    secretStorage.getDefaultKeyId
      .mockResolvedValueOnce('old-key')
      .mockResolvedValue('new-key');

    await firstValueFrom(svc.resetRecovery(async () => 'pw'));

    expect(secretStorage.store).toHaveBeenCalledWith(
      'm.secret_storage.key.old-key',
      null,
    );
  });

  it('keeps the old description when the new key never landed', async () => {
    const { svc, secretStorage } = setup({ defaultKeyId: 'old-key' });

    await firstValueFrom(svc.resetRecovery(async () => 'pw'));

    expect(secretStorage.store).not.toHaveBeenCalled();
  });

  // Each of these is a route to the measured data loss: the account's backup used to be
  // gone by the time any of them could happen.
  for (const [label, error, kind, recovery] of [
    [
      'the user cancels the password prompt',
      new UiaCancelledError(),
      'cancelled',
      'none',
    ],
    [
      'the server will not take a password',
      new UiaUnsupportedError(),
      'provider-action-required',
      'open-provider',
    ],
    [
      'the password is wrong too many times',
      new Error('Too many attempts.'),
      'server-failure',
      'retry',
    ],
  ] as const) {
    it(`destroys nothing when ${label}`, async () => {
      const { svc, crypto, client } = setup({
        defaultKeyId: 'old-key',
      });
      crypto.bootstrapCrossSigning.mockRejectedValue(error);

      await expect(
        firstValueFrom(svc.resetRecovery(async () => 'pw')),
      ).rejects.toMatchObject({
        operation: 'reset-recovery',
        kind,
        recovery,
      });

      expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
      expect(crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
      // The effect, not the attempt: the pointer is back on the SERVER. Asserting the
      // SDK writer instead would pass on a rollback that reached no further than this
      // client's own store.
      expect(client.setAccountDataRaw).toHaveBeenCalledWith(
        'm.secret_storage.default_key',
        { key: 'old-key' },
      );
    });
  }

  it('re-seats the real identity after a refused upload', async () => {
    // The olm machine rotated its private keys before the upload was authorised, so
    // without a forced key query this device believes in an identity nobody published.
    const { svc, crypto } = setup({ defaultKeyId: 'old-key' });
    crypto.bootstrapCrossSigning.mockRejectedValue(new UiaCancelledError());

    await expect(
      firstValueFrom(svc.resetRecovery(async () => 'pw')),
    ).rejects.toMatchObject({
      operation: 'reset-recovery',
      kind: 'cancelled',
    });

    expect(crypto.userHasCrossSigningKeys).toHaveBeenCalledWith('@me:hs', true);
  });

  it('lets the original error through even if the rollback fails', async () => {
    const { svc, crypto, secretStorage, client } = setup({
      defaultKeyId: 'old-key',
    });
    crypto.bootstrapCrossSigning.mockRejectedValue(new UiaCancelledError());
    // Both halves of the rollback fail: the server-bound PUT and the local realign.
    client.setAccountDataRaw.mockRejectedValue(new Error('PUT exploded'));
    secretStorage.setDefaultKeyId
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('rollback exploded'));

    await expect(
      firstValueFrom(svc.resetRecovery(async () => 'pw')),
    ).rejects.toMatchObject({
      operation: 'reset-recovery',
      kind: 'cancelled',
    });
  });

  it('still recomputes status when the destructive tail fails', async () => {
    // Past the point of no return the account HAS changed; the one thing left that can
    // still go wrong is the UI going on describing the account it used to be.
    const { svc, crypto } = setup({
      defaultKeyId: 'old-key',
    });
    crypto.bootstrapSecretStorage.mockRejectedValue(new Error('network down'));
    crypto.isCrossSigningReady.mockResolvedValue(true);
    crypto.isSecretStorageReady.mockResolvedValue(true);

    await expect(
      firstValueFrom(svc.resetRecovery(async () => 'pw')),
    ).rejects.toMatchObject({
      operation: 'reset-recovery',
      kind: 'partial-update',
      recovery: 'review-security-settings',
      partial: true,
    });

    expect(svc.status()).toBe('ready'); // recomputed, not left stale at 'unknown'
  });

  it('repairs the account it started on, not whichever is active now', async () => {
    // The password prompt is a long await. Switching accounts underneath it must not
    // point the rollback at the new account's olm machine — the keys needing re-seating
    // belong to the old one.
    const { svc, crypto, matrix } = setup({ defaultKeyId: 'old-key' });
    const otherCrypto = { userHasCrossSigningKeys: vi.fn() };
    crypto.bootstrapCrossSigning.mockImplementation(async () => {
      ngMocks.stubMember(matrix, 'instance', {
        getCrypto: () => otherCrypto,
        getUserId: () => '@other:hs',
      } as unknown as MatrixClientService['instance']);
      throw new UiaCancelledError();
    });

    await expect(
      firstValueFrom(svc.resetRecovery(async () => 'pw')),
    ).rejects.toMatchObject({
      operation: 'reset-recovery',
      kind: 'cancelled',
    });

    expect(crypto.userHasCrossSigningKeys).toHaveBeenCalledWith('@me:hs', true);
    expect(otherCrypto.userHasCrossSigningKeys).not.toHaveBeenCalled();
  });

  it('delivers the original error even if the rollback never settles', async () => {
    // setDefaultKeyId resolves on the /sync echo, so a stalled sync leaves it pending —
    // and an unbounded wait there would swallow the cancellation the user is waiting on.
    vi.useFakeTimers();
    try {
      const { svc, crypto, secretStorage } = setup({
        defaultKeyId: 'old-key',
      });
      crypto.bootstrapCrossSigning.mockRejectedValue(new UiaCancelledError());
      secretStorage.getDefaultKeyId
        .mockResolvedValueOnce('old-key') // read before parking
        .mockResolvedValue(null); // the park echoed; the local store is parked
      secretStorage.setDefaultKeyId
        .mockResolvedValueOnce(undefined)
        .mockReturnValue(new Promise(() => undefined)); // never settles

      const failure = firstValueFrom(svc.resetRecovery(async () => 'pw'));
      const assertion = expect(failure).rejects.toMatchObject({
        operation: 'reset-recovery',
        kind: 'cancelled',
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses before the rotation when the server offers no password stage', async () => {
    const { svc, crypto, secretStorage, client } = setup({
      defaultKeyId: 'old-key',
    });
    client.deleteMultipleDevices.mockRejectedValue(ssoOnlyUiaError());

    await expect(
      firstValueFrom(svc.resetRecovery(async () => 'pw')),
    ).rejects.toMatchObject({
      operation: 'reset-recovery',
      kind: 'provider-action-required',
      recovery: 'open-provider',
    });
    expect(secretStorage.setDefaultKeyId).not.toHaveBeenCalled();
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
    expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
  });

  it('authenticates against an empty device list, so the check itself deletes nothing', async () => {
    const { svc, client } = setup();

    await firstValueFrom(svc.resetRecovery(async () => 'pw'));

    // Both the unauthed probe and the authed retry, and neither names a device.
    expect(client.deleteMultipleDevices).toHaveBeenCalledTimes(2);
    for (const [devices] of client.deleteMultipleDevices.mock.calls) {
      expect(devices).toEqual([]);
    }
  });

  // Cancelling used to cost the user their 4S pointer and a local key rotation, because
  // the only thing asked beforehand was whether the server OFFERS a password — never
  // whether this user knows it.
  it('performs no write and no rotation when the password prompt is cancelled', async () => {
    const { svc, crypto, secretStorage } = setup({ defaultKeyId: 'old-key' });

    await expect(
      firstValueFrom(svc.resetRecovery(async () => null)),
    ).rejects.toMatchObject({
      operation: 'reset-recovery',
      kind: 'cancelled',
    });

    expect(secretStorage.setDefaultKeyId).not.toHaveBeenCalled();
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
    expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
  });

  it('performs no write and no rotation when the password is wrong every time', async () => {
    const { svc, crypto, secretStorage, client } = setup({
      defaultKeyId: 'old-key',
    });
    client.deleteMultipleDevices.mockRejectedValue(uiaError('probe'));
    const prompt = vi.fn().mockResolvedValue('wrong');

    await expect(
      firstValueFrom(svc.resetRecovery(prompt)),
    ).rejects.toMatchObject({
      operation: 'reset-recovery',
      kind: 'permission-denied',
      recovery: 'retry',
    });

    expect(prompt).toHaveBeenCalledTimes(3);
    expect(secretStorage.setDefaultKeyId).not.toHaveBeenCalled();
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it('asks for the password once, replaying it into the key upload', async () => {
    // The upload has its own UIA session and is challenged again; a second prompt for
    // the same password would read as "that didn't work, try again".
    const { svc, crypto, client } = setup();
    const prompt = vi.fn().mockResolvedValue('s3cret');
    let uia!: (mr: (a: unknown) => Promise<unknown>) => Promise<unknown>;
    crypto.bootstrapCrossSigning.mockImplementation(
      async (opts: BootstrapCrossSigningOpts) => {
        uia = opts.authUploadDeviceSigningKeys as typeof uia;
      },
    );

    await firstValueFrom(svc.resetRecovery(prompt));
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(uiaError('upload'))
      .mockResolvedValueOnce(undefined);
    await uia(makeRequest);

    expect(prompt).toHaveBeenCalledTimes(1);
    // Once for the pre-auth...
    expect(client.deleteMultipleDevices.mock.calls[1][1]).toMatchObject({
      password: 's3cret',
      session: 'probe',
    });
    // ...and the same password again for the upload, without asking.
    expect(makeRequest.mock.calls[1][0]).toMatchObject({
      password: 's3cret',
      session: 'upload', // the upload's own session, not the pre-auth one
    });
  });

  it('falls back to prompting when the replayed password is rejected', async () => {
    const { svc, crypto } = setup();
    const prompt = vi
      .fn()
      .mockResolvedValueOnce('accepted-then-rotated')
      .mockResolvedValueOnce('typed-again');
    let uia!: (mr: (a: unknown) => Promise<unknown>) => Promise<unknown>;
    crypto.bootstrapCrossSigning.mockImplementation(
      async (opts: BootstrapCrossSigningOpts) => {
        uia = opts.authUploadDeviceSigningKeys as typeof uia;
      },
    );

    await firstValueFrom(svc.resetRecovery(prompt));
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(uiaError('u1')) // unauthed probe
      .mockRejectedValueOnce(uiaError('u2')) // the replay is refused
      .mockResolvedValueOnce(undefined);
    await uia(makeRequest);

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(makeRequest.mock.calls[2][0]).toMatchObject({
      password: 'typed-again',
    });
  });

  it('goes ahead when the pre-auth request cannot answer, rather than inventing a failure', async () => {
    // Authenticating early must not become a new way for the reset to fail: a dropped
    // connection, or a server that gates /delete_devices differently from the key
    // upload, leaves the user where they were and the upload still prompts.
    const { svc, crypto, client } = setup();
    client.deleteMultipleDevices.mockRejectedValue(new Error('network down'));

    await expect(
      firstValueFrom(svc.resetRecovery(async () => 'pw')),
    ).resolves.toBeTypeOf('string');
    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledOnce();
  });

  it('goes ahead when the pre-auth request is not challenged at all', async () => {
    const { svc, crypto, client } = setup();
    client.deleteMultipleDevices.mockResolvedValue({});

    await firstValueFrom(svc.resetRecovery(async () => 'pw'));

    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledOnce();
  });

  it('rolls back when an unchallenged pre-auth leaves the upload asking first', async () => {
    // The residual of "authenticate first": a server that does not gate /delete_devices
    // (Synapse passes can_skip_ui_auth there; MSC3861 bypasses it) leaves the FIRST
    // prompt the user ever sees inside the upload — with the pointer already parked and
    // the local identity already rotated. The rollback is what covers that, so pin it
    // with a real 4S pointer, which the sibling test above leaves null.
    const order: string[] = [];
    const { svc, crypto, secretStorage, client } = setup({
      defaultKeyId: 'old-key',
    });
    client.deleteMultipleDevices.mockResolvedValue({}); // no challenge at all
    secretStorage.setDefaultKeyId.mockImplementation(
      async (keyId: string | null) => void order.push(`pointer:${keyId}`),
    );
    client.setAccountDataRaw.mockImplementation(
      async (_type: string, content: { key?: string }) =>
        void order.push(`pointer:${content.key}`),
    );
    crypto.bootstrapCrossSigning.mockImplementation(
      async (opts: BootstrapCrossSigningOpts) =>
        (
          opts.authUploadDeviceSigningKeys as (
            mr: (a: unknown) => Promise<unknown>,
          ) => Promise<unknown>
        )(vi.fn().mockRejectedValue(uiaError('upload'))),
    );
    const prompt = vi.fn(async () => {
      order.push('first prompt');
      return null; // the user cancels the one prompt they are given
    });

    await expect(
      firstValueFrom(svc.resetRecovery(prompt)),
    ).rejects.toMatchObject({
      operation: 'reset-recovery',
      kind: 'cancelled',
    });

    expect(order).toEqual(['pointer:null', 'first prompt', 'pointer:old-key']);
    expect(crypto.userHasCrossSigningKeys).toHaveBeenCalledWith('@me:hs', true);
  });

  it('still gives the user three tries when the replayed password is rejected', async () => {
    // The replay is the reset's own retry, not one of the user's. Spending an attempt
    // on it would silently cut a rejected replay's cost out of the human's budget.
    const { svc, crypto } = setup();
    const prompt = vi.fn().mockResolvedValue('unchanged');
    let uia!: (mr: (a: unknown) => Promise<unknown>) => Promise<unknown>;
    crypto.bootstrapCrossSigning.mockImplementation(
      async (opts: BootstrapCrossSigningOpts) => {
        uia = opts.authUploadDeviceSigningKeys as typeof uia;
      },
    );

    await firstValueFrom(svc.resetRecovery(prompt));
    const makeRequest = vi.fn().mockRejectedValue(uiaError('upload'));
    await expect(uia(makeRequest)).rejects.toThrow(/too many/i);

    // One for the pre-auth, then three of the user's own — the replay is not one.
    expect(prompt).toHaveBeenCalledTimes(4);
  });

  it('deletes the dehydrated device, which the new identity can no longer sign', async () => {
    const { svc, client } = setup();

    await firstValueFrom(svc.resetRecovery(async () => 'pw'));

    expect(client.http.authedRequest).toHaveBeenCalledWith(
      'DELETE',
      '/dehydrated_device',
      undefined,
      {},
      { prefix: '/_matrix/client/unstable/org.matrix.msc3814.v1' },
    );
  });

  it('deletes the dehydrated device inside the destructive tail, not before the upload', async () => {
    // The SDK's resetEncryption does this first thing. Here nothing may be destroyed
    // until the identity upload is authorised, so it heads the tail instead.
    const order: string[] = [];
    const { svc, crypto, secretStorage, client } = setup({
      defaultKeyId: 'old-key',
    });
    secretStorage.setDefaultKeyId.mockImplementation(
      async () => void order.push('park'),
    );
    crypto.bootstrapCrossSigning.mockImplementation(
      async () => void order.push('upload'),
    );
    client.http.authedRequest.mockImplementation(
      async () => void order.push('dehydrated'),
    );
    crypto.bootstrapSecretStorage.mockImplementation(
      async () => void order.push('destroy'),
    );

    await firstValueFrom(svc.resetRecovery(async () => 'pw'));

    expect(order).toEqual(['park', 'upload', 'dehydrated', 'destroy']);
  });

  it('completes the reset when there is no dehydrated device to delete', async () => {
    const { svc, client } = setup();
    client.http.authedRequest.mockRejectedValue(
      new MatrixError({ errcode: 'M_UNRECOGNIZED' }, 404),
    );

    await expect(
      firstValueFrom(svc.resetRecovery(async () => 'pw')),
    ).resolves.toBeTypeOf('string');
  });

  it('writes the pointer to the server first, then tries to realign the local store', async () => {
    // The park echoed, so the LOCAL store reads null; then sync stalled, so every
    // echo-waiting write hangs (setDefaultKeyId wraps setAccountData in a SECOND echo
    // listener). The server gets its value from the raw PUT — which resolves on the HTTP
    // response — and only afterwards does the echo-waiting writer get a bounded attempt
    // at this client's own view.
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const { svc, crypto, secretStorage, client } = setup({
        defaultKeyId: 'old-key',
      });
      crypto.bootstrapCrossSigning.mockRejectedValue(new UiaCancelledError());
      secretStorage.getDefaultKeyId
        .mockResolvedValueOnce('old-key') // read before parking
        .mockResolvedValue(null); // the park echoed; the local store stays parked
      client.setAccountDataRaw.mockImplementation(async () => {
        order.push('server');
        return {};
      });
      secretStorage.setDefaultKeyId
        .mockResolvedValueOnce(undefined) // parking it echoed back fine
        .mockImplementation(() => {
          order.push('local');
          return new Promise(() => undefined); // then the echo stopped coming
        });

      const failure = firstValueFrom(svc.resetRecovery(async () => 'pw'));
      const assertion = expect(failure).rejects.toMatchObject({
        operation: 'reset-recovery',
        kind: 'cancelled',
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;

      expect(client.setAccountDataRaw).toHaveBeenCalledWith(
        'm.secret_storage.default_key',
        { key: 'old-key' },
      );
      // The server is settled before anything waits on a /sync echo, and a realign that
      // never settles is bounded rather than fatal.
      expect(order).toEqual(['server', 'local']);
      expect(client.setAccountData).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts the pointer back on the server even when every local read says it is already there', async () => {
    // Scenario A, exactly as the SDK produces it: the park's PUT landed, its /sync echo
    // was lost, so the LOCAL store still holds the PRE-park value. Every read reachable
    // from here answers out of that store (getDefaultKeyId → getAccountDataFromServer,
    // which reads locally once initial sync is complete), so a re-read reports 'old-key'
    // while the SERVER holds {}. Treating that as confirmation left the pointer parked
    // account-wide and reported success; the server write is unconditional for that
    // reason, and nothing may gate it.
    vi.useFakeTimers();
    try {
      const { svc, secretStorage, client } = setup({
        defaultKeyId: 'old-key',
      });
      // The park never echoes...
      secretStorage.setDefaultKeyId.mockReturnValue(
        new Promise(() => undefined),
      );
      // ...so the local store never moves off the pre-park value.
      secretStorage.getDefaultKeyId.mockResolvedValue('old-key');

      const failure = firstValueFrom(svc.resetRecovery(async () => 'pw'));
      const assertion = expect(failure).rejects.toMatchObject({
        operation: 'reset-recovery',
        kind: 'server-failure',
        recovery: 'retry',
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;

      expect(client.setAccountDataRaw).toHaveBeenCalledWith(
        'm.secret_storage.default_key',
        { key: 'old-key' },
      );
      // Only the park. Re-entering the echo-waiting writer against a store that already
      // agrees would write nothing at all and then wait forever for an echo no write
      // caused, so the realign is skipped rather than left to burn its budget.
      expect(secretStorage.setDefaultKeyId).toHaveBeenCalledOnce();
      expect(secretStorage.setDefaultKeyId).toHaveBeenCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries the pointer restore through a dropped connection', async () => {
    // The restore is a bare request, unlike the echo-waiting writer it replaced, which
    // reached the network through retryNetworkOperation. Losing the retry would bite
    // hardest where it is least affordable: a lost echo usually means the connection
    // died, which is exactly when the next PUT throws — so one blip would lose the only
    // write the rollback exists to make.
    vi.useFakeTimers();
    const retryLog = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const { svc, secretStorage, client } = setup({
        defaultKeyId: 'old-key',
      });
      secretStorage.setDefaultKeyId.mockReturnValue(
        new Promise(() => undefined),
      );
      secretStorage.getDefaultKeyId.mockResolvedValue('old-key');
      client.setAccountDataRaw
        .mockRejectedValueOnce(new ConnectionError('flaky'))
        .mockResolvedValue({});

      const failure = firstValueFrom(svc.resetRecovery(async () => 'pw'));
      const assertion = expect(failure).rejects.toMatchObject({
        operation: 'reset-recovery',
        kind: 'server-failure',
        recovery: 'retry',
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;

      // Attempted twice, and the second one landed — a single rejection must not be
      // the end of it.
      expect(client.setAccountDataRaw).toHaveBeenCalledTimes(2);
      expect(client.setAccountDataRaw).toHaveBeenLastCalledWith(
        'm.secret_storage.default_key',
        { key: 'old-key' },
      );
      expect(retryLog).toHaveBeenCalledExactlyOnceWith(
        'network operation failed 1 times, retrying in 2000ms...',
      );
    } finally {
      retryLog.mockRestore();
      vi.useRealTimers();
    }
  });

  it('aborts before rotating anything when parking the pointer is not confirmed', async () => {
    // The park's PUT goes out before the echo it waits on, so an unconfirmed park may
    // still have landed account-wide. Waiting on it forever would leave the pointer
    // parked with no error, no status refresh and nothing emitted to the caller.
    vi.useFakeTimers();
    try {
      const { svc, crypto, secretStorage, client } = setup({
        defaultKeyId: 'old-key',
      });
      secretStorage.setDefaultKeyId.mockReturnValue(
        new Promise(() => undefined), // the park never echoes
      );

      const failure = firstValueFrom(svc.resetRecovery(async () => 'pw'));
      const assertion = expect(failure).rejects.toMatchObject({
        operation: 'reset-recovery',
        kind: 'server-failure',
        recovery: 'retry',
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;

      // The effect the abort owes the account, not the attempt it made at it.
      expect(client.setAccountDataRaw).toHaveBeenCalledWith(
        'm.secret_storage.default_key',
        { key: 'old-key' },
      );
      expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
      expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the new recovery key even if the last read never answers', async () => {
    // getDefaultKeyId answers from the local store only while the initial sync is
    // complete; once a stalled long-poll drops the sync loop out — which takes ~110s,
    // inside the destructive tail's own budget — it becomes a bare network GET on a
    // client with no request timeout. Unbounded, it would hang here, after the tail has
    // already run, and the user would never see the key it just minted.
    vi.useFakeTimers();
    try {
      const { svc, secretStorage } = setup({ defaultKeyId: 'old-key' });
      secretStorage.getDefaultKeyId
        .mockResolvedValueOnce('old-key')
        .mockReturnValueOnce(new Promise(() => undefined))
        .mockResolvedValue('new-key');

      const shown = firstValueFrom(svc.resetRecovery(async () => 'pw'));
      const assertion = expect(shown).resolves.toBe('EsTRecoveryKey');
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the new recovery key even if dropping the old description never echoes', async () => {
    // The last step runs AFTER the destructive tail. Hanging there would leave the
    // user's only copy of the new key undisplayed, with another reset as the only fix.
    vi.useFakeTimers();
    try {
      const { svc, secretStorage } = setup({ defaultKeyId: 'old-key' });
      secretStorage.getDefaultKeyId
        .mockResolvedValueOnce('old-key')
        .mockResolvedValue('new-key');
      secretStorage.store.mockReturnValue(new Promise(() => undefined));

      const shown = firstValueFrom(svc.resetRecovery(async () => 'pw'));
      const assertion = expect(shown).resolves.toBe('EsTRecoveryKey');
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-seats the identity even while the pointer restore is hanging', async () => {
    // One shared budget let the account-data write — the step that can hang — eat the
    // whole allowance, so the cheap local repair never ran at all.
    vi.useFakeTimers();
    try {
      const { svc, crypto, secretStorage } = setup({
        defaultKeyId: 'old-key',
      });
      crypto.bootstrapCrossSigning.mockRejectedValue(new UiaCancelledError());
      secretStorage.getDefaultKeyId
        .mockResolvedValueOnce('old-key') // read before parking
        .mockResolvedValue(null); // the park echoed; the local store is parked
      secretStorage.setDefaultKeyId
        .mockResolvedValueOnce(undefined)
        .mockReturnValue(new Promise(() => undefined)); // never settles

      const failure = firstValueFrom(svc.resetRecovery(async () => 'pw'));
      const assertion = expect(failure).rejects.toMatchObject({
        operation: 'reset-recovery',
        kind: 'cancelled',
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;

      expect(crypto.userHasCrossSigningKeys).toHaveBeenCalledWith(
        '@me:hs',
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a destructive tail that stops answering, and says it may be half-done', async () => {
    // bootstrapSecretStorage is ~6 echo-waiting account-data writes plus the backup
    // deletions. Each request has the client deadline, but the sequence still needs one
    // whole-operation bound so a stalled sync cannot keep the new 4S key live while its
    // recovery key is never shown.
    vi.useFakeTimers();
    try {
      const { svc, crypto } = setup({
        defaultKeyId: 'old-key',
      });
      crypto.bootstrapSecretStorage.mockReturnValue(
        new Promise(() => undefined),
      );
      crypto.isCrossSigningReady.mockResolvedValue(true);
      crypto.isSecretStorageReady.mockResolvedValue(true);

      const failure = firstValueFrom(svc.resetRecovery(async () => 'pw'));
      // Not "timed out": a timeout here cannot undo anything the tail already did, so
      // the user has to be told where to look rather than just that it failed.
      const assertion = expect(failure).rejects.toMatchObject({
        operation: 'reset-recovery',
        kind: 'partial-update',
        recovery: 'review-security-settings',
        partial: true,
      });
      await vi.advanceTimersByTimeAsync(200_000);
      await assertion;

      expect(svc.status()).toBe('ready'); // the finally still recomputed it
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits out a slow destructive tail rather than a stalled one', async () => {
    // The budget is deliberately above the ~110s a dead /sync long-poll takes to be
    // noticed (pollTimeout 30s + BUFFER_PERIOD_MS 80s), so a tail the sync loop is about
    // to unblock is not aborted and reported as half-failed.
    vi.useFakeTimers();
    try {
      const { svc, crypto } = setup({ defaultKeyId: 'old-key' });
      crypto.bootstrapSecretStorage.mockReturnValue(
        new Promise((resolve) => setTimeout(resolve, 120_000)),
      );

      const shown = firstValueFrom(svc.resetRecovery(async () => 'pw'));
      const assertion = expect(shown).resolves.toBe('EsTRecoveryKey');
      await vi.advanceTimersByTimeAsync(200_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('finishes the reset when the dehydrated-device delete never answers', async () => {
    // It heads the destructive tail and is a bare authedRequest with nothing under it to
    // time out, so an unanswered socket there would stall the reset before the tail it
    // opens — and the user would never be shown the key the reset is for.
    vi.useFakeTimers();
    try {
      const { svc, client } = setup();
      client.http.authedRequest.mockReturnValue(new Promise(() => undefined));

      const shown = firstValueFrom(svc.resetRecovery(async () => 'pw'));
      const assertion = expect(shown).resolves.toBe('EsTRecoveryKey');
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
