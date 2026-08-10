import { TestBed } from '@angular/core/testing';
import { AppConfigService, exportedKeysFor } from '@trinity/platform-native';
import { MockProvider } from 'ng-mocks';
import { defer, of, type Observable } from 'rxjs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { providePushConfigEntries } from './push-config-entries';
import { PushGatewayService } from './push-gateway.service';
import { PushService } from './push.service';

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

/**
 * Stands in for {@link PushService.unregister}. Reassign it before {@link setup} to control
 * when the teardown settles — {@link setup} hands the current value to the mock.
 */
let unregisterSpy: Mock<() => Observable<void>>;

function setup(): { config: AppConfigService; push: PushGatewayService } {
  TestBed.configureTestingModule({
    providers: [
      providePushConfigEntries(),
      MockProvider(PushService, { unregister: unregisterSpy }),
    ],
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
    unregisterSpy = vi.fn(() => of(undefined));
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

  it('tears the pushers down before it clears the stored gateway', async () => {
    let torndown!: () => void;
    const teardown = new Promise<void>((resolve) => (torndown = resolve));
    unregisterSpy = vi.fn(() => defer(async () => await teardown));
    const { config, push } = setup();
    await push.save(NOTIFY, 'eu.qwky.trinity');
    await push.markApplied('eu.qwky.trinity');
    const clearSpy = vi.spyOn(push, 'clear');

    const reset = new Promise<void>((resolve, reject) =>
      config.resetToDefaults().subscribe({ complete: resolve, error: reject }),
    );

    // Clearing the gateway drops the applied-app-id ledger that unregister() reads to know
    // which pushers to remove, so the teardown must be finished, not merely started, before
    // the gateway goes. Otherwise the homeserver keeps delivering metadata to a gateway the
    // user just disowned — and with no override left, canPush() is false and nothing ever
    // removes them.
    expect(unregisterSpy).toHaveBeenCalled();
    // A macrotask, so everything already resolvable has settled: a single microtask would
    // not reach a `clear()` awaited behind the teardown, and the assertion would hold for
    // the wrong reason.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clearSpy).not.toHaveBeenCalled();

    torndown();
    await reset;

    expect(clearSpy).toHaveBeenCalled();
    expect(push.override()).toBeNull();
  });
});
