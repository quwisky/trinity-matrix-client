// Shared TestBed scaffolding and fixtures for the MatrixAccountRuntimeAdapter specs.
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  LocalDataWipeService,
  NativeTokenBridge,
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

export function setup(activeAccountId: string | null = '@old:hs') {
  const active = signal(activeAccountId);
  const softLoggedOut = signal<readonly string[]>([]);
  const reauthTargets = signal<readonly string[]>([]);
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
  TestBed.configureTestingModule({
    providers: [
      MatrixAccountRuntimeAdapter,
      MockProvider(MatrixClientService, {
        activeUserId: active.asReadonly(),
        softLoggedOut: softLoggedOut.asReadonly(),
        reauthTargets: reauthTargets.asReadonly(),
        clientFor: vi.fn(() => ({}) as never),
        rollbackAccountStart: vi.fn(() => of(void 0)),
      }),
      MockProvider(SessionStorageService),
      MockProvider(NativeTokenBridge, {
        removeUnreadableRecord: vi.fn(() => of(void 0)),
      }),
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
    matrix: TestBed.inject(MatrixClientService),
    storage: TestBed.inject(SessionStorageService),
    nativeTokens: TestBed.inject(NativeTokenBridge),
    wipe: TestBed.inject(LocalDataWipeService),
    secure: TestBed.inject(SecureStorageService),
    consent: TestBed.inject(UNPROTECTED_STORAGE_CONSENT),
    lifecycle,
    active,
    softLoggedOut,
    reauthTargets,
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
  vi.mocked(test.matrix.signOutAll).mockReturnValue(of(void 0));
  vi.mocked(test.matrix.stop).mockReturnValue(of(void 0));
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
