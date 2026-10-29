import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientEvent, MatrixError } from 'matrix-js-sdk';
import {
  CryptoEvent,
  type BootstrapCrossSigningOpts,
} from 'matrix-js-sdk/lib/crypto-api';
import {
  MatrixClientService,
  SESSION_SNAPSHOT,
  type SessionSnapshot,
  TrustCryptoPort,
} from '@trinity/data-access/matrix-client';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import { FakeTrustEngine } from '../contract/fake-trust-engine';
import { TRUST_ENGINE } from './trust-engine.token';
import { TRUST_PROVIDER_RECOVERY } from './trust-provider-recovery.port';
import { TrustService } from './trust.service';
import { setup, uiaError } from './trust.spec-harness';

/** TrustService over the fake engine, with `active` the session's active account. */
function onFakeEngine(active: string | null = '@alice:contract.invalid') {
  const engine = new FakeTrustEngine();
  const session = signal<SessionSnapshot>({
    activeAccountId: active,
    accounts: [engine.alice].map((accountId) => ({
      accountId,
      deviceId: engine.deviceIdOf(accountId),
      generation: 1,
      syncState: 'syncing' as const,
      serverSynced: true,
      roomsPrepared: true,
      waitingCount: 0,
      cryptoStoreEncrypted: true,
    })),
    softLoggedOut: [],
  });
  TestBed.configureTestingModule({
    providers: [
      { provide: TRUST_ENGINE, useValue: engine },
      { provide: SESSION_SNAPSHOT, useValue: session },
      MockProvider(TrustCryptoPort),
      {
        provide: TRUST_PROVIDER_RECOVERY,
        useValue: { accountManagement: () => of(null) },
      },
    ],
  });
  return { svc: TestBed.inject(TrustService), engine, alice: engine.alice };
}

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

  describe('recovery on the engine', () => {
    it('recovers with the key and re-reads the health', async () => {
      const { svc, engine, alice } = onFakeEngine();
      const key = engine.setUpRecoveryElsewhere(alice);

      await firstValueFrom(svc.recoverWithKey(` ${key} `), {
        defaultValue: undefined,
      });

      expect(svc.health().current).toMatchObject({
        status: 'ready',
        thisDeviceVerified: true,
        keyBackupActive: true,
      });
    });

    it('recovers with the passphrase', async () => {
      const { svc, engine, alice } = onFakeEngine();
      engine.setUpRecoveryElsewhere(alice, 'hunter2');

      await firstValueFrom(svc.recoverWithPassphrase('hunter2'), {
        defaultValue: undefined,
      });

      expect(svc.thisDeviceVerified()).toBe(true);
    });

    it.each([
      [
        'a wrong key',
        (svc: TrustService) =>
          svc.recoverWithKey(
            'EsT3 4kza y1Xs efFA tKyi HVwT kdEP 4UEk rvNr dFvy 8nGq AkqP',
          ),
        'invalid-secret',
        'reenter-secret',
        'That recovery key is incorrect.',
      ],
      [
        'a wrong passphrase',
        (svc: TrustService) => svc.recoverWithPassphrase('wrong'),
        'invalid-secret',
        'reenter-secret',
        'That recovery key is incorrect.',
      ],
      [
        'a malformed key',
        (svc: TrustService) => svc.recoverWithKey('not a key'),
        'invalid-secret',
        'reenter-secret',
        'That does not look like a valid recovery key.',
      ],
    ] as const)(
      'refuses %s with its text',
      async (_label, recover, kind, recovery, message) => {
        const { svc, engine, alice } = onFakeEngine();
        engine.setUpRecoveryElsewhere(alice, 'hunter2');

        await expect(firstValueFrom(recover(svc))).rejects.toMatchObject({
          operation: 'recover',
          kind,
          recovery,
          message,
        });
        expect(svc.thisDeviceVerified()).not.toBe(true);
      },
    );

    it('refuses a passphrase for secret storage set up from a key', async () => {
      const { svc, engine, alice } = onFakeEngine();
      engine.setUpRecoveryElsewhere(alice);

      await expect(
        firstValueFrom(svc.recoverWithPassphrase('hunter2')),
      ).rejects.toMatchObject({
        kind: 'unsupported',
        recovery: 'reenter-secret',
        message:
          'This account has no recovery passphrase — enter the recovery key instead.',
      });
    });

    it('says when the account has no recovery to unlock', async () => {
      const { svc } = onFakeEngine();

      await expect(
        firstValueFrom(svc.recoverWithKey('not a key')),
      ).rejects.toMatchObject({
        kind: 'recovery-not-configured',
        recovery: 'verify-another-device',
        message: 'No recovery key is set up on this account.',
      });
    });

    it('is not ready without an active account or its crypto', async () => {
      const notReady = {
        kind: 'not-ready',
        recovery: 'retry',
        message: 'Trust is not ready for this account yet.',
      };
      const signedOut = onFakeEngine(null);
      await expect(
        firstValueFrom(signedOut.svc.exportRoomKeys('pw')),
      ).rejects.toMatchObject({ operation: 'export-keys', ...notReady });
      TestBed.resetTestingModule();

      const { svc, engine } = onFakeEngine('@nocrypto:contract.invalid');
      engine.addAccount('@nocrypto:contract.invalid', { crypto: false });
      await expect(
        firstValueFrom(svc.recoverWithKey('not a key')),
      ).rejects.toMatchObject({ operation: 'recover', ...notReady });
    });
  });

  it('shows a refused signature upload during recovery as a permission refusal', async () => {
    const { svc, crypto } = setup({ defaultKeyId: 'k', checkKey: true });
    crypto.bootstrapCrossSigning.mockRejectedValue(
      new MatrixError({ errcode: 'M_FORBIDDEN' }, 403),
    );

    await expect(
      firstValueFrom(
        svc.recoverWithKey(
          'EsT3 4kza y1Xs efFA tKyi HVwT kdEP 4UEk rvNr dFvy 8nGq AkqP',
        ),
      ),
    ).rejects.toMatchObject({
      operation: 'recover',
      kind: 'permission-denied',
      recovery: 'retry',
      message: 'The homeserver refused this Trust change.',
    });
  });

  describe('room keys on the engine', () => {
    it('exports a key file and imports it back', async () => {
      const { svc } = onFakeEngine();

      const fileText = await firstValueFrom(svc.exportRoomKeys('pw'));

      expect(fileText).toContain('-----BEGIN MEGOLM SESSION DATA-----');
      await expect(
        firstValueFrom(svc.importRoomKeys(fileText, 'pw')),
      ).resolves.toBeUndefined();
    });

    it('refuses an import with the wrong passphrase', async () => {
      const { svc } = onFakeEngine();
      const fileText = await firstValueFrom(svc.exportRoomKeys('right'));

      await expect(
        firstValueFrom(svc.importRoomKeys(fileText, 'wrong')),
      ).rejects.toMatchObject({
        operation: 'import-keys',
        kind: 'invalid-secret',
        recovery: 'reenter-secret',
        message: 'The key export or its passphrase could not be verified.',
      });
    });
  });
});
