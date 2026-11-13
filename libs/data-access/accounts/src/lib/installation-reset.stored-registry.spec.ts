// The erase against the real SessionStorageService, so what a stored registry does to it is real.
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory @capacitor/preferences, hoisted so the vi.mock factory can see it.
const { prefs } = vi.hoisted(() => ({ prefs: new Map<string, string>() }));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({
      value: prefs.get(key) ?? null,
    }),
    set: async ({ key, value }: { key: string; value: string }) => {
      prefs.set(key, value);
    },
    remove: async ({ key }: { key: string }) => {
      prefs.delete(key);
    },
  },
}));

import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  LocalDataWipeService,
  SecureStorageService,
  SessionStorageService,
} from '@trinity/platform-native';
import { ACCOUNT_LIFECYCLE_PORT } from './account-lifecycle.port';
import { InstallationResetWorkflow } from './installation-reset.workflow';
import { indexedDbWipe } from './matrix-account-runtime.spec-harness';

const ACCOUNTS_KEY = 'matrix.accounts';
const REGISTRY = {
  scope: 'account-registry',
  recovery: 'retry-installation-reset',
} as const;
const PREFERENCES = {
  scope: 'preferences',
  recovery: 'retry-installation-reset',
} as const;
const STORED = JSON.stringify({
  activeUserId: '@a:hs',
  accounts: [{ userId: '@a:hs', baseUrl: 'https://hs', deviceId: 'A' }],
});

function setup(options: { desktopKeychain?: boolean } = {}) {
  /** Preferences entries the wipe leaves when it holds the registry back. */
  const wipePreferences = vi.fn(async (keepRegistry?: boolean) => {
    for (const key of [...prefs.keys()]) {
      if (!keepRegistry || key !== ACCOUNTS_KEY) prefs.delete(key);
    }
    return true;
  });
  TestBed.configureTestingModule({
    providers: [
      MockProvider(MatrixClientService, {
        reauthTargets: signal<readonly string[]>([]).asReadonly(),
        clientFor: vi.fn(() => ({}) as never),
        signOutAll: vi.fn(() => of(void 0)),
        stop: vi.fn(() => of(void 0)),
      }),
      MockProvider(SecureStorageService, {
        get: vi.fn(() => Promise.resolve(null)),
        remove: vi.fn(() => Promise.resolve()),
        isSecure: vi.fn(() => Promise.resolve(true)),
      }),
      MockProvider(LocalDataWipeService, {
        beginIndexedDbWipe: vi.fn(() => indexedDbWipe()),
        wipeSecureStorage: vi.fn(() => Promise.resolve(true)),
        keychainAwaitingHost: vi.fn(() => Promise.resolve(false)),
        secretsRemovedByNameOnly: vi.fn(() =>
          Promise.resolve(!!options.desktopKeychain),
        ),
        wipeSharedFiles: vi.fn(() => Promise.resolve(true)),
        wipePreferences,
        wipeWebStorage: vi.fn(() => Promise.resolve(true)),
        wipeCacheStorage: vi.fn(() => Promise.resolve(true)),
        wipeServiceWorkerRegistrations: vi.fn(() => Promise.resolve(true)),
      }),
      {
        provide: ACCOUNT_LIFECYCLE_PORT,
        useValue: {
          forgetPushHandoff: () => of(void 0),
          unregisterNotifications: () => of(void 0),
          revokeProviderSession: () => of(void 0),
          stopMentionIndex: () => of(void 0),
          clearDrafts: () => undefined,
        },
      },
    ],
  });
  return {
    workflow: TestBed.inject(InstallationResetWorkflow),
    storage: TestBed.inject(SessionStorageService),
    secure: TestBed.inject(SecureStorageService),
    wipe: TestBed.inject(LocalDataWipeService),
    wipePreferences,
  };
}

beforeEach(() => prefs.clear());

describe('an erase over a stored registry that is not a registry', () => {
  it.each([
    ['unparseable', '{'],
    ['an empty object', '{}'],
    ['an array', '[]'],
    ['accounts that are no list', '{"accounts":{}}'],
    ['a list of something else', '{"accounts":[1]}'],
    ['JSON null', 'null'],
  ])('finishes on the second try: %s', async (_, value) => {
    const { workflow, wipe, wipePreferences } = setup({
      desktopKeychain: true,
    });
    prefs.set(ACCOUNTS_KEY, value);
    prefs.set('trinity.app-lock', 'on');

    await expect(firstValueFrom(workflow.reset())).resolves.toEqual({
      kind: 'partial-cleanup',
      issues: [REGISTRY],
    });
    expect(wipe.beginIndexedDbWipe).toHaveBeenCalledOnce();
    expect(wipePreferences).toHaveBeenCalledExactlyOnceWith(false);
    expect([...prefs.keys()]).toEqual([]);

    await expect(firstValueFrom(workflow.retry([REGISTRY]))).resolves.toEqual({
      kind: 'ready',
    });
  });
});

describe('an erase whose keychain removal fails on the desktop keychain', () => {
  it('keeps only the registry entry, which no longer restores its accounts, and finishes once the removal works', async () => {
    const { workflow, storage, secure, wipePreferences } = setup({
      desktopKeychain: true,
    });
    prefs.set(ACCOUNTS_KEY, STORED);
    prefs.set('trinity.app-lock', 'on');
    vi.mocked(secure.remove).mockRejectedValue(new Error('store file locked'));

    await expect(firstValueFrom(workflow.reset())).resolves.toEqual({
      kind: 'partial-cleanup',
      issues: [REGISTRY, PREFERENCES],
    });
    // The lock setting goes with the data it protected; the map to the keychain stays.
    expect(wipePreferences).toHaveBeenCalledExactlyOnceWith(true);
    expect([...prefs.keys()]).toEqual([ACCOUNTS_KEY]);
    // What a restart reads: no accounts to restore, only the erase to finish.
    await expect(firstValueFrom(storage.snapshot())).rejects.toThrow();
    await expect(firstValueFrom(storage.list())).resolves.toHaveLength(1);

    vi.mocked(secure.remove).mockResolvedValue();
    await expect(
      firstValueFrom(workflow.retry([REGISTRY, PREFERENCES])),
    ).resolves.toEqual({ kind: 'ready' });
    expect([...prefs.keys()]).toEqual([]);
    await expect(firstValueFrom(storage.snapshot())).resolves.toEqual({
      activeAccountId: null,
      accounts: [],
    });
  });

  it('finishes from a restart too, reading the kept registry for the names', async () => {
    const first = setup({ desktopKeychain: true });
    prefs.set(ACCOUNTS_KEY, STORED);
    vi.mocked(first.secure.remove).mockRejectedValue(new Error('locked'));
    await firstValueFrom(first.workflow.reset());
    TestBed.resetTestingModule();

    const { workflow, secure } = setup({ desktopKeychain: true });
    await expect(firstValueFrom(workflow.reset())).resolves.toEqual({
      kind: 'ready',
    });
    expect(secure.remove).toHaveBeenCalledWith('matrix.accessToken:@a:hs');
    expect([...prefs.keys()]).toEqual([]);
  });
});
