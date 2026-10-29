import { webcrypto } from 'node:crypto';
import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ngMocks } from 'ng-mocks';
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
import { ClientEvent, MatrixError } from 'matrix-js-sdk';
import {
  CryptoEvent,
  deriveRecoveryKeyFromPassphrase,
  encodeRecoveryKey,
  type BootstrapCrossSigningOpts,
} from 'matrix-js-sdk/lib/crypto-api';
import {
  MatrixClientService,
  SecretStorageKeyHolder,
} from '@trinity/data-access/matrix-client';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import { secretsBundle, setup, uiaError } from './trust.spec-harness';

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

describe('TrustService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  describe('provider recovery', () => {
    it('returns a deep link only when the provider advertises cross-signing reset', async () => {
      const { svc } = setup({
        providerManagement: {
          url: 'https://auth.example/account?tenant=acme',
          actionsSupported: ['org.matrix.cross_signing_reset'],
        },
      });

      const url = await firstValueFrom(svc.providerResetLink());

      expect(url).toContain('tenant=acme');
      expect(url).toContain('action=org.matrix.cross_signing_reset');
    });

    it('returns null for malformed provider metadata', async () => {
      const { svc } = setup({
        providerManagement: {
          url: 'https://',
          actionsSupported: ['org.matrix.cross_signing_reset'],
        },
      });

      await expect(firstValueFrom(svc.providerResetLink())).resolves.toBeNull();
    });

    it('keeps provider lookup failures out of the Trust error channel', async () => {
      const { svc } = setup({ providerLookupFails: true });

      await expect(firstValueFrom(svc.providerResetLink())).resolves.toBeNull();
    });
  });

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
      expect(svc.health()).toMatchObject({ availability: 'coherent' });
    });

    it('is "needs-setup" when no secret storage exists yet', async () => {
      const { svc } = setup({ defaultKeyId: null });
      await firstValueFrom(svc.refresh());

      expect(svc.status()).toBe('needs-setup');
      expect(svc.keyBackupActive()).toBe(false);
      expect(svc.thisDeviceVerified()).toBe(false);
    });

    it('is "needs-verification" when another device set up an identity without recovery', async () => {
      const { svc } = setup({ defaultKeyId: null, identityOnServer: true });
      await firstValueFrom(svc.refresh());

      expect(svc.status()).toBe('needs-verification');
      expect(svc.thisDeviceVerified()).toBe(false);
    });

    it('says recovery belongs on the other device when this one is verified but lacks the keys', async () => {
      // Verified through another device on an account without secret storage: the SDK
      // never requests the cross-signing privates afterwards, so setup here would
      // replace the identity. Only the device holding it can set recovery up.
      const { svc } = setup({ identityOnServer: true, deviceVerified: true });
      await firstValueFrom(svc.refresh());

      expect(svc.status()).toBe('needs-setup');
      expect(svc.recoverySetupElsewhere()).toBe(true);
    });

    it('offers setup here when this device holds the identity', async () => {
      const { svc } = setup({
        identityOnServer: true,
        deviceVerified: true,
        privatesCachedLocally: true,
        crossSigningReady: true,
      });
      await firstValueFrom(svc.refresh());

      expect(svc.status()).toBe('needs-setup');
      expect(svc.recoverySetupElsewhere()).toBe(false);
    });

    it('offers setup here when the account has no identity yet', async () => {
      const { svc } = setup();
      await firstValueFrom(svc.refresh());

      expect(svc.status()).toBe('needs-setup');
      expect(svc.recoverySetupElsewhere()).toBe(false);
    });

    it('does not say recovery belongs elsewhere while this device still needs verifying', async () => {
      const { svc } = setup({ identityOnServer: true });
      await firstValueFrom(svc.refresh());

      expect(svc.status()).toBe('needs-verification');
      expect(svc.recoverySetupElsewhere()).toBe(false);
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
      expect(svc.keyBackupActive()).toBeNull();
      expect(svc.thisDeviceVerified()).toBeNull();
      expect(svc.health()).toEqual({
        availability: 'unavailable',
        current: null,
        stale: null,
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
        ).rejects.toMatchObject({
          operation: 'recover',
          kind: 'server-failure',
          recovery: 'retry',
        });
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
        ).rejects.toMatchObject({
          operation: 'recover',
          kind: 'server-failure',
          recovery: 'retry',
        });
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

  describe('lifecycle and resilience', () => {
    it('emits a typed failure when an explicit refresh cannot read crypto', async () => {
      const { svc, crypto } = setup({ defaultKeyId: 'k' });
      await firstValueFrom(svc.refresh());
      expect(svc.status()).toBe('needs-recovery');

      // Model a real async SDK failure: a pending promise that rejects on the next
      // tick. `mockRejectedValue` returns a *synchronously* pre-rejected promise,
      // which trips zone.js's unhandled-rejection tracker in the window before
      // `Promise.all` attaches its handler.
      crypto.isCrossSigningReady.mockImplementation(async () => {
        throw new Error('transient');
      });
      await expect(firstValueFrom(svc.refresh())).rejects.toMatchObject({
        operation: 'refresh-health',
        kind: 'server-failure',
        recovery: 'retry',
      });
      expect(svc.status()).toBe('unknown');
      expect(svc.keyBackupActive()).toBeNull();
      expect(svc.thisDeviceVerified()).toBeNull();
      expect(svc.health()).toMatchObject({
        availability: 'stale',
        current: null,
        stale: { status: 'needs-recovery' },
      });
    });

    it('labels an event-driven read failure stale and reports the retained projection failed', async () => {
      const { svc, client, crypto } = setup({
        crossSigningReady: true,
        secretStorageReady: true,
        backupVersion: '1',
        deviceVerified: true,
        defaultKeyId: 'k',
      });
      const observations: string[] = [];
      const lifetime = svc.runProjection().subscribe();
      const observation = TestBed.inject(ProjectionRuntime)
        .observe('trust.health', { kind: 'active-account' })
        .subscribe((state) => observations.push(state.condition));
      await vi.waitFor(() => expect(svc.status()).toBe('ready'));

      crypto.isCrossSigningReady.mockImplementation(async () => {
        throw new Error('private SDK fault');
      });
      client.emit(CryptoEvent.KeysChanged);
      await vi.waitFor(() => expect(observations.at(-1)).toBe('failed'));
      expect(svc.health()).toMatchObject({
        availability: 'stale',
        current: null,
        stale: { status: 'ready' },
      });
      expect(svc.status()).toBe('unknown');
      expect(svc.thisDeviceVerified()).toBeNull();
      expect(JSON.stringify(svc.health())).not.toContain('private SDK fault');
      observation.unsubscribe();
      lifetime.unsubscribe();
    });

    it('reports missing crypto for a demanded Account as unavailable projection health', async () => {
      const { svc } = setup({ hasCrypto: false });
      const observations: string[] = [];
      const runtime = TestBed.inject(ProjectionRuntime);
      const lifetime = svc.runProjection().subscribe();
      const observation = runtime
        .observe('trust.health', { kind: 'active-account' })
        .subscribe((state) => observations.push(state.condition));

      await vi.waitFor(() => expect(observations.at(-1)).toBe('failed'));
      expect(svc.health()).toEqual({
        availability: 'unavailable',
        current: null,
        stale: null,
      });
      expect(svc.status()).toBe('unknown');
      expect(svc.thisDeviceVerified()).toBeNull();

      observation.unsubscribe();
      lifetime.unsubscribe();
    });

    it('refreshes restored secret-storage readiness when fresh account data arrives', async () => {
      const { svc, client, crypto } = setup({
        crossSigningReady: true,
        secretStorageReady: false,
        defaultKeyId: 'new-recovery-key',
      });
      const lifetime = svc.runProjection().subscribe();
      try {
        await vi.waitFor(() => expect(svc.status()).toBe('needs-recovery'));

        // Reload can first read cached secrets encrypted with the old default key.
        // Fresh /sync supplies the matching secrets without changing crypto identity.
        crypto.isSecretStorageReady.mockResolvedValue(true);
        client.emit(ClientEvent.AccountData);

        await vi.waitFor(() => expect(svc.status()).toBe('ready'));
      } finally {
        lifetime.unsubscribe();
      }
    });

    it('wires health listeners once and is idempotent', () => {
      const { svc, client } = setup({ defaultKeyId: 'k' });
      svc.runProjection().subscribe();
      svc.runProjection().subscribe();
      expect(client.on).toHaveBeenCalledTimes(5);
    });

    it('coalesces a burst of crypto events into one status recompute', async () => {
      const { svc, client, crypto } = setup({ defaultKeyId: 'k' });
      svc.runProjection().subscribe();
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
      const { svc, client, matrix, generation } = setup({
        defaultKeyId: null,
      }); // A: needs-setup
      svc.runProjection().subscribe();
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
        getCrossSigningStatus: vi.fn().mockResolvedValue({
          publicKeysOnDevice: false,
          privateKeysInSecretStorage: false,
          privateKeysCachedLocally: {
            masterKey: false,
            selfSigningKey: false,
            userSigningKey: false,
          },
        }),
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

      // The session registers the new client under a new generation.
      generation.set(2);
      TestBed.inject(ApplicationRef).tick();
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
      svc.runProjection().subscribe(); // crypto listeners wired to account A
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
        getCrossSigningStatus: vi.fn().mockResolvedValue({
          publicKeysOnDevice: false,
          privateKeysInSecretStorage: false,
          privateKeysCachedLocally: {
            masterKey: false,
            selfSigningKey: false,
            userSigningKey: false,
          },
        }),
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
      ).rejects.toMatchObject({
        operation: 'import-keys',
        kind: 'invalid-secret',
        recovery: 'reenter-secret',
      });
      expect(crypto.importRoomKeysAsJson).not.toHaveBeenCalled();
    });

    it('imports into the account the file was decrypted for, not whichever is active now', async () => {
      // Decrypting the file is a long await; a switch across it must not push one
      // account's room keys into another account's olm machine.
      const { svc, crypto, client, matrix } = setup();
      const armored = await firstValueFrom(svc.exportRoomKeys('pw'));
      const otherCrypto = { importRoomKeysAsJson: vi.fn() };

      const pending = firstValueFrom(svc.importRoomKeys(armored, 'pw'));
      ngMocks.stubMember(matrix, 'instance', {
        ...client,
        getCrypto: () => otherCrypto,
      } as unknown as MatrixClientService['instance']);
      await pending;

      expect(crypto.importRoomKeysAsJson).toHaveBeenCalledWith('[]');
      expect(otherCrypto.importRoomKeysAsJson).not.toHaveBeenCalled();
    });
  });
});
