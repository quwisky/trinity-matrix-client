import { TestBed } from '@angular/core/testing';
import {
  AppConfigService,
  configSchemaDrift,
  exportedKeysFor,
} from '@trinity/platform-native';
import { MockProvider } from 'ng-mocks';
import { defer, of, type Observable } from 'rxjs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { providePushConfigEntries } from './push-config-entries';
import { PushGatewayService } from './push-gateway.service';
import { PushService } from './push.service';
import { PUSH_CONFIG, type PushConfig } from './push-config';

const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  /** The platform the service reads at construction; a test can move it before `setup()`. */
  platform: 'ios',
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
  registerPlugin: vi.fn(() => ({})),
  Capacitor: {
    getPlatform: () => h.platform,
    isPluginAvailable: () => h.platform === 'ios' || h.platform === 'android',
  },
}));

const NOTIFY = 'https://push.example.org/_matrix/push/v1/notify';
const BUILD: PushConfig = {
  gatewayUrl: 'https://built-in.example/_matrix/push/v1/notify',
};

/**
 * Stands in for {@link PushService.unregister}. Reassign it before {@link setup} to control
 * when the teardown settles — {@link setup} hands the current value to the mock.
 */
let unregisterSpy: Mock<() => Observable<void>>;

function setup(fallback: PushConfig | null = null): {
  config: AppConfigService;
  push: PushGatewayService;
} {
  TestBed.configureTestingModule({
    providers: [
      providePushConfigEntries(),
      { provide: PUSH_CONFIG, useValue: fallback },
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
    h.platform = 'ios';
    TestBed.resetTestingModule();
    unregisterSpy = vi.fn(() => of(undefined));
  });

  it('registers an entry for every key the ledger says this lib exports', () => {
    const keys = setup().config.entries.map((entry) => entry.key);

    expect(keys).toEqual([...exportedKeysFor('data-access/notifications')]);
  });

  it('describes each of its settings the way the schema publishes it', () => {
    // The runtime half of the drift guard, over this lib's contribution: its Nx boundary
    // stops any other project from checking these, so a setting added here fails here.
    expect(configSchemaDrift(setup().config.entries)).toEqual([]);
  });

  it('exports no gateway when the build-time default applies', () => {
    expect(setup().config.settings()).toEqual({ push: { gateway: null } });
  });

  it('exports disabled distinctly from null and restores the build default', async () => {
    const { config, push } = setup(BUILD);

    await push.clear();
    expect(config.settings()).toEqual({
      push: { gateway: { disabled: true } },
    });

    await push.resetToDefault();
    expect(config.settings()).toEqual({ push: { gateway: null } });
    expect(push.effective()).toEqual(BUILD);
  });

  it('exports the override URL', async () => {
    const { config, push } = setup();

    await push.save(NOTIFY);

    expect(config.settings()).toEqual({
      push: { gateway: { gatewayUrl: NOTIFY } },
    });
  });

  it('exports the URL without a legacy app id field', async () => {
    const { config, push } = setup();

    await push.save(NOTIFY);

    expect(config.settings()).toEqual({
      push: { gateway: { gatewayUrl: NOTIFY } },
    });
  });

  describe('applying a document', () => {
    const envelope = (gateway: unknown) => ({
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: { push: { gateway } },
    });

    it('refuses a URL the homeserver would refuse, naming the path', () => {
      const { config } = setup();

      const plan = config.validate(
        envelope({ gatewayUrl: 'https://push.example.org/hooks' }),
      );

      expect(plan.ok).toBe(false);
      expect(plan.ok === false && plan.problems[0]).toContain('push.gateway:');
      expect(plan.ok === false && plan.problems[0]).toContain(
        '/_matrix/push/v1/notify',
      );
    });

    it('refuses a gateway that is not a gateway at all', () => {
      const { config } = setup();

      expect(config.validate(envelope('https://push.example.org')).ok).toBe(
        false,
      );
      expect(config.validate(envelope({ gatewayUrl: 7 })).ok).toBe(false);
      expect(config.validate(envelope({ gatewayUrl: NOTIFY })).ok).toBe(true);
    });

    it('normalises a bare origin, and says that is what will be stored', async () => {
      const { config, push } = setup();
      const plan = config.validate(
        envelope({ gatewayUrl: 'https://push.example.org' }),
      );
      if (!plan.ok) {
        throw new Error(plan.problems.join(' / '));
      }

      expect(plan.changes).toEqual([
        {
          path: 'push.gateway',
          from: null,
          to: { gatewayUrl: NOTIFY },
        },
      ]);
      await new Promise<void>((resolve, reject) =>
        config.apply(plan).subscribe({ complete: resolve, error: reject }),
      );

      expect(push.override()).toEqual({ gatewayUrl: NOTIFY });
    });

    it('drops the override when the document says there is none', async () => {
      const { config, push } = setup();
      await push.save(NOTIFY);
      const plan = config.validate(envelope(null));
      if (!plan.ok) {
        throw new Error(plan.problems.join(' / '));
      }

      await new Promise<void>((resolve, reject) =>
        config.apply(plan).subscribe({ complete: resolve, error: reject }),
      );

      expect(push.override()).toBeNull();
    });

    it('warns that an http gateway sends metadata in the clear, and applies it anyway', () => {
      const { config } = setup();

      const plan = config.validate(
        envelope({ gatewayUrl: 'http://push.local/_matrix/push/v1/notify' }),
      );

      expect(plan.ok).toBe(true);
      expect(plan.warnings[0]).toContain('push.gateway:');
      expect(plan.warnings[0]).toContain('plain http');
    });

    it('names a gateway that cannot do anything on this platform, and keeps it', async () => {
      // A config written on a phone, applied on the desktop: warn and proceed, rather than
      // silently dropping a setting the user can see in their own file.
      h.platform = 'web';
      const { config, push } = setup();

      const plan = config.validate(envelope({ gatewayUrl: NOTIFY }));

      expect(plan.ok).toBe(true);
      expect(plan.warnings[0]).toContain('only delivered on iOS and Android');
      if (!plan.ok) {
        throw new Error(plan.problems.join(' / '));
      }
      await new Promise<void>((resolve, reject) =>
        config.apply(plan).subscribe({ complete: resolve, error: reject }),
      );

      expect(push.override()?.gatewayUrl).toBe(NOTIFY);
    });
  });

  it('resets to the build-time default, leaving the applied-id ledger alone', async () => {
    const { config, push } = setup();
    await push.save(NOTIFY);
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
    await push.save(NOTIFY);
    await push.markApplied('eu.qwky.trinity');
    const resetSpy = vi.spyOn(push, 'resetToDefault');

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
    expect(resetSpy).not.toHaveBeenCalled();

    torndown();
    await reset;

    expect(resetSpy).toHaveBeenCalled();
    expect(push.override()).toBeNull();
  });
});
