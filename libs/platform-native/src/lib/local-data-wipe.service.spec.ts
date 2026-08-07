import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory @capacitor/preferences, hoisted so the vi.mock factory can see it. `calls`
// records the phase order, which one test below asserts.
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

    it('reports a database that errored separately from a blocked one', async () => {
      // `blocked` and `failed` mean different things to the caller — blocked is "not yet,
      // probably a moment later", failed is "this one did not go". They are accumulated by
      // two sibling branches over the same result, and the branch that matters is the one
      // that drops the name entirely: the wipe then reports a clean run over a database
      // that is still there. (Misfiling it as `blocked` is merely wrong, not silent.)
      const factory = {
        deleteDatabase: () => {
          const request: Record<string, (() => void) | null> = {};
          queueMicrotask(() => request['onerror']?.());
          return request as unknown as IDBOpenDBRequest;
        },
      } as unknown as IDBFactory;
      vi.stubGlobal('indexedDB', factory);

      const report = await setup().wipeIndexedDb([ALICE]);

      expect(report.failed).toContain('matrix-js-sdk:trinity-sync:@alice:hs');
      expect(report.blocked).toEqual([]);
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

    it('sweeps secure storage before clearing Preferences', async () => {
      // Order matters on web, where the secure backend's keys ARE Preferences entries
      // under a `secure.` prefix: clearing the group first would leave the sweep with
      // nothing to find, and silently turn a two-mechanism wipe into a one-mechanism one.
      await setup(true).wipeKeyValueStores();

      expect(calls).toEqual(['secure.clearAll', 'preferences.clear']);
    });

    it('asks the secure backend to sweep itself as well', async () => {
      // Secondary to the caller's per-key removals, but the only thing that reaches a
      // secret whose account is no longer in the registry.
      const svc = setup(true);
      const secure = TestBed.inject(SecureStorageService);

      await svc.wipeKeyValueStores();

      expect(secure.clearAll).toHaveBeenCalled();
    });

    it('clears raw web storage unconditionally, with no platform branch', async () => {
      // There is deliberately no `isNativePlatform()` check left to flip: the OIDC callback
      // re-seeds the sign-in state into sessionStorage ON NATIVE, so a branch that skipped
      // it there stranded a PKCE code_verifier — the one actual secret in this surface.
      // Re-introducing any such guard has to fail something, so this asserts the calls
      // happen with no platform stub in play at all.
      const local = { clear: vi.fn() };
      const session = { clear: vi.fn() };
      vi.stubGlobal('localStorage', local);
      vi.stubGlobal('sessionStorage', session);

      await setup().wipeKeyValueStores();

      expect(session.clear).toHaveBeenCalled();
      expect(local.clear).toHaveBeenCalled();
    });

    it('survives a Preferences backend that rejects', async () => {
      // Two layers guard this — here, and `swallow()` in FactoryResetService — and only
      // the outer one was pinned, so removing this inner guard failed nothing. Both matter:
      // this method's own contract is that it does not throw, and a caller that forgets the
      // outer guard should not be able to strand the reset.
      const { Preferences } = await import('@capacitor/preferences');
      vi.spyOn(Preferences, 'clear').mockRejectedValueOnce(
        new Error('storage disabled'),
      );

      await expect(setup().wipeKeyValueStores()).resolves.toBeUndefined();
    });

    it('survives a context where touching web storage throws', async () => {
      // Safari with storage blocked throws on property access alone.
      vi.stubGlobal('localStorage', {
        get clear(): never {
          throw new Error('SecurityError');
        },
      });

      await expect(setup().wipeKeyValueStores()).resolves.toBeUndefined();
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
