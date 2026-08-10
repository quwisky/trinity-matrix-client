import { TestBed } from '@angular/core/testing';
import { Preferences } from '@capacitor/preferences';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfigService } from './app-config.service';
import {
  exportedKeysFor,
  provideConfigEntries,
  type ConfigDocument,
  type ConfigEntry,
  type ConfigSettings,
  type ConfigValue,
} from './config-schema';
import { DraftStoreService } from './draft-store.service';
import { providePlatformConfigEntries } from './platform-config-entries';
import { PrivacySettingsService } from './privacy-settings.service';
import { KeyboardShortcutsService } from './shortcuts/keyboard-shortcuts.service';
import { ThemeService } from './theme.service';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

const set = vi.mocked(Preferences.set);

/** The app's wiring: the platform entries registered, as `main.ts` does it. */
function setup(): AppConfigService {
  TestBed.configureTestingModule({
    providers: [providePlatformConfigEntries()],
  });
  return TestBed.inject(AppConfigService);
}

function isRecord(
  value: ConfigValue,
): value is { readonly [key: string]: ConfigValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walk the exported settings tree to one dotted path. */
function at(settings: ConfigSettings, path: string): ConfigValue {
  let node: ConfigValue = settings;
  for (const segment of path.split('.')) {
    if (!isRecord(node)) {
      return null;
    }
    node = node[segment];
  }
  return node;
}

/** A registry built from hand-written entries, one group per contributing library. */
function setupWith(
  ...groups: readonly (readonly ConfigEntry[])[]
): AppConfigService {
  TestBed.configureTestingModule({
    providers: groups.map((group) => provideConfigEntries(() => group)),
  });
  return TestBed.inject(AppConfigService);
}

/** The smallest entry that reads and resets something. */
function entry(
  path: string,
  overrides: Partial<ConfigEntry> = {},
): ConfigEntry {
  return {
    path,
    key: `trinity.${path}`,
    read: () => null,
    reset: () => undefined,
    ...overrides,
  };
}

/**
 * Let every already-resolvable promise settle. A macrotask, not `await Promise.resolve()`:
 * one microtask does not reach the end of the subscribe → complete → `then` chain, so the
 * shorter wait would make the assertions below pass against a reset that never awaited.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Run a cold action to completion. */
function run(action: ReturnType<AppConfigService['resetToDefaults']>) {
  return new Promise<void>((resolve, reject) =>
    action.subscribe({ complete: resolve, error: reject }),
  );
}

describe('AppConfigService', () => {
  beforeEach(() => {
    vi.mocked(Preferences.get).mockReset().mockResolvedValue({ value: null });
    set.mockReset().mockResolvedValue(undefined);
    vi.mocked(Preferences.remove).mockReset().mockResolvedValue(undefined);
  });

  describe('the registry', () => {
    it('is empty, not broken, with no app wiring', () => {
      const config = TestBed.configureTestingModule({}).inject(
        AppConfigService,
      );

      expect(config.entries).toEqual([]);
      expect(config.export().settings).toEqual({});
    });

    it('registers an entry for every key the ledger says this lib exports', () => {
      const keys = new Set(setup().entries.map((entry) => entry.key));

      expect([...keys].sort()).toEqual(
        [...exportedKeysFor('platform-native')].sort(),
      );
    });

    it('gives each setting its own path, sorted so two exports diff cleanly', () => {
      const paths = setup().entries.map(({ path }) => path);

      expect(new Set(paths).size).toBe(paths.length);
      expect(paths).toEqual([...paths].sort());
    });

    it('refuses a registry where one path is a prefix of another', () => {
      // The collision that silently drops a setting: sorted, the string leaf is written
      // first and the branch built for the longer path overwrites it. Across two libs, so
      // no per-library uniqueness check could have caught it.
      expect(() =>
        setupWith([entry('push.gateway')], [entry('push.gateway.url')]),
      ).toThrow(/'push\.gateway' is a prefix of 'push\.gateway\.url'/u);
    });

    it('refuses two entries claiming the same path', () => {
      expect(() =>
        setupWith([entry('theme.palette')], [entry('theme.palette')]),
      ).toThrow(/claim the path 'theme\.palette'/u);
    });

    it('orders keys by code point rather than by the device locale', () => {
      // `localeCompare` sorts these the other way round in an en locale, and differently
      // again under another ICU version — key order in a committed document must not
      // depend on the machine that wrote it.
      const config = setupWith([
        entry('theme.palette'),
        entry('theme.Palette'),
      ]);

      expect(config.entries.map(({ path }) => path)).toEqual([
        'theme.Palette',
        'theme.palette',
      ]);
    });
  });

  describe('export', () => {
    it('nests the values under their owner rather than dumping raw keys', () => {
      const config = setup();
      TestBed.inject(ThemeService).setPalette('amethyst');

      const { settings } = config.export();

      expect(at(settings, 'theme.palette')).toBe('amethyst');
      expect(at(settings, 'privacy.sendReadReceipts')).toBe(true);
      expect(at(settings, 'flags.virtualTimeline')).toBe(true);
      // The stored key must not leak into the document — the path IS the format.
      expect(JSON.stringify(settings)).not.toContain('trinity.palette');
    });

    it('wraps the settings in a versioned, timestamped envelope', () => {
      const document = setup().export();

      expect(document.version).toBe(1);
      expect(new Date(document.exportedAt).toISOString()).toBe(
        document.exportedAt,
      );
      expect(Object.keys(document)).toEqual([
        'version',
        'exportedAt',
        'settings',
      ]);
    });

    it('pretty-prints to JSON that parses back to the same settings', () => {
      const config = setup();

      const parsed = JSON.parse(config.exportJson()) as ConfigDocument;

      expect(config.exportJson()).toContain('\n  "version": 1');
      expect(parsed.settings).toEqual(config.settings());
    });

    it('tracks the live services rather than a snapshot taken at startup', () => {
      const config = setup();
      const privacy = TestBed.inject(PrivacySettingsService);
      expect(at(config.settings(), 'privacy.linkPreviews')).toBe(true);

      privacy.setLinkPreviews(false);

      expect(at(config.settings(), 'privacy.linkPreviews')).toBe(false);
    });

    it('carries only the shortcuts the user actually rebound', () => {
      const config = setup();
      const shortcuts = TestBed.inject(KeyboardShortcutsService);
      expect(at(config.settings(), 'shortcuts.overrides')).toEqual({});

      shortcuts.rebind('switcher.open', {
        accel: true,
        alt: false,
        shift: false,
        key: 'j',
      });

      expect(at(config.settings(), 'shortcuts.overrides')).toEqual({
        'switcher.open': { accel: true, alt: false, shift: false, key: 'j' },
      });
    });

    it('leaves unsent drafts out of a document meant to be shared', () => {
      const config = setup();
      TestBed.inject(DraftStoreService).set('!room:hs', 'half-typed secret');

      expect(config.exportJson()).not.toContain('half-typed secret');
      expect(config.exportJson()).not.toContain('drafts');
    });
  });

  describe('reset to defaults', () => {
    it('does nothing until it is subscribed', () => {
      const config = setup();
      const theme = TestBed.inject(ThemeService);
      theme.setPalette('amethyst');

      config.resetToDefaults();

      expect(theme.palette()).toBe('amethyst');
    });

    it('restores every exported setting through its owning service', async () => {
      const config = setup();
      const theme = TestBed.inject(ThemeService);
      const privacy = TestBed.inject(PrivacySettingsService);
      theme.setPalette('amethyst');
      theme.setTextScale('larger');
      privacy.setSendReadReceipts(false);

      await run(config.resetToDefaults());

      expect(theme.palette()).toBe('trinity');
      expect(theme.textScale()).toBe('default');
      expect(privacy.sendReadReceipts()).toBe(true);
      // Through the setter, so storage agrees with the signal without a reload.
      expect(set).toHaveBeenCalledWith({
        key: 'trinity.palette',
        value: 'trinity',
      });
    });

    it('never touches a key it does not export', async () => {
      const config = setup();
      const drafts = TestBed.inject(DraftStoreService);
      drafts.set('!room:hs', 'half-typed secret');
      set.mockClear();

      await run(config.resetToDefaults());

      const written = set.mock.calls.map(([options]) => options.key);
      expect(written).not.toContain('trinity.composer.drafts');
      expect(written).not.toContain('trinity.accounts.mixed');
      expect(drafts.get('!room:hs')).toBe('half-typed secret');
    });

    it('completes only once every asynchronous reset has settled', async () => {
      // What a caller is entitled to assume: when this completes, nothing is still being
      // undone. The Advanced section closes its confirmation and re-reads the document on
      // completion, and PR 2's import runs after a reset — both would read a half-reset app
      // if completion raced the slowest setter.
      let settle!: () => void;
      const pending = new Promise<void>((resolve) => (settle = resolve));
      const slow = vi.fn(async () => await pending);
      const config = setupWith([entry('slow.setting', { reset: slow })]);
      let completed = false;

      const reset = run(config.resetToDefaults()).then(() => {
        completed = true;
      });
      await flush();

      expect(slow).toHaveBeenCalled();
      expect(completed).toBe(false);

      settle();
      await reset;

      expect(completed).toBe(true);
    });
  });
});
