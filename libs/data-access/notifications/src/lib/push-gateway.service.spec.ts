import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { PushGatewayService } from './push-gateway.service';
import { PUSH_CONFIG, type PushConfig } from './push-config';

const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  platform: 'ios' as string,
  available: true,
  failStorage: false,
  failWrites: false,
  failRemoves: false,
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: h.failStorage
        ? await Promise.reject(new Error('token=do-not-export'))
        : (h.store.get(key) ?? null),
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      if (h.failWrites) throw new Error('token=do-not-export');
      h.store.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      if (h.failRemoves) throw new Error('token=do-not-export');
      h.store.delete(key);
    }),
  },
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => ({})),
  Capacitor: {
    getPlatform: () => h.platform,
    isPluginAvailable: () => h.available,
  },
}));

const KEY = 'trinity.push.gateway';
const NOTIFY = 'https://push.example.org/_matrix/push/v1/notify';
const ENV: PushConfig = {
  gatewayUrl: 'https://built-in.example/_matrix/push/v1/notify',
};

/**
 * Build a fresh service. Resets the TestBed first so a test can call this twice to
 * simulate an app restart — a second instance reading the same persisted store is how
 * the reload cases below check that state actually survives.
 */
function setup(fallback: PushConfig | null = null): PushGatewayService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      PushGatewayService,
      { provide: PUSH_CONFIG, useValue: fallback },
    ],
  });
  return TestBed.inject(PushGatewayService);
}

describe('PushGatewayService', () => {
  beforeEach(() => {
    h.store.clear();
    h.platform = 'ios';
    h.available = true;
    h.failStorage = false;
    h.failWrites = false;
    h.failRemoves = false;
    TestBed.resetTestingModule();
  });

  describe('resolution order', () => {
    it('reports the build default when storage is unavailable', async () => {
      h.failStorage = true;
      const svc = setup(ENV);

      await expect(svc.init()).resolves.toEqual({
        kind: 'defaulted',
        reason: 'storage-unavailable',
      });
      expect(svc.effective()).toBeNull();
    });

    it('is null when neither a build default nor an override exists', async () => {
      const svc = setup(null);
      await svc.init();

      expect(svc.effective()).toBeNull();
      expect(svc.configured()).toBe(false);
    });

    it('keeps a persisted disable fail-closed during a transient read failure', async () => {
      h.store.set(KEY, JSON.stringify({ disabled: true }));
      h.failStorage = true;
      const svc = setup(ENV);

      await svc.init();
      expect(svc.effective()).toBeNull();

      h.failStorage = false;
      await svc.init();
      expect(svc.effective()).toBeNull();
    });

    it('falls back to the build-time config when no override is stored', async () => {
      const svc = setup(ENV);
      await svc.init();

      expect(svc.effective()).toEqual(ENV);
      expect(svc.configured()).toBe(true);
    });

    it('prefers a stored override over the build-time config', async () => {
      h.store.set(KEY, JSON.stringify({ gatewayUrl: NOTIFY }));
      const svc = setup(ENV);
      await svc.init();

      expect(svc.effective()).toEqual({ gatewayUrl: NOTIFY });
    });

    it('enables push on a build that shipped without any gateway', async () => {
      // The point of the feature: environment.push is null in every stock build, so
      // this is the path that takes push from dead to live.
      const svc = setup(null);
      await svc.init();
      await svc.save(NOTIFY);

      expect(svc.configured()).toBe(true);
      expect(svc.effective()?.gatewayUrl).toBe(NOTIFY);
    });
  });

  describe('persistence', () => {
    it('round-trips a saved override through storage', async () => {
      const svc = setup();
      await svc.save(NOTIFY);

      const reloaded = setup();
      await reloaded.init();
      expect(reloaded.effective()).toEqual({
        gatewayUrl: NOTIFY,
      });
    });

    it('stores only the gateway URL', async () => {
      // An empty string would reach `appId()` as `"" ?? DEFAULT` — which keeps the
      // empty string, producing an app id of ".ios".
      const svc = setup();
      await svc.save(NOTIFY);

      expect(svc.effective()).toEqual({ gatewayUrl: NOTIFY });
    });

    it('fails closed on a corrupt blob', async () => {
      h.store.set(KEY, '{not json');
      const svc = setup(ENV);
      await svc.init();

      expect(svc.effective()).toBeNull();
    });

    it('fails closed when a stored URL no longer validates', async () => {
      // Hand-edited, or written by a build with different rules.
      h.store.set(
        KEY,
        JSON.stringify({ gatewayUrl: 'https://host/wrong-path' }),
      );
      const svc = setup(ENV);
      await svc.init();

      expect(svc.effective()).toBeNull();
    });

    it('clear() disables push instead of restoring the build default', async () => {
      const svc = setup(ENV);
      await svc.save(NOTIFY);
      await svc.clear();

      expect(svc.effective()).toBeNull();
      expect(h.store.get(KEY)).toBe(JSON.stringify({ disabled: true }));
    });
  });

  describe('applied-app-id ledger', () => {
    it('is null until a registration reports back', async () => {
      const svc = setup();
      await svc.save(NOTIFY);

      expect(svc.appliedAppId()).toBeNull();
    });

    it('survives a reload so a stale pusher can still be removed', async () => {
      // The whole reason it is persisted: if the app is killed between changing the
      // app id and rewriting the pushers, the id to remove must still be recoverable.
      const svc = setup();
      await svc.save(NOTIFY);
      await svc.markApplied('org.example.gw');

      const reloaded = setup();
      await reloaded.init();
      expect(reloaded.appliedAppId()).toBe('org.example.gw');
    });

    it('is not overwritten by a save, so the old id survives an app-id change', async () => {
      // save() records what the user *wants*; the ledger still describes the pushers
      // actually live on the homeservers. Losing this distinction is what strands a
      // pusher on the previous gateway.
      const svc = setup();
      await svc.save(NOTIFY);
      await svc.markApplied('first.app.id');

      await svc.save(NOTIFY);

      expect(svc.effective()?.gatewayUrl).toBe(NOTIFY);
      expect(svc.appliedAppId()).toBe('first.app.id');
    });

    it('records the id when the gateway is the build-time default, with no override', async () => {
      // The pushers a stock build registers are just as real. While the ledger lived
      // inside the override blob this path recorded nothing, so a later app-id change
      // left the first pusher forwarding room/event metadata to the old gateway forever.
      const svc = setup(ENV);
      await svc.init();
      await svc.markApplied('eu.qwky.trinity');

      expect(svc.appliedAppId()).toBe('eu.qwky.trinity');
      expect(svc.override()).toBeNull(); // and it did not invent an override

      const reloaded = setup(ENV);
      await reloaded.init();
      expect(reloaded.appliedAppId()).toBe('eu.qwky.trinity');
    });

    it('survives clear(), which does not delete the pushers it names', async () => {
      const svc = setup(ENV);
      await svc.save(NOTIFY);
      await svc.markApplied('org.example.gw');

      await svc.clear();

      expect(svc.appliedAppId()).toBe('org.example.gw');
    });

    it('migrates a ledger written into the old override blob', async () => {
      h.store.set(
        KEY,
        JSON.stringify({
          gatewayUrl: NOTIFY,
          appId: 'legacy.custom.id',
          appliedAppId: 'legacy.app.id',
        }),
      );
      const svc = setup();
      await svc.init();

      expect(svc.appliedAppId()).toBe('legacy.app.id');
      expect(svc.legacyAppIds()).toEqual(['legacy.custom.id', 'legacy.app.id']);

      // Rewritten under its own key: dropping the override no longer takes the ledger
      // with it, so the stale pusher is still removable after a reload.
      await svc.clear();
      const reloaded = setup();
      await reloaded.init();
      expect(reloaded.appliedAppId()).toBe('legacy.app.id');
      expect(reloaded.legacyAppIds()).toEqual([
        'legacy.custom.id',
        'legacy.app.id',
      ]);
    });
  });

  describe('per-account registration recovery', () => {
    const state = {
      version: 1 as const,
      identities: [{ appId: 'ovh.qwky.trinity.ios', pushkey: 'opaque-token' }],
    };

    it('round-trips independent account state across a fresh service', async () => {
      const svc = setup();
      await firstValueFrom(svc.saveRegistration('@alice:example.org', state));
      await firstValueFrom(
        svc.saveRegistration('@bob:example.org', {
          version: 1,
          identities: [
            { appId: 'ovh.qwky.trinity.ios', pushkey: 'other-token' },
          ],
        }),
      );

      const reloaded = setup();
      await expect(
        firstValueFrom(reloaded.loadRegistration('@alice:example.org')),
      ).resolves.toEqual(state);
      await expect(
        firstValueFrom(reloaded.loadRegistration('@bob:example.org')),
      ).resolves.toEqual({
        version: 1,
        identities: [{ appId: 'ovh.qwky.trinity.ios', pushkey: 'other-token' }],
      });
      expect(
        h.store.has('trinity.push.registration.%40alice%3Aexample.org'),
      ).toBe(true);
    });

    it('treats an absent account as empty and removes only that account', async () => {
      const svc = setup();
      await firstValueFrom(svc.saveRegistration('@alice:example.org', state));
      await firstValueFrom(svc.saveRegistration('@bob:example.org', state));

      await expect(
        firstValueFrom(svc.loadRegistration('@nobody:example.org')),
      ).resolves.toBeNull();
      await firstValueFrom(svc.saveRegistration('@alice:example.org', null));

      await expect(
        firstValueFrom(svc.loadRegistration('@alice:example.org')),
      ).resolves.toBeNull();
      await expect(
        firstValueFrom(svc.loadRegistration('@bob:example.org')),
      ).resolves.toEqual(state);
    });

    it('fails closed for malformed state and storage reads', async () => {
      h.store.set(
        'trinity.push.registration.%40alice%3Aexample.org',
        JSON.stringify({ version: 1, identities: [{ appId: 'x' }] }),
      );
      const svc = setup();
      await expect(
        firstValueFrom(svc.loadRegistration('@alice:example.org')),
      ).rejects.toThrow('malformed');

      h.failStorage = true;
      await expect(
        firstValueFrom(svc.loadRegistration('@bob:example.org')),
      ).rejects.toThrow();
    });

    it('does not update the gateway signal when durable writes fail', async () => {
      const svc = setup(ENV);
      await svc.init();
      h.failWrites = true;

      await expect(svc.save(NOTIFY)).rejects.toThrow();
      expect(svc.effective()).toEqual(ENV);

      await expect(svc.markApplied('failed.app.id')).rejects.toThrow();
      expect(svc.appliedAppId()).toBeNull();
    });

    it('keeps an explicit disable durable across reload and retries failed cleanup', async () => {
      const svc = setup(ENV);
      await svc.init();
      h.failWrites = true;
      await expect(svc.clear()).rejects.toThrow();
      expect(svc.effective()).toEqual(ENV);

      h.failWrites = false;
      await svc.clear();
      const reloaded = setup(ENV);
      await reloaded.init();
      expect(reloaded.effective()).toBeNull();

      h.failRemoves = true;
      await expect(reloaded.resetToDefault()).rejects.toThrow();
      expect(reloaded.effective()).toBeNull();
    });

    it('blocks mutation while the legacy ownership ledger is corrupt', async () => {
      const legacyKey = 'trinity.push.legacy-app-ids';
      h.store.set(legacyKey, '{not json');
      const svc = setup(ENV);

      await svc.init();
      await expect(svc.save(NOTIFY)).rejects.toThrow(
        'awaiting storage recovery',
      );
      expect(h.store.get(legacyKey)).toBe('{not json');
    });

    it('does not certify account cleanup when disabled startup cannot load ownership', async () => {
      const legacyKey = 'trinity.push.legacy-app-ids';
      h.store.set(KEY, JSON.stringify({ disabled: true }));
      h.store.set(legacyKey, '{not json');
      const svc = setup(ENV);

      await svc.init();
      expect(svc.effective()).toBeNull();
      await expect(
        firstValueFrom(svc.loadRegistration('@alice:example.org')),
      ).rejects.toThrow('awaiting storage recovery');
      await expect(
        firstValueFrom(svc.saveRegistration('@alice:example.org', null)),
      ).rejects.toThrow('awaiting storage recovery');
      expect(h.store.get(KEY)).toBe(JSON.stringify({ disabled: true }));
    });
  });

  describe('platform support', () => {
    it.each(['ios', 'android'])('is supported on %s', async (platform) => {
      h.platform = platform;
      expect(setup().supported()).toBe(true);
    });

    it.each(['web', 'electron'])(
      'is unsupported on %s, where there is no push plugin',
      async (platform) => {
        h.platform = platform;
        expect(setup().supported()).toBe(false);
      },
    );

    it('is unsupported when a mobile browser has no native push plugin', () => {
      h.platform = 'ios';
      h.available = false;
      expect(setup().supported()).toBe(false);
    });
  });
});
