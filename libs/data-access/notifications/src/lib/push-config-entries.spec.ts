import { TestBed } from '@angular/core/testing';
import { AppConfigService, exportedKeysFor } from '@trinity/platform-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { providePushConfigEntries } from './push-config-entries';
import { PushGatewayService } from './push-gateway.service';

const h = vi.hoisted(() => ({ store: new Map<string, string>() }));

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
  Capacitor: { getPlatform: () => 'ios' },
}));

const NOTIFY = 'https://push.example.org/_matrix/push/v1/notify';

function setup(): { config: AppConfigService; push: PushGatewayService } {
  TestBed.configureTestingModule({
    providers: [providePushConfigEntries()],
  });
  return {
    config: TestBed.inject(AppConfigService),
    push: TestBed.inject(PushGatewayService),
  };
}

describe('push config entries', () => {
  beforeEach(() => {
    h.store.clear();
    TestBed.resetTestingModule();
  });

  it('registers an entry for every key the ledger says this lib exports', () => {
    const keys = setup().config.entries.map((entry) => entry.key);

    expect(keys).toEqual([...exportedKeysFor('data-access/notifications')]);
  });

  it('exports no gateway when the build-time default applies', () => {
    expect(setup().config.settings()).toEqual({ push: { gateway: null } });
  });

  it('exports the override as one value, app id and all', async () => {
    const { config, push } = setup();

    await push.save(NOTIFY, 'eu.qwky.trinity');

    expect(config.settings()).toEqual({
      push: { gateway: { gatewayUrl: NOTIFY, appId: 'eu.qwky.trinity' } },
    });
  });

  it('says the app id is absent rather than dropping the field', async () => {
    const { config, push } = setup();

    await push.save(NOTIFY);

    expect(config.settings()).toEqual({
      push: { gateway: { gatewayUrl: NOTIFY, appId: null } },
    });
  });

  it('resets to the build-time default, leaving the applied-id ledger alone', async () => {
    const { config, push } = setup();
    await push.save(NOTIFY, 'eu.qwky.trinity');
    await push.markApplied('eu.qwky.trinity');

    await new Promise<void>((resolve, reject) =>
      config.resetToDefaults().subscribe({ complete: resolve, error: reject }),
    );

    expect(push.override()).toBeNull();
    // The ledger names pushers that are live on the homeserver right now; wiping it here
    // would strand them on the old gateway with nothing recording where they went.
    expect(push.appliedAppId()).toBe('eu.qwky.trinity');
    expect(h.store.get('trinity.push.applied-app-id')).toBe('eu.qwky.trinity');
  });
});
