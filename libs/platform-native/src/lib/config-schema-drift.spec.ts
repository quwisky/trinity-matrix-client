import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfigService } from './app-config.service';
import { configSchemaDrift } from './config-schema-drift';
import type { ConfigEntry, ConfigValue } from './config-schema';
import { choiceSetting, flagSetting } from './config-validation';
import { providePlatformConfigEntries } from './platform-config-entries';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

/** A well-formed flag, as a base for the deliberately-broken ones below. */
function flag(path: string, current = false): ConfigEntry {
  return {
    path,
    key: `stored:${path}`,
    description: `Whether ${path} is on.`,
    read: () => current,
    reset: () => undefined,
    ...flagSetting(() => undefined),
  };
}

/**
 * A closed choice, with `options` and the guard supplied separately so a test can pull them
 * apart — which is exactly the drift the guard is for: a value added to the offered list
 * while the guard that actually decides is left behind.
 */
function choice(spec: {
  readonly path: string;
  readonly options: readonly string[];
  readonly accepts: readonly string[];
  readonly current: ConfigValue;
}): ConfigEntry {
  const isValid = (value: string): value is string =>
    spec.accepts.indexOf(value) >= 0;
  return {
    path: spec.path,
    key: `stored:${spec.path}`,
    description: `The ${spec.path} setting.`,
    read: () => spec.current,
    reset: () => undefined,
    ...choiceSetting({
      isValid,
      options: spec.options,
      noun: 'a known value',
      set: () => undefined,
    }),
  };
}

describe('configSchemaDrift', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.resetTestingModule();
  });

  it('finds nothing wrong with the settings this lib actually registers', () => {
    // The point of the guard, run over the real thing: every path, description, type and
    // accepted set that ships is checked against the schema generated from it.
    TestBed.configureTestingModule({
      providers: [providePlatformConfigEntries()],
    });

    expect(configSchemaDrift(TestBed.inject(AppConfigService).entries)).toEqual(
      [],
    );
  });

  it('catches an offered value the setting would refuse', () => {
    const drift = configSchemaDrift([
      choice({
        path: 'theme.palette',
        options: ['trinity', 'amethyst', 'mauve'],
        accepts: ['trinity', 'amethyst'],
        current: 'trinity',
      }),
    ]);

    expect(drift).toEqual([
      expect.stringContaining(
        "theme.palette: it offers 'mauve', which its own check refuses",
      ),
    ]);
  });

  it('catches a check that accepts more than the setting offers', () => {
    const drift = configSchemaDrift([
      {
        ...flag('theme.mode'),
        type: 'string',
        choices: ['system', 'light', 'dark'],
        read: () => 'system',
        // Waves anything through — the shape of a guard someone loosened while the offered
        // list stayed closed, which makes the editor's list decorative rather than binding.
        validate: (value) => ({
          ok: true,
          value: typeof value === 'string' ? value : '',
        }),
      },
    ]);

    expect(drift).toEqual([
      'theme.mode: its check accepts a value outside its list, so the list is not the closed set.',
    ]);
  });

  it('catches a setting that does not hold the type it publishes', () => {
    const drift = configSchemaDrift([
      { ...flag('flags.virtual'), type: 'string' },
    ]);

    expect(drift).toEqual([
      expect.stringContaining(
        'flags.virtual: it holds a boolean but declares string',
      ),
    ]);
  });

  it('catches a path that two settings claim', () => {
    const drift = configSchemaDrift([flag('theme.mode'), flag('theme.mode')]);

    expect(drift).toEqual([
      expect.stringContaining('theme.mode: declared by two entries'),
    ]);
  });

  it('catches a path the schema cannot place, rather than losing it silently', () => {
    // `theme.mode` has to be both a setting and a group for `theme.mode.extra` to exist.
    // The generator drops the loser; without this check the schema would simply describe
    // one setting fewer than the app has, and the editor would mark it unknown.
    const drift = configSchemaDrift([
      flag('theme.mode'),
      flag('theme.mode.extra'),
    ]);

    expect(drift).toEqual([
      expect.stringContaining(
        'theme.mode.extra: registered, but missing from the generated schema',
      ),
    ]);
  });

  it('catches a setting with no description', () => {
    const drift = configSchemaDrift([
      { ...flag('theme.mode'), description: ' ' },
    ]);

    expect(drift).toEqual(['theme.mode: its description is empty.']);
  });
});
