import { TestBed } from '@angular/core/testing';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixError } from 'matrix-js-sdk';
import {
  deriveRecoveryKeyFromPassphrase,
  encodeRecoveryKey,
} from 'matrix-js-sdk/lib/crypto-api';
import { CryptoService } from './crypto.service';
import { MatrixClientService } from './matrix-client.service';
import { SecretStorageKeyService } from './secret-storage-key.service';

/** A 401 UIA challenge carrying flows + session, as the SDK surfaces it. */
function uiaError(session: string): MatrixError {
  return new MatrixError(
    { flows: [{ stages: ['m.login.password'] }], session },
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
  };

  const client = {
    getCrypto: () => (opts.hasCrypto === false ? undefined : crypto),
    secretStorage,
    getDeviceId: () => 'DEV',
    getUserId: () => '@me:hs',
    on: vi.fn(),
    off: vi.fn(),
  };

  TestBed.configureTestingModule({
    providers: [
      CryptoService,
      SecretStorageKeyService,
      MockProvider(MatrixClientService),
    ],
  });

  const matrix = TestBed.inject(MatrixClientService);
  ngMocks.stubMember(matrix, 'isInitialized', true);
  ngMocks.stubMember(
    matrix,
    'instance',
    client as unknown as MatrixClientService['instance'],
  );

  return {
    svc: TestBed.inject(CryptoService),
    keys: TestBed.inject(SecretStorageKeyService),
    crypto,
    secretStorage,
    client,
    matrix,
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
  });

  describe('passwordUia (device-signing upload auth)', () => {
    // Capture the authUploadDeviceSigningKeys callback setUp hands to bootstrapCrossSigning.
    async function captureUia(promptPassword: () => Promise<string | null>) {
      const { svc, crypto } = setup({ defaultKeyId: 'k' });
      let uia!: (mr: (a: unknown) => Promise<unknown>) => Promise<unknown>;
      crypto.bootstrapCrossSigning.mockImplementation(async (opts: any) => {
        uia = opts.authUploadDeviceSigningKeys;
      });
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
});
