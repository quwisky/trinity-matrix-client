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

/**
 * The smallest entry that reads and resets something.
 *
 * `description`, `type`, `write` and `validate` are required of every entry, so they are
 * here — inert, and all four agreeing on a setting whose value is always `null`. The tests
 * below are about the registry's shape (duplicate paths, overlapping paths, a slow reset), so
 * nothing reads or calls them; an override supplies a real one where it matters.
 */
function entry(
  path: string,
  overrides: Partial<ConfigEntry> = {},
): ConfigEntry {
  return {
    path,
    key: `trinity.${path}`,
    description: `The ${path} setting.`,
    type: 'null',
    read: () => null,
    reset: () => undefined,
    write: () => undefined,
    validate: (value) =>
      value === null
        ? { ok: true, value: null }
        : { ok: false, problem: 'takes no value' },
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

/** A document carrying exactly the given settings, in the committed envelope. */
function documentOf(settings: unknown, version = 1): unknown {
  return { version, exportedAt: new Date().toISOString(), settings };
}

/** Check a document and apply it, failing loudly if it was not accepted. */
async function applyDocument(
  config: AppConfigService,
  document: unknown,
): Promise<void> {
  const plan = config.validate(document);
  if (!plan.ok) {
    throw new Error(`rejected: ${plan.problems.join(' / ')}`);
  }
  await run(config.apply(plan));
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

  describe('validate', () => {
    it("accepts the app's own export unchanged, with nothing to do", () => {
      const config = setup();
      TestBed.inject(ThemeService).setPalette('amethyst');

      const plan = config.validate(config.export());

      expect(plan.ok).toBe(true);
      expect(plan.ok && plan.changes).toEqual([]);
      expect(plan.warnings).toEqual([]);
    });

    it('names the settings that would move, and where to', () => {
      const config = setup();

      const plan = config.validate(
        documentOf({
          theme: { palette: 'amethyst', mode: 'dark' },
          privacy: { linkPreviews: false },
        }),
      );

      expect(plan.ok && plan.changes).toEqual([
        { path: 'privacy.linkPreviews', from: true, to: false },
        { path: 'theme.mode', from: 'system', to: 'dark' },
        { path: 'theme.palette', from: 'trinity', to: 'amethyst' },
      ]);
    });

    it('rejects the whole document for one bad value, naming its path', () => {
      const config = setup();

      const plan = config.validate(
        documentOf({
          theme: { palette: 'mauve' },
          privacy: { linkPreviews: false },
        }),
      );

      expect(plan.ok).toBe(false);
      expect(plan.ok === false && plan.problems).toEqual([
        "theme.palette: 'mauve' is not a known palette (expected trinity or amethyst)",
      ]);
    });

    it('rejects a value of the wrong type where a switch is expected', () => {
      const plan = setup().validate(
        documentOf({ privacy: { linkPreviews: 'false' } }),
      );

      expect(plan.ok === false && plan.problems).toEqual([
        "privacy.linkPreviews: 'false' is not true or false",
      ]);
    });

    it('warns about a path it does not know instead of blocking the rest', () => {
      const config = setup();

      const plan = config.validate(
        documentOf({
          theme: { palette: 'amethyst', shadows: 'soft' },
          matrix: { accounts: ['@someone:hs'] },
        }),
      );

      expect(plan.ok).toBe(true);
      expect(plan.warnings).toEqual([
        'theme.shadows is not a setting this version of Trinity has, so it will not be applied.',
        'matrix.accounts is not a setting this version of Trinity has, so it will not be applied.',
      ]);
      expect(plan.ok && plan.changes.map((change) => change.path)).toEqual([
        'theme.palette',
      ]);
    });

    it('warns about a document from a newer build rather than refusing it', () => {
      const plan = setup().validate(
        documentOf({ theme: { palette: 'amethyst' } }, 2),
      );

      expect(plan.ok).toBe(true);
      expect(plan.warnings[0]).toContain('format version 2');
    });

    it('rejects anything that is not the committed envelope', () => {
      const config = setup();

      for (const notADocument of [
        { theme: { palette: 'amethyst' } },
        { version: 1 },
        { version: '1', settings: {} },
        'nonsense',
      ]) {
        expect(config.validate(notADocument).ok).toBe(false);
      }
    });

    it('reports a syntax error in the pasted text as an ordinary rejection', () => {
      const plan = setup().validateJson('{ "version": 1, ');

      expect(plan.ok).toBe(false);
      expect(plan.ok === false && plan.problems[0]).toContain('not valid JSON');
    });

    it('refuses a malformed shortcut binding rather than letting it reach resolve', () => {
      const config = setup();
      const shortcuts = TestBed.inject(KeyboardShortcutsService);

      const plan = config.validate(
        documentOf({
          shortcuts: { overrides: { 'switcher.open': { accel: 'yes' } } },
        }),
      );

      expect(plan.ok).toBe(false);
      expect(plan.ok === false && plan.problems[0]).toContain(
        "shortcuts.overrides: the binding for 'switcher.open'",
      );
      expect(shortcuts.list().every((shortcut) => shortcut.isDefault)).toBe(
        true,
      );
      expect(set.mock.calls.map(([options]) => options.key)).not.toContain(
        'trinity.shortcuts.overrides',
      );
    });
  });

  describe('apply', () => {
    it('does nothing until it is subscribed', () => {
      const config = setup();
      const theme = TestBed.inject(ThemeService);
      const plan = config.validate(
        documentOf({ theme: { palette: 'amethyst' } }),
      );

      if (plan.ok) {
        config.apply(plan);
      }

      expect(theme.palette()).toBe('trinity');
    });

    it('moves the running app, through the owning services', async () => {
      const config = setup();
      const theme = TestBed.inject(ThemeService);
      const privacy = TestBed.inject(PrivacySettingsService);

      await applyDocument(
        config,
        documentOf({
          theme: { palette: 'amethyst', textScale: 'large' },
          privacy: { sendReadReceipts: false },
        }),
      );

      expect(theme.palette()).toBe('amethyst');
      expect(theme.textScale()).toBe('large');
      expect(privacy.sendReadReceipts()).toBe(false);
      // Through the setter, so storage agrees with the signal without a reload.
      expect(set).toHaveBeenCalledWith({
        key: 'trinity.palette',
        value: 'amethyst',
      });
    });

    it('round-trips: applying an export leaves the document identical', async () => {
      const config = setup();
      TestBed.inject(ThemeService).setPalette('amethyst');
      TestBed.inject(KeyboardShortcutsService).rebind('switcher.open', {
        accel: true,
        alt: false,
        shift: false,
        key: 'j',
      });
      const before = config.settings();

      await applyDocument(config, { ...config.export() });

      expect(config.settings()).toEqual(before);
    });

    it('writes only the settings that differ', async () => {
      const config = setup();
      TestBed.inject(ThemeService).setPalette('amethyst');
      set.mockClear();

      await applyDocument(
        config,
        documentOf({ theme: { palette: 'amethyst' } }),
      );

      expect(set).not.toHaveBeenCalled();
    });

    it('applies the shortcut bindings the document carries', async () => {
      const config = setup();
      const shortcuts = TestBed.inject(KeyboardShortcutsService);

      await applyDocument(
        config,
        documentOf({
          shortcuts: {
            overrides: {
              'format.bold': { accel: true, alt: false, shift: true, key: 'b' },
            },
          },
        }),
      );

      expect(shortcuts.binding('format.bold')).toEqual({
        accel: true,
        alt: false,
        shift: true,
        key: 'b',
      });
    });

    it('never touches a key the document does not carry', async () => {
      const config = setup();
      const drafts = TestBed.inject(DraftStoreService);
      drafts.set('!room:hs', 'half-typed secret');
      set.mockClear();

      await applyDocument(config, documentOf({ theme: { mode: 'dark' } }));

      expect(set.mock.calls.map(([options]) => options.key)).toEqual([
        'trinity.theme',
      ]);
      expect(drafts.get('!room:hs')).toBe('half-typed secret');
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
