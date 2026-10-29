// Shared TestBed scaffolding and fixtures for the MatrixAccountRuntimeAdapter specs.
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { signal } from '@angular/core';
import { type Observable, of } from 'rxjs';
import { vi } from 'vitest';
import {
  SESSION_ENGINE,
  SessionStateService,
  type SessionAccountStatus,
  type SessionEngine,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import {
  engineFail,
  engineOk,
  type AccountStartFailureReason,
  type EngineResult,
} from '@trinity/util/matrix';
import {
  LocalDataWipeService,
  SecureStorageService,
  SessionStorageService,
  type AccountRecord,
} from '@trinity/platform-native';
import {
  ACCOUNT_LIFECYCLE_PORT,
  type AccountLifecyclePort,
} from './account-lifecycle.port';
import type { AccountEstablishmentIntent } from './account-runtime.models';
import { MatrixAccountRuntimeAdapter } from './matrix-account-runtime.adapter';
import { UNPROTECTED_STORAGE_CONSENT } from './unprotected-storage-consent.port';

export const session = {
  baseUrl: 'https://hs',
  userId: '@new:hs',
  deviceId: 'DEVICE',
  accessToken: 'access',
};

export const activeIntent = {
  placement: 'active',
  liveAccounts: 'replace',
  accountRecord: 'upsert',
} satisfies AccountEstablishmentIntent;

type EngineStub = Pick<
  SessionEngine,
  | 'session'
  | 'restorePersisted'
  | 'requireReauthentication'
  | 'activateAccount'
  | 'rollbackAccountStart'
  | 'setActive'
  | 'stop'
  | 'signOutAll'
  | 'remove'
  | 'liveCredentials'
  | 'logoutRemote'
  | 'logoutSession'
>;

/** A snapshot in which exactly these accounts are live. */
export function liveSession(...accountIds: string[]): SessionSnapshot {
  return {
    activeAccountId: null,
    accounts: accountIds.map((accountId) => ({
      accountId,
      deviceId: 'DEVICE',
      generation: 1,
      syncState: 'syncing',
      serverSynced: true,
      roomsPrepared: true,
      waitingCount: 0,
      cryptoStoreEncrypted: true,
    })),
    softLoggedOut: [],
  };
}

export const started = (): Observable<EngineResult<null>> => of(engineOk(null));

export function startFailed(
  reason: AccountStartFailureReason,
): Observable<EngineResult<null>> {
  return of(
    engineFail({
      kind: 'unexpected',
      code: 'account-start-failed',
      diagnostic: { kind: 'unexpected' },
      params: { reason },
    }),
  );
}

export function setup(activeAccountId: string | null = '@old:hs') {
  const active = signal(activeAccountId);
  /** Live accounts in registry order, with their client generation. */
  const liveAccounts = new Map<string, number>();
  const refreshTokens = new Map<string, string>();
  const wipeIndexedDb = vi.fn((_records: readonly never[]) =>
    Promise.resolve({ blocked: [], failed: [], enumerated: true }),
  );
  const wipeAdapter = {
    wipeIndexedDb,
    beginIndexedDbWipe: vi.fn((records: readonly never[]) => {
      const settlement = wipeIndexedDb(records);
      return { observation: settlement, settlement };
    }),
    wipeKeyValueStores: vi.fn(() =>
      Promise.resolve({
        secureStorage: true,
        preferences: true,
        webStorage: true,
      }),
    ),
    wipeServiceWorker: vi.fn(() =>
      Promise.resolve({ cacheStorage: true, registrations: true }),
    ),
    wipeSecureStorage: vi.fn(() => Promise.resolve(true)),
    wipePreferences: vi.fn(() => Promise.resolve(true)),
    wipeWebStorage: vi.fn(() => Promise.resolve(true)),
    wipeCacheStorage: vi.fn(() => Promise.resolve(true)),
    wipeServiceWorkerRegistrations: vi.fn(() => Promise.resolve(true)),
  };
  const lifecycle: AccountLifecyclePort = {
    forgetPushHandoff: vi.fn(() => of(void 0)),
    registerNotifications: vi.fn(() => of(void 0)),
    unregisterNotifications: vi.fn(() => of(void 0)),
    revokeProviderSession: vi.fn(() => of(void 0)),
    stopDiagnosticLog: vi.fn(() => of(void 0)),
    resumeDiagnosticLog: vi.fn(() => of(void 0)),
    releaseSharedCaches: vi.fn(),
    clearDrafts: vi.fn(),
    forgetAccountPreferences: vi.fn(() => of(void 0)),
  };
  const engine = {
    session: vi.fn<EngineStub['session']>(() =>
      of(liveSession(session.userId, '@next:hs')),
    ),
    restorePersisted: vi.fn<EngineStub['restorePersisted']>(started),
    requireReauthentication: vi.fn<EngineStub['requireReauthentication']>(() =>
      of(null),
    ),
    activateAccount: vi.fn<EngineStub['activateAccount']>(started),
    rollbackAccountStart: vi.fn<EngineStub['rollbackAccountStart']>(() =>
      of(null),
    ),
    setActive: vi.fn<EngineStub['setActive']>(() => of(null)),
    stop: vi.fn<EngineStub['stop']>(() => of(null)),
    signOutAll: vi.fn<EngineStub['signOutAll']>(() => of(null)),
    /** Retires the account and repoints the active one, as the engine does. */
    remove: vi.fn<EngineStub['remove']>((accountId) => {
      liveAccounts.delete(accountId);
      if (active() === accountId) {
        active.set(liveAccounts.keys().next().value ?? null);
      }
      return of(null);
    }),
    liveCredentials: vi.fn<EngineStub['liveCredentials']>((accountId) =>
      of(
        liveAccounts.has(accountId)
          ? {
              // Per generation, so a spec can tell the captured token from a newer sign-in's.
              accessToken: `live-${accountId}-g${liveAccounts.get(accountId)}`,
              refreshToken: refreshTokens.get(accountId) ?? null,
            }
          : null,
      ),
    ),
    logoutRemote: vi.fn<EngineStub['logoutRemote']>(() => started()),
    logoutSession: vi.fn<EngineStub['logoutSession']>(() => started()),
  } satisfies EngineStub;
  TestBed.configureTestingModule({
    providers: [
      MatrixAccountRuntimeAdapter,
      { provide: SESSION_ENGINE, useValue: engine },
      MockProvider(SessionStateService, {
        activeAccountId: active.asReadonly(),
        status: vi.fn((accountId: string) => {
          const generation = liveAccounts.get(accountId);
          return generation === undefined
            ? null
            : ({ accountId, generation } as SessionAccountStatus);
        }),
      }),
      MockProvider(SessionStorageService),
      MockProvider(SecureStorageService, {
        withoutKeychain: vi.fn(() => Promise.resolve(false)),
        unprotectedStorageAcknowledged: vi.fn(() => Promise.resolve(null)),
        acknowledgeUnprotectedStorage: vi.fn(() => Promise.resolve()),
      }),
      MockProvider(LocalDataWipeService, wipeAdapter),
      { provide: ACCOUNT_LIFECYCLE_PORT, useValue: lifecycle },
      {
        provide: UNPROTECTED_STORAGE_CONSENT,
        useValue: { confirm: vi.fn(() => of(false)) },
      },
    ],
  });
  return {
    adapter: TestBed.inject(MatrixAccountRuntimeAdapter),
    engine,
    /** Makes these accounts live, each with a client of the given generation. */
    goLive: (
      accountIds: readonly string[],
      generation = 1,
      refreshToken: string | null = null,
    ) => {
      for (const accountId of accountIds) {
        liveAccounts.set(accountId, generation);
        if (refreshToken) refreshTokens.set(accountId, refreshToken);
      }
    },
    storage: TestBed.inject(SessionStorageService),
    wipe: TestBed.inject(LocalDataWipeService),
    secure: TestBed.inject(SecureStorageService),
    consent: TestBed.inject(UNPROTECTED_STORAGE_CONSENT),
    lifecycle,
    active,
  };
}

export type AdapterTest = ReturnType<typeof setup>;

export function prepareSuccessfulReset(
  test: AdapterTest,
  records: AccountRecord[] = [],
): void {
  vi.mocked(test.storage.list).mockReturnValue(of(records));
  vi.mocked(test.storage.load).mockReturnValue(of(null));
  vi.mocked(test.lifecycle.unregisterNotifications).mockReturnValue(of(void 0));
  vi.mocked(test.engine.signOutAll).mockReturnValue(of(null));
  vi.mocked(test.engine.stop).mockReturnValue(of(null));
  vi.mocked(test.storage.clearAll).mockReturnValue(of([]));
}

/** Let the establishment's asynchronous keychain check run before the test goes on. */
export function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

export function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export const OIDC_BINDING = {
  issuer: 'https://issuer',
  clientId: 'client',
  redirectUri: 'https://app/sso-callback',
};
export const OIDC_RECORD = {
  userId: '@oidc:hs',
  baseUrl: 'https://hs',
  deviceId: 'A',
  oidc: OIDC_BINDING,
} as never;
export const OIDC_STORED = {
  userId: '@oidc:hs',
  baseUrl: 'https://hs',
  deviceId: 'A',
  accessToken: 'at',
  refreshToken: 'rt',
  oidc: OIDC_BINDING,
} as never;
