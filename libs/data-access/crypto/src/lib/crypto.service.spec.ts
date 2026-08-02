import { webcrypto } from 'node:crypto';
import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ConnectionError, MatrixError } from 'matrix-js-sdk';
import {
  CryptoEvent,
  deriveRecoveryKeyFromPassphrase,
  encodeRecoveryKey,
  type BootstrapCrossSigningOpts,
} from 'matrix-js-sdk/lib/crypto-api';
import { CryptoService } from './crypto.service';
import {
  MatrixClientService,
  SecretStorageKeyHolder,
} from '@trinity/data-access/matrix-client';
import { UiaCancelledError, UiaUnsupportedError } from '@trinity/util/matrix';

/** A 401 UIA challenge carrying flows + session, as the SDK surfaces it. */
function uiaError(session: string): MatrixError {
  return new MatrixError(
    { flows: [{ stages: ['m.login.password'] }], session },
    401,
  );
}

/** The 401 a password-less account gets: the server offers only an SSO stage. */
function ssoOnlyUiaError(): MatrixError {
  return new MatrixError(
    { flows: [{ stages: ['m.login.sso'] }], session: 's' },
    401,
  );
}

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

// A valid recovery key (round-trips through decodeRecoveryKey to 32 bytes).
const VALID_KEY = encodeRecoveryKey(new Uint8Array(32)) as string;

interface CryptoOpts {
  crossSigningReady?: boolean;
  secretStorageReady?: boolean;
  backupVersion?: string | null;
  deviceVerified?: boolean;
  defaultKeyId?: string | null;
  keyInfo?: Record<string, unknown>;
  checkKey?: boolean;
  backupInfo?: { version: string } | null;
  hasCrypto?: boolean;
  recoveryKey?: { encodedPrivateKey?: string; privateKey: Uint8Array };
  exportedKeys?: string;
  /** The cross-signing seeds 4S hands back, keyed by secret name. */
  storedSecrets?: Record<string, string>;
  /**
   * Whether the olm machine already holds all three cross-signing privates. Only true
   * for a device that imported them — or for one an interrupted reset left holding the
   * rotated set it never published, which is the state the repair exists for.
   */
  privatesCachedLocally?: boolean;
}

/** The three seed names `getCrossSigningStatus` reports on. */
const SEED_NAMES = [
  'm.cross_signing.master',
  'm.cross_signing.self_signing',
  'm.cross_signing.user_signing',
];

/** The shape matrix-js-sdk exports for a SecretsBundle (serde field names). */
function secretsBundle(seeds = 'stale') {
  return {
    cross_signing: {
      master_key: `${seeds}-master`,
      self_signing_key: `${seeds}-self`,
      user_signing_key: `${seeds}-user`,
    },
    backup: { algorithm: 'm.megolm_backup.v1', key: 'bk', backup_version: '1' },
  };
}

function setup(opts: CryptoOpts = {}) {
  const crypto = {
    isCrossSigningReady: vi
      .fn()
      .mockResolvedValue(opts.crossSigningReady ?? false),
    isSecretStorageReady: vi
      .fn()
      .mockResolvedValue(opts.secretStorageReady ?? false),
    getActiveSessionBackupVersion: vi
      .fn()
      .mockResolvedValue(opts.backupVersion ?? null),
    getDeviceVerificationStatus: vi.fn().mockResolvedValue({
      crossSigningVerified: opts.deviceVerified ?? false,
    }),
    createRecoveryKeyFromPassphrase: vi.fn().mockResolvedValue(
      opts.recoveryKey ?? {
        encodedPrivateKey: 'EsTRecoveryKey',
        privateKey: new Uint8Array(32),
      },
    ),
    bootstrapCrossSigning: vi.fn().mockResolvedValue(undefined),
    bootstrapSecretStorage: vi.fn().mockResolvedValue(undefined),
    getKeyBackupInfo: vi
      .fn()
      .mockResolvedValue(
        'backupInfo' in opts ? opts.backupInfo : { version: '1' },
      ),
    loadSessionBackupPrivateKeyFromSecretStorage: vi
      .fn()
      .mockResolvedValue(undefined),
    checkKeyBackupAndEnable: vi.fn().mockResolvedValue(null),
    exportRoomKeysAsJson: vi.fn().mockResolvedValue(opts.exportedKeys ?? '[]'),
    importRoomKeysAsJson: vi.fn().mockResolvedValue(undefined),
    userHasCrossSigningKeys: vi.fn().mockResolvedValue(true),
    // Modelled on rust-crypto's own: 4S "contains" the keys only when all three are
    // there, and the locally cached set is what the olm machine happens to hold.
    getCrossSigningStatus: vi.fn().mockResolvedValue({
      publicKeysOnDevice: true,
      privateKeysInSecretStorage: SEED_NAMES.every(
        (name) => opts.storedSecrets?.[name],
      ),
      privateKeysCachedLocally: {
        masterKey: opts.privatesCachedLocally ?? false,
        selfSigningKey: opts.privatesCachedLocally ?? false,
        userSigningKey: opts.privatesCachedLocally ?? false,
      },
    }),
    exportSecretsBundle: vi.fn().mockResolvedValue(secretsBundle()),
    importSecretsBundle: vi.fn().mockResolvedValue(undefined),
    crossSignDevice: vi.fn().mockResolvedValue(undefined),
  };

  const secretStorage = {
    getDefaultKeyId: vi
      .fn()
      .mockResolvedValue(
        opts.defaultKeyId === undefined ? null : opts.defaultKeyId,
      ),
    getKey: vi
      .fn()
      .mockResolvedValue(
        opts.defaultKeyId ? [opts.defaultKeyId, opts.keyInfo ?? {}] : null,
      ),
    checkKey: vi.fn().mockResolvedValue(opts.checkKey ?? true),
    setDefaultKeyId: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(async (name: string) => opts.storedSecrets?.[name]),
  };

  // Dispatching rather than inert, so a test can drive the event path the service
  // actually listens on — `on: vi.fn()` records a subscription but can never fire it.
  const listeners = new Map<string, Set<() => void>>();
  const client = {
    getCrypto: () => (opts.hasCrypto === false ? undefined : crypto),
    secretStorage,
    getDeviceId: () => 'DEV',
    getUserId: () => '@me:hs',
    // The request the reset authenticates against. A real Synapse answers it unauthed
    // with a UIA 401 listing the stages THIS user can complete, then accepts the retry
    // that carries an auth dict — deleting nothing, because the list is empty.
    deleteMultipleDevices: vi.fn(async (_devices: string[], auth?: unknown) => {
      if (!auth) {
        throw uiaError('probe');
      }
      return {};
    }),
    // Waits for the /sync echo (client.js:1291-1310)...
    setAccountData: vi.fn().mockResolvedValue({}),
    // ...unlike this one, a bare authed PUT that resolves on the HTTP response.
    setAccountDataRaw: vi.fn().mockResolvedValue({}),
    // The reset deletes the dehydrated device directly over the unstable MSC3814 API;
    // the CryptoApi interface does not expose it.
    http: { authedRequest: vi.fn().mockResolvedValue({}) },
    on: vi.fn((event: string, fn: () => void) => {
      const set = listeners.get(event) ?? new Set<() => void>();
      listeners.set(event, set.add(fn));
    }),
    off: vi.fn((event: string, fn: () => void) => {
      listeners.get(event)?.delete(fn);
    }),
    emit: (event: string) => {
      for (const fn of listeners.get(event) ?? []) {
        fn();
      }
    },
  };

  const holder = new SecretStorageKeyHolder();
  // Writable so tests can flip the active account and fire the reproject effect.
  const activeUserId = signal<string | null>(null);
  TestBed.configureTestingModule({
    providers: [
      CryptoService,
      MockProvider(MatrixClientService, {
        activeUserId: activeUserId.asReadonly(),
      }),
    ],
  });

  const matrix = TestBed.inject(MatrixClientService);
  ngMocks.stubMember(matrix, 'isInitialized', true);
  ngMocks.stubMember(
    matrix,
    'instance',
    client as unknown as MatrixClientService['instance'],
  );
  // CryptoService caches the unlocked 4S key on the ACTIVE account's holder.
  ngMocks.stubMember(matrix, 'activeHolder', () => holder);

  return {
    svc: TestBed.inject(CryptoService),
    keys: holder,
    crypto,
    secretStorage,
    client,
    matrix,
    activeUserId,
  };
}

describe('CryptoService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  describe('status', () => {
    it('is "ready" when cross-signing and secret storage are both ready', async () => {
      const { svc } = setup({
        crossSigningReady: true,
        secretStorageReady: true,
        backupVersion: '1',
        deviceVerified: true,
        defaultKeyId: 'k',
      });
      await firstValueFrom(svc.refresh());

      expect(svc.status()).toBe('ready');
      expect(svc.keyBackupActive()).toBe(true);
      expect(svc.thisDeviceVerified()).toBe(true);
    });

    it('is "needs-setup" when no secret storage exists yet', async () => {
      const { svc } = setup({ defaultKeyId: null });
      await firstValueFrom(svc.refresh());

      expect(svc.status()).toBe('needs-setup');
      expect(svc.keyBackupActive()).toBe(false);
      expect(svc.thisDeviceVerified()).toBe(false);
    });

    it('is "needs-recovery" when secret storage exists but this device is not ready', async () => {
      const { svc } = setup({ defaultKeyId: 'k' });
      await firstValueFrom(svc.refresh());

      expect(svc.status()).toBe('needs-recovery');
    });

    it('is "unknown" when crypto is unavailable', async () => {
      const { svc } = setup({ hasCrypto: false });
      await firstValueFrom(svc.refresh());

      expect(svc.status()).toBe('unknown');
    });
  });

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
        crypto.bootstrapCrossSigning.mock.calls[0][0]
          .authUploadDeviceSigningKeys,
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
  });

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
        crypto.bootstrapCrossSigning.mock.calls[0][0]
          .authUploadDeviceSigningKeys,
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
    for (const [label, error] of [
      ['the user cancels the password prompt', new UiaCancelledError()],
      ['the server will not take a password', new UiaUnsupportedError()],
      ['the password is wrong too many times', new Error('Too many attempts.')],
    ] as const) {
      it(`destroys nothing when ${label}`, async () => {
        const { svc, crypto, client } = setup({
          defaultKeyId: 'old-key',
        });
        crypto.bootstrapCrossSigning.mockRejectedValue(error);

        await expect(
          firstValueFrom(svc.resetRecovery(async () => 'pw')),
        ).rejects.toThrow(error.message);

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
      ).rejects.toThrow(UiaCancelledError);

      expect(crypto.userHasCrossSigningKeys).toHaveBeenCalledWith(
        '@me:hs',
        true,
      );
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
      ).rejects.toThrow(UiaCancelledError);
    });

    it('still recomputes status when the destructive tail fails', async () => {
      // Past the point of no return the account HAS changed; the one thing left that can
      // still go wrong is the UI going on describing the account it used to be.
      const { svc, crypto } = setup({ defaultKeyId: 'old-key' });
      crypto.bootstrapSecretStorage.mockRejectedValue(
        new Error('network down'),
      );
      crypto.isCrossSigningReady.mockResolvedValue(true);
      crypto.isSecretStorageReady.mockResolvedValue(true);

      await expect(
        firstValueFrom(svc.resetRecovery(async () => 'pw')),
      ).rejects.toThrow('network down');

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
      ).rejects.toThrow(UiaCancelledError);

      expect(crypto.userHasCrossSigningKeys).toHaveBeenCalledWith(
        '@me:hs',
        true,
      );
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
        const assertion = expect(failure).rejects.toThrow(UiaCancelledError);
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
      ).rejects.toBeInstanceOf(UiaUnsupportedError);
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
      ).rejects.toBeInstanceOf(UiaCancelledError);

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

      await expect(firstValueFrom(svc.resetRecovery(prompt))).rejects.toThrow(
        /too many/i,
      );

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
      ).rejects.toBeInstanceOf(UiaCancelledError);

      expect(order).toEqual([
        'pointer:null',
        'first prompt',
        'pointer:old-key',
      ]);
      expect(crypto.userHasCrossSigningKeys).toHaveBeenCalledWith(
        '@me:hs',
        true,
      );
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
        const assertion = expect(failure).rejects.toThrow(UiaCancelledError);
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
        const assertion = expect(failure).rejects.toThrow(/timed out/i);
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
        const assertion = expect(failure).rejects.toThrow(/timed out/i);
        await vi.advanceTimersByTimeAsync(60_000);
        await assertion;

        // Attempted twice, and the second one landed — a single rejection must not be
        // the end of it.
        expect(client.setAccountDataRaw).toHaveBeenCalledTimes(2);
        expect(client.setAccountDataRaw).toHaveBeenLastCalledWith(
          'm.secret_storage.default_key',
          { key: 'old-key' },
        );
      } finally {
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
        const assertion = expect(failure).rejects.toThrow(/timed out/i);
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
        const assertion = expect(failure).rejects.toThrow(UiaCancelledError);
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
      // deletions, and nothing under it is bounded (createClient passes no
      // localTimeoutMs). Unbounded, a stalled sync there spins forever with the new 4S key
      // possibly already live and its recovery key never shown.
      vi.useFakeTimers();
      try {
        const { svc, crypto } = setup({ defaultKeyId: 'old-key' });
        crypto.bootstrapSecretStorage.mockReturnValue(
          new Promise(() => undefined),
        );
        crypto.isCrossSigningReady.mockResolvedValue(true);
        crypto.isSecretStorageReady.mockResolvedValue(true);

        const failure = firstValueFrom(svc.resetRecovery(async () => 'pw'));
        // Not "timed out": a timeout here cannot undo anything the tail already did, so
        // the user has to be told where to look rather than just that it failed.
        const assertion = expect(failure).rejects.toThrow(
          /may have completed only partly.*Settings/s,
        );
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

  describe('recoverWithKey', () => {
    it('verifies, caches the key, imports cross-signing and enables backup', async () => {
      const { svc, keys, crypto, secretStorage } = setup({
        defaultKeyId: 'k',
        checkKey: true,
        crossSigningReady: true,
        secretStorageReady: true,
      });

      await firstValueFrom(svc.recoverWithKey(VALID_KEY));

      expect(secretStorage.checkKey).toHaveBeenCalledOnce();
      expect(keys.hasKey).toBe(true);
      expect(crypto.bootstrapCrossSigning).toHaveBeenCalledWith({});
      expect(
        crypto.loadSessionBackupPrivateKeyFromSecretStorage,
      ).toHaveBeenCalledOnce();
      expect(crypto.checkKeyBackupAndEnable).toHaveBeenCalledOnce();
    });

    it('caches the key onto the holder captured at recovery start, not a mid-flight one', async () => {
      const { svc, matrix, secretStorage } = setup({
        defaultKeyId: 'k',
        checkKey: true,
        crossSigningReady: true,
        secretStorageReady: true,
      });

      // Simulate an account switch mid-recovery: activeHolder() yields account A's
      // holder on its first read (start of recover), then account B's on any later one.
      const holderA = new SecretStorageKeyHolder();
      const holderB = new SecretStorageKeyHolder();
      let holderReads = 0;
      ngMocks.stubMember(matrix, 'activeHolder', () =>
        holderReads++ === 0 ? holderA : holderB,
      );

      await firstValueFrom(svc.recoverWithKey(VALID_KEY));

      expect(secretStorage.checkKey).toHaveBeenCalledOnce();
      // The unlocked key must land on the account active when recovery began...
      expect(holderA.hasKey).toBe(true);
      // ...and never leak onto whatever account became active mid-flight.
      expect(holderB.hasKey).toBe(false);
    });

    it('rejects an incorrect recovery key without caching it', async () => {
      const { svc, keys, crypto } = setup({
        defaultKeyId: 'k',
        checkKey: false,
      });

      await expect(
        firstValueFrom(svc.recoverWithKey(VALID_KEY)),
      ).rejects.toThrow(/incorrect/i);
      expect(keys.hasKey).toBe(false);
      expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
    });

    it('rejects a malformed recovery key', async () => {
      const { svc } = setup({ defaultKeyId: 'k' });
      await expect(
        firstValueFrom(svc.recoverWithKey('not a key')),
      ).rejects.toThrow(/valid recovery key/i);
    });

    it('errors when no recovery key is set up on the account', async () => {
      const { svc } = setup({ defaultKeyId: null });
      await expect(
        firstValueFrom(svc.recoverWithKey(VALID_KEY)),
      ).rejects.toThrow(/no recovery key/i);
    });

    // An interrupted reset leaves the olm machine holding cross-signing privates it
    // rotated but never published. bootstrapCrossSigning({}) then sees privates already
    // in place and logs "doing nothing" — so unlocking 4S never replaced them, and the
    // device stayed at needs-recovery no matter how many times the user tried.
    describe('cross-signing keys stranded by an interrupted reset', () => {
      const SEEDS = {
        'm.cross_signing.master': 'real-master',
        'm.cross_signing.self_signing': 'real-self',
        'm.cross_signing.user_signing': 'real-user',
      };

      it('re-imports the real keys from 4S and cross-signs this device', async () => {
        const { svc, crypto } = setup({
          defaultKeyId: 'k',
          checkKey: true,
          crossSigningReady: false, // still not trusted after the bootstrap
          privatesCachedLocally: true, // ...because it holds the rotated privates
          storedSecrets: SEEDS,
        });

        await firstValueFrom(svc.recoverWithKey(VALID_KEY));

        expect(crypto.importSecretsBundle).toHaveBeenCalledWith({
          // the three seeds replaced with 4S's, everything else left as exported
          cross_signing: {
            master_key: 'real-master',
            self_signing_key: 'real-self',
            user_signing_key: 'real-user',
          },
          backup: secretsBundle().backup,
        });
        expect(crypto.crossSignDevice).toHaveBeenCalledWith('DEV');
      });

      it('leaves a healthy device alone', async () => {
        const { svc, crypto } = setup({
          defaultKeyId: 'k',
          checkKey: true,
          crossSigningReady: true,
          storedSecrets: SEEDS,
        });

        await firstValueFrom(svc.recoverWithKey(VALID_KEY));

        expect(crypto.importSecretsBundle).not.toHaveBeenCalled();
        expect(crypto.crossSignDevice).not.toHaveBeenCalled();
      });

      it('does nothing when 4S holds no cross-signing keys to re-seat', async () => {
        const { svc, crypto } = setup({
          defaultKeyId: 'k',
          checkKey: true,
          crossSigningReady: false,
          privatesCachedLocally: true,
          storedSecrets: { 'm.cross_signing.master': 'real-master' }, // partial
        });

        await expect(
          firstValueFrom(svc.recoverWithKey(VALID_KEY)),
        ).resolves.toBeUndefined();
        expect(crypto.importSecretsBundle).not.toHaveBeenCalled();
      });

      it('leaves an ordinary untrusted device to the SDK, holding no privates to evict', async () => {
        // isCrossSigningReady() is `identity.isVerified() && (cached || in 4S)`, so it is
        // false for EVERY unverified device — including one that has simply never
        // imported anything, where there is nothing stale and the SDK's own bootstrap is
        // what should run. Only a device already holding privates is stranded.
        const { svc, crypto } = setup({
          defaultKeyId: 'k',
          checkKey: true,
          crossSigningReady: false,
          privatesCachedLocally: false,
          storedSecrets: SEEDS,
        });

        await firstValueFrom(svc.recoverWithKey(VALID_KEY));

        expect(crypto.exportSecretsBundle).not.toHaveBeenCalled();
        expect(crypto.importSecretsBundle).not.toHaveBeenCalled();
      });

      it('keeps a recovery that worked when the repair itself cannot run', async () => {
        // exportSecretsBundle fails unless all three privates are available, and both
        // bundle methods are optional on CryptoApi. None of that says the user's key was
        // wrong — and bootstrapCrossSigning may already have trusted this device.
        const { svc, crypto } = setup({
          defaultKeyId: 'k',
          checkKey: true,
          crossSigningReady: false,
          privatesCachedLocally: true,
          deviceVerified: true, // the bootstrap trusted it after all
          storedSecrets: SEEDS,
        });
        crypto.exportSecretsBundle.mockRejectedValue(
          new Error('The secrets bundle could not be exported'),
        );

        await expect(
          firstValueFrom(svc.recoverWithKey(VALID_KEY)),
        ).resolves.toBeUndefined();
        expect(svc.thisDeviceVerified()).toBe(true);
      });

      it('fails loudly if the SDK exports a bundle it does not recognise', async () => {
        // The field names come from the WASM crate's serde output, which no TypeScript
        // type pins down. Guessing past a change there would report success and leave
        // the device exactly as broken as before.
        const { svc, crypto } = setup({
          defaultKeyId: 'k',
          checkKey: true,
          crossSigningReady: false,
          privatesCachedLocally: true,
          storedSecrets: SEEDS,
        });
        crypto.exportSecretsBundle.mockResolvedValue({
          crossSigning: { masterKey: 'renamed-upstream' },
        });

        await expect(
          firstValueFrom(svc.recoverWithKey(VALID_KEY)),
        ).rejects.toThrow(/unrecognised shape/i);
        expect(crypto.importSecretsBundle).not.toHaveBeenCalled();
      });

      it('fails loudly if the SDK cannot import a secrets bundle at all', async () => {
        // Still untrusted afterwards, so the diagnostic is the useful thing to show.
        const { svc, crypto } = setup({
          defaultKeyId: 'k',
          checkKey: true,
          crossSigningReady: false,
          privatesCachedLocally: true,
          storedSecrets: SEEDS,
        });
        crypto.importSecretsBundle = undefined as never;

        await expect(
          firstValueFrom(svc.recoverWithKey(VALID_KEY)),
        ).rejects.toThrow(/SecretsBundle import\/export is missing/i);
      });
    });

    it('skips backup steps when no backup exists', async () => {
      const { svc, crypto } = setup({
        defaultKeyId: 'k',
        checkKey: true,
        backupInfo: null,
      });

      await firstValueFrom(svc.recoverWithKey(VALID_KEY));

      expect(crypto.bootstrapCrossSigning).toHaveBeenCalledWith({});
      expect(
        crypto.loadSessionBackupPrivateKeyFromSecretStorage,
      ).not.toHaveBeenCalled();
    });
  });

  describe('recoverWithPassphrase', () => {
    it('derives the key from the passphrase and recovers', async () => {
      const { svc, keys, crypto } = setup({
        defaultKeyId: 'k',
        checkKey: true,
        keyInfo: {
          passphrase: { algorithm: 'm.pbkdf2', salt: 'salty', iterations: 1 },
        },
      });

      await firstValueFrom(svc.recoverWithPassphrase('hunter2'));

      expect(keys.hasKey).toBe(true);
      expect(crypto.bootstrapCrossSigning).toHaveBeenCalledWith({});
      // Derives from the passphrase using the salt/iterations from the key info.
      expect(vi.mocked(deriveRecoveryKeyFromPassphrase)).toHaveBeenCalledWith(
        'hunter2',
        'salty',
        1,
        undefined,
      );
    });

    it('errors when the account has no recovery passphrase', async () => {
      const { svc } = setup({ defaultKeyId: 'k', checkKey: true, keyInfo: {} });
      await expect(
        firstValueFrom(svc.recoverWithPassphrase('hunter2')),
      ).rejects.toThrow(/no recovery passphrase/i);
    });

    it('still completes recovery when enabling key backup fails', async () => {
      const { svc, keys, crypto } = setup({
        defaultKeyId: 'k',
        checkKey: true,
      });
      crypto.loadSessionBackupPrivateKeyFromSecretStorage.mockRejectedValue(
        new Error('stale backup key in 4S'),
      );

      // The device is trusted by bootstrapCrossSigning; a backup failure must not
      // reject the whole recovery.
      await expect(
        firstValueFrom(svc.recoverWithKey(VALID_KEY)),
      ).resolves.toBeUndefined();
      expect(keys.hasKey).toBe(true);
      expect(crypto.bootstrapCrossSigning).toHaveBeenCalledWith({});
    });
  });

  describe('setUp failures', () => {
    it('propagates a bootstrap failure to the caller', async () => {
      const { svc, crypto } = setup({});
      crypto.bootstrapSecretStorage.mockRejectedValue(new Error('boom'));
      await expect(firstValueFrom(svc.setUp(async () => 'pw'))).rejects.toThrow(
        /boom/,
      );
    });
  });

  describe('lifecycle and resilience', () => {
    it('does not reject when a crypto call fails during refresh', async () => {
      const { svc, crypto } = setup({ defaultKeyId: 'k' });
      // Model a real async SDK failure: a pending promise that rejects on the next
      // tick. `mockRejectedValue` returns a *synchronously* pre-rejected promise,
      // which trips zone.js's unhandled-rejection tracker in the window before
      // `Promise.all` attaches its handler — logging noise for an error the service
      // provably swallows (the assertion below).
      crypto.isCrossSigningReady.mockImplementation(async () => {
        throw new Error('transient');
      });
      await expect(firstValueFrom(svc.refresh())).resolves.toBeUndefined();
    });

    it('wires crypto listeners once and is idempotent', () => {
      const { svc, client } = setup({ defaultKeyId: 'k' });
      svc.connect();
      svc.connect();
      expect(client.on).toHaveBeenCalledTimes(4);
    });

    it('coalesces a burst of crypto events into one status recompute', async () => {
      const { svc, client, crypto } = setup({ defaultKeyId: 'k' });
      svc.connect();
      await Promise.resolve();
      crypto.isCrossSigningReady.mockClear();

      // These four arrive together after a key query; each used to run its own
      // computeStatus, which is several async crypto reads.
      client.emit(CryptoEvent.KeysChanged);
      client.emit(CryptoEvent.DevicesUpdated);
      client.emit(CryptoEvent.UserTrustStatusChanged);
      client.emit(CryptoEvent.KeyBackupStatus);
      // Flushed BEFORE asserting: the recompute is queued, so a count taken here
      // without the flush would read zero whether or not coalescing works.
      await Promise.resolve();
      await Promise.resolve();

      expect(crypto.isCrossSigningReady).toHaveBeenCalledTimes(1);
    });

    it('rewires onto a new client after re-login and recomputes status', async () => {
      const { svc, client, matrix } = setup({ defaultKeyId: null }); // A: needs-setup
      svc.connect();
      await firstValueFrom(svc.refresh());
      expect(svc.status()).toBe('needs-setup');

      // Client B reports an existing 4S key → needs-recovery.
      const cryptoB = {
        isCrossSigningReady: vi.fn().mockResolvedValue(false),
        isSecretStorageReady: vi.fn().mockResolvedValue(false),
        getActiveSessionBackupVersion: vi.fn().mockResolvedValue(null),
        getDeviceVerificationStatus: vi
          .fn()
          .mockResolvedValue({ crossSigningVerified: false }),
      };
      const clientB = {
        getCrypto: () => cryptoB,
        secretStorage: { getDefaultKeyId: vi.fn().mockResolvedValue('k') },
        getDeviceId: () => 'DEV',
        getUserId: () => '@me:hs',
        on: vi.fn(),
        off: vi.fn(),
      };
      ngMocks.stubMember(
        matrix,
        'instance',
        clientB as unknown as MatrixClientService['instance'],
      );

      svc.connect();
      await firstValueFrom(svc.refresh());

      expect(client.off).toHaveBeenCalled(); // old listeners detached
      expect(clientB.on).toHaveBeenCalled(); // new client wired
      expect(svc.status()).toBe('needs-recovery'); // not frozen on A
    });

    it('re-projects onto the newly-active account on a switch with no manual connect', async () => {
      // Account A is a first device with no secret storage → needs-setup.
      const { svc, client, matrix, activeUserId } = setup({
        defaultKeyId: null,
      });
      activeUserId.set('@a:hs');
      svc.connect(); // crypto listeners wired to account A
      await firstValueFrom(svc.refresh());
      expect(svc.status()).toBe('needs-setup');

      TestBed.inject(ApplicationRef).tick(); // effect's first run: still A → connect() no-op
      client.off.mockClear();

      // Account B already has a 4S key but this device isn't trusted → needs-recovery.
      const cryptoB = {
        isCrossSigningReady: vi.fn().mockResolvedValue(false),
        isSecretStorageReady: vi.fn().mockResolvedValue(false),
        getActiveSessionBackupVersion: vi.fn().mockResolvedValue(null),
        getDeviceVerificationStatus: vi
          .fn()
          .mockResolvedValue({ crossSigningVerified: false }),
      };
      const clientB = {
        getCrypto: () => cryptoB,
        secretStorage: { getDefaultKeyId: vi.fn().mockResolvedValue('k') },
        getDeviceId: () => 'DEV',
        getUserId: () => '@me:hs',
        on: vi.fn(),
        off: vi.fn(),
      };
      ngMocks.stubMember(
        matrix,
        'instance',
        clientB as unknown as MatrixClientService['instance'],
      );

      // Switch accounts: NO svc.connect() call — the reproject effect re-runs it.
      activeUserId.set('@b:hs');
      TestBed.inject(ApplicationRef).tick();

      expect(client.off).toHaveBeenCalled(); // detached from A's client
      expect(clientB.on).toHaveBeenCalled(); // wired onto B's client

      await firstValueFrom(svc.refresh());
      expect(svc.status()).toBe('needs-recovery'); // recomputed from B, not frozen on A
    });
  });

  describe('passwordUia (device-signing upload auth)', () => {
    // Capture the authUploadDeviceSigningKeys callback setUp hands to bootstrapCrossSigning.
    async function captureUia(promptPassword: () => Promise<string | null>) {
      const { svc, crypto } = setup({ defaultKeyId: 'k' });
      let uia!: (mr: (a: unknown) => Promise<unknown>) => Promise<unknown>;
      crypto.bootstrapCrossSigning.mockImplementation(
        async (opts: BootstrapCrossSigningOpts) => {
          uia = opts.authUploadDeviceSigningKeys as typeof uia;
        },
      );
      await firstValueFrom(svc.setUp(promptPassword));
      return uia;
    }

    it('does not prompt when the upload needs no auth', async () => {
      const prompt = vi.fn();
      const uia = await captureUia(prompt);
      const makeRequest = vi.fn().mockResolvedValue(undefined);

      await uia(makeRequest);

      expect(makeRequest).toHaveBeenCalledTimes(1);
      expect(makeRequest).toHaveBeenCalledWith(null);
      expect(prompt).not.toHaveBeenCalled();
    });

    it('submits the password against the returned UIA session', async () => {
      const prompt = vi.fn().mockResolvedValue('s3cret');
      const uia = await captureUia(prompt);
      const makeRequest = vi
        .fn()
        .mockRejectedValueOnce(uiaError('sess1'))
        .mockResolvedValueOnce(undefined);

      await uia(makeRequest);

      expect(prompt).toHaveBeenCalledOnce();
      expect(makeRequest).toHaveBeenCalledTimes(2);
      expect(makeRequest.mock.calls[1][0]).toMatchObject({
        type: 'm.login.password',
        password: 's3cret',
        session: 'sess1',
      });
    });

    it('re-prompts after a rejected password, then succeeds', async () => {
      const prompt = vi
        .fn()
        .mockResolvedValueOnce('wrong')
        .mockResolvedValueOnce('right');
      const uia = await captureUia(prompt);
      const makeRequest = vi
        .fn()
        .mockRejectedValueOnce(uiaError('s1')) // probe
        .mockRejectedValueOnce(uiaError('s2')) // wrong password
        .mockResolvedValueOnce(undefined); // right password

      await uia(makeRequest);

      expect(prompt).toHaveBeenCalledTimes(2);
      expect(makeRequest).toHaveBeenCalledTimes(3);
      expect(makeRequest.mock.calls[2][0]).toMatchObject({
        password: 'right',
        session: 's2',
      });
    });

    it('throws when the user cancels the password prompt', async () => {
      const prompt = vi.fn().mockResolvedValue(null);
      const uia = await captureUia(prompt);
      const makeRequest = vi.fn().mockRejectedValueOnce(uiaError('s1'));

      await expect(uia(makeRequest)).rejects.toThrow(/cancel/i);
    });

    it('rethrows a non-UIA error from the probe without prompting', async () => {
      const prompt = vi.fn();
      const uia = await captureUia(prompt);
      const makeRequest = vi
        .fn()
        .mockRejectedValue(
          new MatrixError({ errcode: 'M_LIMIT_EXCEEDED' }, 429),
        );

      await expect(uia(makeRequest)).rejects.toBeInstanceOf(MatrixError);
      expect(prompt).not.toHaveBeenCalled();
    });
  });

  describe('room-key export / import', () => {
    // The megolm file crypto uses WebCrypto subtle, absent in jsdom.
    beforeAll(() => vi.stubGlobal('crypto', webcrypto));
    afterAll(() => vi.unstubAllGlobals());

    it('exports the SDK keys as an encrypted megolm file', async () => {
      const { svc, crypto } = setup({
        exportedKeys: JSON.stringify([{ room_id: '!r:hs', session_id: 's' }]),
      });

      const armored = await firstValueFrom(svc.exportRoomKeys('pw'));

      expect(crypto.exportRoomKeysAsJson).toHaveBeenCalled();
      expect(armored).toContain('-----BEGIN MEGOLM SESSION DATA-----');
      expect(armored).not.toContain('!r:hs'); // encrypted, not plaintext
    });

    it('re-imports an exported file into the SDK (round-trip)', async () => {
      const keys = JSON.stringify([{ room_id: '!r:hs', session_id: 's' }]);
      const { svc, crypto } = setup({ exportedKeys: keys });

      const armored = await firstValueFrom(svc.exportRoomKeys('pw'));
      await firstValueFrom(svc.importRoomKeys(armored, 'pw'));

      expect(crypto.importRoomKeysAsJson).toHaveBeenCalledWith(keys);
    });

    it('rejects an import with the wrong passphrase and imports nothing', async () => {
      const { svc, crypto } = setup();
      const armored = await firstValueFrom(svc.exportRoomKeys('right'));

      await expect(
        firstValueFrom(svc.importRoomKeys(armored, 'wrong')),
      ).rejects.toThrow(/incorrect passphrase/i);
      expect(crypto.importRoomKeysAsJson).not.toHaveBeenCalled();
    });
  });
});
