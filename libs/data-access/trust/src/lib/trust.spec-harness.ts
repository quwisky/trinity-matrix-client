// Shared TestBed scaffolding for the TrustService specs.
//
// trust.service.spec.ts and trust-setup.spec.ts drive the service over the real js-sdk
// engine on the same fake crypto, secret storage and client (`setup`), and over the fake
// engine (`onFakeEngine`), so they share one copy of the doubles here.
import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { MatrixError } from 'matrix-js-sdk';
import { TrustService } from './trust.service';
import {
  TRUST_PROVIDER_RECOVERY,
  type TrustProviderManagement,
} from './trust-provider-recovery.port';
import {
  JS_SDK_CLIENTS,
  SESSION_SNAPSHOT,
  type SessionSnapshot,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import { FakeTrustEngine } from '../contract/fake-trust-engine';
import { TRUST_ENGINE } from './trust-engine.token';

/** A 401 UIA challenge carrying flows + session, as the SDK surfaces it. */
export function uiaError(session: string): MatrixError {
  return new MatrixError(
    { flows: [{ stages: ['m.login.password'] }], session },
    401,
  );
}

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
  /**
   * Whether the homeserver holds a cross-signing identity for the account. False by
   * default: most tests model a first device or one that already unlocked recovery.
   */
  identityOnServer?: boolean;
  /**
   * Whether `/keys/query` returns a master key for the account. Defaults to
   * `identityOnServer`. Set false for the device a cancelled first setup left with keys
   * it never published (#1225).
   */
  masterKeyOnServer?: boolean;
  /** The master key this device's identity has; the server publishes `MASTER`. */
  localMasterKey?: string;
  providerManagement?: TrustProviderManagement | null;
  providerLookupFails?: boolean;
}

/** The three seed names `getCrossSigningStatus` reports on. */
const SEED_NAMES = [
  'm.cross_signing.master',
  'm.cross_signing.self_signing',
  'm.cross_signing.user_signing',
];

/** The shape matrix-js-sdk exports for a SecretsBundle (serde field names). */
export function secretsBundle(seeds = 'stale') {
  return {
    cross_signing: {
      master_key: `${seeds}-master`,
      self_signing_key: `${seeds}-self`,
      user_signing_key: `${seeds}-user`,
    },
    backup: { algorithm: 'm.megolm_backup.v1', key: 'bk', backup_version: '1' },
  };
}

/** The cross-signing master key `/keys/query` returns for a published identity. */
function masterKeyFor(userId: string) {
  return {
    user_id: userId,
    usage: ['master'],
    keys: { 'ed25519:MASTER': 'MASTER' },
  };
}

export function setup(opts: CryptoOpts = {}) {
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
    userHasCrossSigningKeys: vi
      .fn()
      .mockResolvedValue(opts.identityOnServer ?? false),
    getCrossSigningKeyId: vi
      .fn()
      .mockResolvedValue(opts.localMasterKey ?? 'MASTER'),
    // Modelled on rust-crypto's own: 4S "contains" the keys only when all three are
    // there, and the locally cached set is what the olm machine happens to hold.
    getCrossSigningStatus: vi.fn().mockResolvedValue({
      publicKeysOnDevice: opts.identityOnServer ?? false,
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
    // The account's published identity, as `/keys/query` reports it.
    downloadKeysForUsers: vi.fn(async (userIds: string[]) =>
      (opts.masterKeyOnServer ?? opts.identityOnServer ?? false)
        ? { master_keys: { [userIds[0]]: masterKeyFor(userIds[0]) } }
        : {},
    ),
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

  // Writable so tests can flip the active account and fire the reproject effect.
  const activeUserId = signal<string | null>(null);
  // Health reads the active account through the engine, over whichever client is stubbed.
  const activeAccountId = computed(() => activeUserId() ?? '@me:hs');
  // Bumped by a test to model a new client for the same account (re-login).
  const generation = signal(1);
  // The account's live client; a test swaps it with `useClient`.
  let live: unknown = client;
  TestBed.configureTestingModule({
    providers: [
      TrustService,
      MockProvider(SessionStateService, {
        activeAccountId,
        active: computed(() => ({
          accountId: activeAccountId(),
          generation: generation(),
        })) as unknown as SessionStateService['active'],
      }),
      {
        provide: JS_SDK_CLIENTS,
        useValue: { clientFor: () => live, holderFor: () => null },
      },
      {
        provide: TRUST_PROVIDER_RECOVERY,
        useValue: {
          accountManagement: () =>
            opts.providerLookupFails
              ? throwError(() => new Error('provider unavailable'))
              : of(opts.providerManagement ?? null),
        },
      },
    ],
  });

  return {
    svc: TestBed.inject(TrustService),
    crypto,
    secretStorage,
    client,
    useClient: (next: unknown) => (live = next),
    activeUserId,
    generation,
  };
}

/** TrustService over the fake engine, with `active` the session's active account. */
export function onFakeEngine(
  active: string | null = '@alice:contract.invalid',
) {
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
      {
        provide: TRUST_PROVIDER_RECOVERY,
        useValue: { accountManagement: () => of(null) },
      },
    ],
  });
  return {
    svc: TestBed.inject(TrustService),
    engine,
    alice: engine.alice,
    session,
  };
}
