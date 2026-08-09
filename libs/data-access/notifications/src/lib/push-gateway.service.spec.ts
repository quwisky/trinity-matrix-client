import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PushGatewayService } from './push-gateway.service';
import { PUSH_CONFIG, type PushConfig } from './push-config';

const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  platform: 'ios' as string,
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: h.store.get(key) ?? null,
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      h.store.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      h.store.delete(key);
    }),
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => h.platform },
}));

const KEY = 'trinity.push.gateway';
const NOTIFY = 'https://push.example.org/_matrix/push/v1/notify';
const ENV: PushConfig = {
  gatewayUrl: 'https://built-in.example/_matrix/push/v1/notify',
  appId: 'eu.qwky.trinity',
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
    TestBed.resetTestingModule();
  });

  describe('resolution order', () => {
    it('is null when neither a build default nor an override exists', async () => {
      const svc = setup(null);
      await svc.init();

      expect(svc.effective()).toBeNull();
      expect(svc.configured()).toBe(false);
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

      expect(svc.effective()).toEqual({ gatewayUrl: NOTIFY, appId: undefined });
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
      await svc.save(NOTIFY, 'org.example.gw');

      const reloaded = setup();
      await reloaded.init();
      expect(reloaded.effective()).toEqual({
        gatewayUrl: NOTIFY,
        appId: 'org.example.gw',
      });
    });

    it('stores a blank appId as absent, not as an empty string', async () => {
      // An empty string would reach `appId()` as `"" ?? DEFAULT` — which keeps the
      // empty string, producing an app id of ".ios".
      const svc = setup();
      await svc.save(NOTIFY, '   ');

      expect(svc.effective()?.appId).toBeUndefined();
    });

    it('ignores a corrupt blob and falls back', async () => {
      h.store.set(KEY, '{not json');
      const svc = setup(ENV);
      await svc.init();

      expect(svc.effective()).toEqual(ENV);
    });

    it('ignores a stored URL that no longer validates', async () => {
      // Hand-edited, or written by a build with different rules.
      h.store.set(
        KEY,
        JSON.stringify({ gatewayUrl: 'https://host/wrong-path' }),
      );
      const svc = setup(ENV);
      await svc.init();

      expect(svc.effective()).toEqual(ENV);
    });

    it('clear() removes the override so the build default applies again', async () => {
      const svc = setup(ENV);
      await svc.save(NOTIFY);
      await svc.clear();

      expect(svc.effective()).toEqual(ENV);
      expect(h.store.has(KEY)).toBe(false);
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
      await svc.save(NOTIFY, 'org.example.gw');
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
      await svc.save(NOTIFY, 'first.app.id');
      await svc.markApplied('first.app.id');

      await svc.save(NOTIFY, 'second.app.id');

      expect(svc.effective()?.appId).toBe('second.app.id');
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
      await svc.save(NOTIFY, 'org.example.gw');
      await svc.markApplied('org.example.gw');

      await svc.clear();

      expect(svc.appliedAppId()).toBe('org.example.gw');
    });

    it('migrates a ledger written into the old override blob', async () => {
      h.store.set(
        KEY,
        JSON.stringify({ gatewayUrl: NOTIFY, appliedAppId: 'legacy.app.id' }),
      );
      const svc = setup();
      await svc.init();

      expect(svc.appliedAppId()).toBe('legacy.app.id');

      // Rewritten under its own key: dropping the override no longer takes the ledger
      // with it, so the stale pusher is still removable after a reload.
      await svc.clear();
      const reloaded = setup();
      await reloaded.init();
      expect(reloaded.appliedAppId()).toBe('legacy.app.id');
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
  });
});
