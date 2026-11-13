import { TestBed } from '@angular/core/testing';
import { HostUserPresenceService } from '@trinity/runtime/host';
import { MockProvider } from 'ng-mocks';
import { EMPTY, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    clear: async () => {
      prefs.clear();
    },
    keys: async () => ({ keys: [...prefs.keys()] }),
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { rmdir: vi.fn(), stat: vi.fn() },
  Directory: { Cache: 'CACHE' },
}));

import { Capacitor } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';
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

function setup() {
  TestBed.configureTestingModule({
    providers: [LocalDataWipeService, MockProvider(SecureStorageService)],
  });
  return TestBed.inject(LocalDataWipeService);
}

describe('LocalDataWipeService', () => {
  beforeEach(() => prefs.clear());

  afterEach(() => vi.unstubAllGlobals());

  describe('beginIndexedDbWipe', () => {
    it('deletes the sync store under its REAL name, not the one the app passes', async () => {
      // matrix-js-sdk prepends `matrix-js-sdk:` to the dbName it is given, so deleting
      // `trinity-sync:@alice:hs` would silently delete nothing and the "cleared" claim
      // would be a lie. Nothing else in the app observes the difference.
      const { factory, deleted } = fakeIdb();
      vi.stubGlobal('indexedDB', factory);

      await setup().beginIndexedDbWipe([ALICE]).observation;

      expect(deleted).toContain('matrix-js-sdk:trinity-sync:@alice:hs');
      expect(deleted).not.toContain('trinity-sync:@alice:hs');
    });

    it('deletes both crypto databases for the account and the SDK-default pair', async () => {
      const { factory, deleted } = fakeIdb();
      vi.stubGlobal('indexedDB', factory);

      await setup().beginIndexedDbWipe([ALICE]).observation;

      expect(deleted).toContain(
        'trinity-crypto:@alice:hs:DEV1::matrix-sdk-crypto',
      );
      expect(deleted).toContain(
        'trinity-crypto:@alice:hs:DEV1::matrix-sdk-crypto-meta',
      );
      // A migrated pre-multi-account session sits on the default prefix, which no
      // account record names.
      expect(deleted).toContain('matrix-js-sdk::matrix-sdk-crypto');
      expect(deleted).toContain('matrix-js-sdk::matrix-sdk-crypto-meta');
    });

    it('still deletes the derived names when the browser cannot enumerate (Firefox)', async () => {
      const { factory, deleted } = fakeIdb(); // no `databases` member
      vi.stubGlobal('indexedDB', factory);

      const report = await setup().beginIndexedDbWipe([ALICE]).observation;

      expect(report.enumerated).toBe(false);
      expect(deleted).toContain('matrix-js-sdk:trinity-sync:@alice:hs');
    });

    it('deletes the web wrapping keys of the crypto store keys, even without enumeration', async () => {
      const { factory, deleted } = fakeIdb(); // no `databases` member
      vi.stubGlobal('indexedDB', factory);

      await setup().beginIndexedDbWipe([ALICE]).observation;

      expect(deleted).toContain('trinity-crypto-store-keys');
    });

    it('deletes the retired diagnostic log even where the browser cannot enumerate', async () => {
      // It may hold identifiers of the accounts this reset removes. Firefox has no
      // indexedDB.databases(), so only an explicit name reaches it there.
      const { factory, deleted } = fakeIdb(); // no `databases` member
      vi.stubGlobal('indexedDB', factory);

      await setup().beginIndexedDbWipe([ALICE]).observation;

      expect(deleted).toContain('trinity-diagnostic-log');
    });

    it('deletes the mention index even where the browser cannot enumerate', async () => {
      const { factory, deleted } = fakeIdb(); // no `databases` member
      vi.stubGlobal('indexedDB', factory);

      await setup().beginIndexedDbWipe([ALICE]).observation;

      expect(deleted).toContain('trinity-mention-index');
    });

    it('deletes an orphan no account record names, when enumeration is available', async () => {
      const { factory, deleted } = fakeIdb([
        'matrix-js-sdk:trinity-sync:@ghost:hs',
      ]);
      vi.stubGlobal('indexedDB', factory);

      const report = await setup().beginIndexedDbWipe([ALICE]).observation;

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

      const report = await setup().beginIndexedDbWipe([ALICE]).observation;

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

      const report = await setup().beginIndexedDbWipe([ALICE]).observation;

      expect(report.failed).toContain('matrix-js-sdk:trinity-sync:@alice:hs');
      expect(report.blocked).toEqual([]);
    });

    it('is a no-op off-browser rather than throwing', async () => {
      vi.stubGlobal('indexedDB', undefined);

      await expect(
        setup().beginIndexedDbWipe([ALICE]).observation,
      ).resolves.toEqual({
        blocked: [],
        failed: [],
        enumerated: false,
      });
    });
  });

  describe('wipePreferences', () => {
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

      await expect(setup().wipePreferences()).resolves.toBe(true);

      expect(prefs.size).toBe(0);
    });

    it('can leave the account registry, and only that, for an erase that still needs its names', async () => {
      prefs.set('trinity.app-lock', 'on');
      prefs.set('matrix.accounts', '{"accounts":[]}');
      prefs.set('secure.matrix.accessToken:@alice:hs', 'leftover');

      await expect(setup().wipePreferences(true)).resolves.toBe(true);

      expect([...prefs.keys()]).toEqual(['matrix.accounts']);
    });

    it('reports a Preferences backend that rejects', async () => {
      const { Preferences } = await import('@capacitor/preferences');
      vi.spyOn(Preferences, 'clear').mockRejectedValueOnce(
        new Error('storage disabled'),
      );

      await expect(setup().wipePreferences()).resolves.toBe(false);
    });
  });

  describe('wipeWebStorage', () => {
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

      await expect(setup().wipeWebStorage()).resolves.toBe(true);

      expect(session.clear).toHaveBeenCalled();
      expect(local.clear).toHaveBeenCalled();
    });

    it('can leave the account registry, and only that, in local storage', async () => {
      // Where the registry is held back, Preferences is this local storage.
      localStorage.setItem('CapacitorStorage.matrix.accounts', '{}');
      localStorage.setItem('CapacitorStorage.trinity.app-lock', 'on');
      localStorage.setItem('unprefixed', 'x');
      sessionStorage.setItem('oidc.codeVerifier', 'SECRET');

      await expect(setup().wipeWebStorage(true)).resolves.toBe(true);

      expect(Object.keys(localStorage)).toEqual([
        'CapacitorStorage.matrix.accounts',
      ]);
      expect(sessionStorage.length).toBe(0);
      localStorage.clear();
    });

    it('reports a context where touching web storage throws', async () => {
      // Safari with storage blocked throws on property access alone.
      vi.stubGlobal('localStorage', {
        get clear(): never {
          throw new Error('SecurityError');
        },
      });

      await expect(setup().wipeWebStorage()).resolves.toBe(false);
    });
  });

  describe('wipeSecureStorage', () => {
    afterEach(() => TestBed.resetTestingModule());

    function withPresence(
      clearPin: HostUserPresenceService['clearPin'],
      clearAll: () => Promise<boolean> = vi.fn(async () => true),
    ): LocalDataWipeService {
      TestBed.configureTestingModule({
        providers: [
          LocalDataWipeService,
          MockProvider(SecureStorageService, { clearAll }),
          MockProvider(HostUserPresenceService, { clearPin }),
        ],
      });
      return TestBed.inject(LocalDataWipeService);
    }

    it('asks the secure backend to sweep itself', async () => {
      // Secondary to the caller's per-key removals, but the only thing that reaches a
      // secret whose account is no longer in the registry.
      const clearAll = vi.fn(async () => true);
      const clearPin = () => of({ kind: 'completed' as const });

      await withPresence(clearPin, clearAll).wipeSecureStorage();

      expect(clearAll).toHaveBeenCalledOnce();
    });

    it('clears the Trinity PIN with the other secrets', async () => {
      const clearPin = vi.fn(() => of({ kind: 'completed' as const }));
      await expect(withPresence(clearPin).wipeSecureStorage()).resolves.toBe(
        true,
      );
      expect(clearPin).toHaveBeenCalledOnce();
    });

    it('reports the secrets wipe as failed when the PIN could not be cleared', async () => {
      const clearPin = () =>
        of({
          kind: 'rejected' as const,
          diagnostic: { code: 'pin-clear-failed' },
        });
      await expect(withPresence(clearPin).wipeSecureStorage()).resolves.toBe(
        false,
      );
    });

    it('reports a PIN clear that errors or completes without an answer as failed', async () => {
      await expect(
        withPresence(() =>
          throwError(() => new Error('bridge gone')),
        ).wipeSecureStorage(),
      ).resolves.toBe(false);
      TestBed.resetTestingModule();
      await expect(
        withPresence(() => {
          throw new Error('adapter threw');
        }).wipeSecureStorage(),
      ).resolves.toBe(false);
      TestBed.resetTestingModule();
      await expect(withPresence(() => EMPTY).wipeSecureStorage()).resolves.toBe(
        false,
      );
    });

    it('treats a host without a PIN as nothing to clear', async () => {
      const clearPin = () =>
        of({ kind: 'unavailable' as const, reason: 'not-supported' as const });
      await expect(withPresence(clearPin).wipeSecureStorage()).resolves.toBe(
        true,
      );
    });

    it('still clears the PIN when the secret sweep fails', async () => {
      const clearPin = vi.fn(() => of({ kind: 'completed' as const }));
      await expect(
        withPresence(
          clearPin,
          vi.fn(async () => {
            throw new Error('keychain unavailable');
          }),
        ).wipeSecureStorage(),
      ).resolves.toBe(false);
      expect(clearPin).toHaveBeenCalledOnce();
    });
  });

  describe('wipeSharedFiles', () => {
    // The real FileSaveService on a native host: only the Filesystem plugin is faked.
    beforeEach(() => {
      vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
      vi.spyOn(Capacitor, 'isPluginAvailable').mockReturnValue(true);
      vi.mocked(Filesystem.rmdir).mockReset().mockResolvedValue();
      vi.mocked(Filesystem.stat)
        .mockReset()
        .mockRejectedValue(new Error('missing'));
    });

    afterEach(() => vi.restoreAllMocks());

    it('deletes the decrypted attachments left for the share sheet', async () => {
      await expect(setup().wipeSharedFiles()).resolves.toBe(true);
      expect(Filesystem.rmdir).toHaveBeenCalledExactlyOnceWith({
        path: 'trinity-shared',
        directory: 'CACHE',
        recursive: true,
      });
    });

    it('counts a folder that never existed as deleted', async () => {
      vi.mocked(Filesystem.rmdir).mockRejectedValue(
        new Error('Folder does not exist.'),
      );

      await expect(setup().wipeSharedFiles()).resolves.toBe(true);
    });

    it('reports the attachments still on disk when the delete fails', async () => {
      vi.mocked(Filesystem.rmdir).mockRejectedValue(
        new Error('Unable to delete directory'),
      );
      vi.mocked(Filesystem.stat).mockResolvedValue({
        type: 'directory',
      } as never);

      await expect(setup().wipeSharedFiles()).resolves.toBe(false);
    });
  });

  describe('wipeCacheStorage and wipeServiceWorkerRegistrations', () => {
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
      const svc = setup();

      await expect(svc.wipeCacheStorage()).resolves.toBe(true);
      await expect(svc.wipeServiceWorkerRegistrations()).resolves.toBe(true);

      expect(del).toHaveBeenCalledWith('ngsw:a');
      expect(del).toHaveBeenCalledWith('other');
      expect(unregister).toHaveBeenCalled();
    });

    it('is a no-op where neither API exists (native, Electron, older browsers)', async () => {
      vi.stubGlobal('caches', undefined);
      vi.stubGlobal('navigator', {});
      const svc = setup();

      await expect(svc.wipeCacheStorage()).resolves.toBe(true);
      await expect(svc.wipeServiceWorkerRegistrations()).resolves.toBe(true);
    });

    it('reports a caches API that rejects', async () => {
      vi.stubGlobal('caches', {
        keys: async () => {
          throw new Error('denied');
        },
      });
      vi.stubGlobal('navigator', {});
      const svc = setup();

      await expect(svc.wipeCacheStorage()).resolves.toBe(false);
      await expect(svc.wipeServiceWorkerRegistrations()).resolves.toBe(true);
    });
  });
});
