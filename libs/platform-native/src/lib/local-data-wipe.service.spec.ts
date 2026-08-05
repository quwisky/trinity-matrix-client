import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory @capacitor/preferences, hoisted so the vi.mock factory can see it. `calls`
// records the ordering assertions below depend on.
const { prefs, calls } = vi.hoisted(() => ({
  prefs: new Map<string, string>(),
  calls: [] as string[],
}));
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
    clear: async () => {
      calls.push('preferences.clear');
      prefs.clear();
    },
  },
}));

const { isNative } = vi.hoisted(() => ({ isNative: { value: false } }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => isNative.value },
}));

import { LocalDataWipeService } from './local-data-wipe.service';
import { SecureStorageService } from './secure-storage.service';
import type { AccountRecord } from './session-storage.service';

const ALICE = {
  baseUrl: 'https://hs',
  userId: '@alice:hs',
  deviceId: 'DEV1',
  cryptoPrefix: 'trinity-crypto:@alice:hs:DEV1',
} as AccountRecord;

/** A fake IDBFactory that records deletes and reports every one as succeeding. */
function fakeIdb(names?: string[]) {
  const deleted: string[] = [];
  const factory = {
    deleteDatabase: (name: string) => {
      deleted.push(name);
      calls.push(`idb.delete:${name}`);
      const request: Record<string, (() => void) | null> = {};
      queueMicrotask(() => request['onsuccess']?.());
      return request as unknown as IDBOpenDBRequest;
    },
    ...(names
      ? { databases: async () => names.map((name) => ({ name })) }
      : {}),
  } as unknown as IDBFactory;
  return { factory, deleted };
}

function setup(bulkSecureClear = false) {
  TestBed.configureTestingModule({
    providers: [
      LocalDataWipeService,
      MockProvider(SecureStorageService, {
        clearAll: vi.fn(async () => {
          calls.push('secure.clearAll');
          return bulkSecureClear;
        }),
      }),
    ],
  });
  return TestBed.inject(LocalDataWipeService);
}

describe('LocalDataWipeService', () => {
  beforeEach(() => {
    prefs.clear();
    calls.length = 0;
    isNative.value = false;
  });

  afterEach(() => vi.unstubAllGlobals());

  describe('wipeIndexedDb', () => {
    it('deletes the sync store under its REAL name, not the one the app passes', async () => {
      // matrix-js-sdk prepends `matrix-js-sdk:` to the dbName it is given, so deleting
      // `trinity-sync:@alice:hs` would silently delete nothing and the "cleared" claim
      // would be a lie. Nothing else in the app observes the difference.
      const { factory, deleted } = fakeIdb();
      vi.stubGlobal('indexedDB', factory);

      await setup().wipeIndexedDb([ALICE]);

      expect(deleted).toContain('matrix-js-sdk:trinity-sync:@alice:hs');
      expect(deleted).not.toContain('trinity-sync:@alice:hs');
    });

    it('deletes both crypto databases for the account and the SDK-default pair', async () => {
      const { factory, deleted } = fakeIdb();
      vi.stubGlobal('indexedDB', factory);

      await setup().wipeIndexedDb([ALICE]);

      expect(deleted).toContain(
        'trinity-crypto:@alice:hs:DEV1::matrix-sdk-crypto',
      );
      expect(deleted).toContain(
        'trinity-crypto:@alice:hs:DEV1::matrix-sdk-crypto-meta',
      );
      // A migrated pre-multi-account session (and the crypto spike) sits on the default
      // prefix, which no account record names.
      expect(deleted).toContain('matrix-js-sdk::matrix-sdk-crypto');
      expect(deleted).toContain('matrix-js-sdk::matrix-sdk-crypto-meta');
    });

    it('still deletes the derived names when the browser cannot enumerate (Firefox)', async () => {
      const { factory, deleted } = fakeIdb(); // no `databases` member
      vi.stubGlobal('indexedDB', factory);

      const report = await setup().wipeIndexedDb([ALICE]);

      expect(report.enumerated).toBe(false);
      expect(deleted).toContain('matrix-js-sdk:trinity-sync:@alice:hs');
    });

    it('deletes an orphan no account record names, when enumeration is available', async () => {
      const { factory, deleted } = fakeIdb([
        'matrix-js-sdk:trinity-sync:@ghost:hs',
      ]);
      vi.stubGlobal('indexedDB', factory);

      const report = await setup().wipeIndexedDb([ALICE]);

      expect(report.enumerated).toBe(true);
      expect(deleted).toContain('matrix-js-sdk:trinity-sync:@ghost:hs');
    });

    it('reports a blocked database instead of hanging or claiming success', async () => {
      const factory = {
        deleteDatabase: () => {
          const request: Record<string, (() => void) | null> = {};
          queueMicrotask(() => request['onblocked']?.());
          return request as unknown as IDBOpenDBRequest;
        },
      } as unknown as IDBFactory;
      vi.stubGlobal('indexedDB', factory);

      const report = await setup().wipeIndexedDb([ALICE]);

      expect(report.blocked).toContain('matrix-js-sdk:trinity-sync:@alice:hs');
    });

    it('is a no-op off-browser rather than throwing', async () => {
      vi.stubGlobal('indexedDB', undefined);

      await expect(setup().wipeIndexedDb([ALICE])).resolves.toEqual({
        blocked: [],
        failed: [],
        enumerated: false,
      });
    });
  });

  describe('wipeKeyValueStores', () => {
    it('clears Preferences as a group rather than by key list', async () => {
      // The keys are not uniformly namespaced — trinity.*, matrix.*, oidc.*, sso.*, plus
      // unbounded per-issuer and per-user prefixes — so a list would be wrong the day it
      // was written. Seed one of each shape and assert the group clear takes them all.
      prefs.set('trinity.theme', 'dark');
      prefs.set('matrix.accounts', '{}');
      prefs.set('oidc.codeVerifier', 'SECRET');
      prefs.set('oidc.clientId.v2:https://op', 'c1');
      prefs.set('sso.state', 'NONCE');
      prefs.set('trinity.spaces.order.overrides.@alice:hs', '[]');

      await setup().wipeKeyValueStores();

      expect(prefs.size).toBe(0);
    });

    it('reports a backend that cannot sweep itself (Electron, web)', async () => {
      await expect(setup(false).wipeKeyValueStores()).resolves.toBe(false);
    });

    it('reports a backend that swept itself (native keychain/keystore)', async () => {
      await expect(setup(true).wipeKeyValueStores()).resolves.toBe(true);
    });

    it('clears raw web storage on web, where keys can live outside our namespace', async () => {
      const local = { clear: vi.fn() };
      const session = { clear: vi.fn() };
      vi.stubGlobal('localStorage', local);
      vi.stubGlobal('sessionStorage', session);

      await setup().wipeKeyValueStores();

      // matrix-js-sdk writes mx_pending_events_* here, and every throwaway createClient()
      // gets a localStorage-backed MemoryStore — neither is under CapacitorStorage.
      expect(local.clear).toHaveBeenCalled();
      expect(session.clear).toHaveBeenCalled();
    });

    it('leaves the WebView’s own storage alone on native', async () => {
      isNative.value = true;
      const local = { clear: vi.fn() };
      vi.stubGlobal('localStorage', local);

      await setup().wipeKeyValueStores();

      // Preferences is native there and holds everything of ours; the WebView's storage is
      // a separate, empty surface.
      expect(local.clear).not.toHaveBeenCalled();
    });
  });

  describe('wipeServiceWorker', () => {
    it('deletes every cache and unregisters every worker', async () => {
      const del = vi.fn(async () => true);
      vi.stubGlobal('caches', {
        keys: async () => ['ngsw:a', 'other'],
        delete: del,
      });
      const unregister = vi.fn(async () => true);
      vi.stubGlobal('navigator', {
        serviceWorker: { getRegistrations: async () => [{ unregister }] },
      });

      await setup().wipeServiceWorker();

      expect(del).toHaveBeenCalledWith('ngsw:a');
      expect(del).toHaveBeenCalledWith('other');
      expect(unregister).toHaveBeenCalled();
    });

    it('is a no-op where neither API exists (native, Electron, older browsers)', async () => {
      vi.stubGlobal('caches', undefined);
      vi.stubGlobal('navigator', {});

      await expect(setup().wipeServiceWorker()).resolves.toBeUndefined();
    });

    it('survives a caches API that rejects', async () => {
      vi.stubGlobal('caches', {
        keys: async () => {
          throw new Error('denied');
        },
      });
      vi.stubGlobal('navigator', {});

      await expect(setup().wipeServiceWorker()).resolves.toBeUndefined();
    });
  });
});
