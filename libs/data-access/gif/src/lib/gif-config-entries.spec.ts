import { TestBed } from '@angular/core/testing';
import {
  AppConfigService,
  configSchemaDrift,
  exportedKeysFor,
} from '@trinity/platform-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { provideGifConfigEntries } from './gif-config-entries';
import { GifSettingsService } from './gif-settings.service';

const prefs = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@capacitor/preferences', () => ({
  Preferences: prefs,
}));

function setup(): { config: AppConfigService; gif: GifSettingsService } {
  TestBed.configureTestingModule({
    providers: [provideGifConfigEntries()],
  });
  return {
    config: TestBed.inject(AppConfigService),
    gif: TestBed.inject(GifSettingsService),
  };
}

describe('GIF config entries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prefs.get.mockResolvedValue({ value: null });
    prefs.set.mockResolvedValue(undefined);
    prefs.remove.mockResolvedValue(undefined);
  });

  it('registers an entry for every key the ledger says this lib exports', () => {
    const keys = new Set(setup().config.entries.map((entry) => entry.key));

    expect([...keys]).toEqual([...exportedKeysFor('data-access/gif')]);
  });

  it('describes each of its settings the way the schema publishes it', () => {
    // The runtime half of the drift guard, over this lib's contribution: its Nx boundary
    // stops any other project from checking these, so a setting added here fails here.
    expect(configSchemaDrift(setup().config.entries)).toEqual([]);
  });

  it('exports the picker config under its own group', () => {
    const { config, gif } = setup();
    gif.save('giphy', 'abc123');

    expect(config.settings()).toEqual({
      gif: { provider: 'giphy', apiKey: 'abc123' },
    });
  });

  it('refuses a provider it cannot talk to, naming what it takes', () => {
    const { config } = setup();

    const plan = config.validate({
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: { gif: { provider: 'giffy' } },
    });

    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.problems).toEqual([
      "gif.provider: 'giffy' is not a GIF provider Trinity can talk to (expected klipy or giphy)",
    ]);
  });

  it('applies both halves of the shared blob, whichever order they run in', async () => {
    const { config, gif } = setup();
    const plan = config.validate({
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: { gif: { provider: 'giphy', apiKey: '  abc123  ' } },
    });
    if (!plan.ok) {
      throw new Error(plan.problems.join(' / '));
    }

    await new Promise<void>((resolve, reject) =>
      config.apply(plan).subscribe({ complete: resolve, error: reject }),
    );

    expect(gif.provider()).toBe('giphy');
    // Trimmed on the way in, and the plan said so: the change named 'abc123', not the paste.
    expect(gif.apiKey()).toBe('abc123');
    expect(plan.changes.map((change) => change.to)).toEqual([
      'abc123',
      'giphy',
    ]);
    expect(prefs.set).toHaveBeenLastCalledWith({
      key: 'trinity.gif.config',
      value: JSON.stringify({ provider: 'giphy', apiKey: 'abc123' }),
    });
  });

  it('resets to KLIPY with no key, whichever half runs first', async () => {
    const { config, gif } = setup();
    gif.save('giphy', 'abc123');

    await new Promise<void>((resolve, reject) =>
      config.resetToDefaults().subscribe({ complete: resolve, error: reject }),
    );

    expect(gif.provider()).toBe('klipy');
    expect(gif.apiKey()).toBe('');
    // Rewritten rather than removed: both fields share one stored blob, so a remove()
    // would drop the provider with the key.
    expect(prefs.remove).not.toHaveBeenCalled();
    expect(prefs.set).toHaveBeenLastCalledWith({
      key: 'trinity.gif.config',
      value: JSON.stringify({ provider: 'klipy', apiKey: '' }),
    });
  });

  describe('a document exported before Tenor was retired', () => {
    it('is accepted and migrated rather than rejected', async () => {
      // Every export taken before this change carries "provider": "tenor". Rejecting it
      // would make a file produced by our own Export button fail to import, naming a path
      // the user cannot fix without hand-editing the JSON.
      const { config, gif } = setup();
      // Start on GIPHY, so migrating to KLIPY is a real change the plan has to report.
      // Against the default it would be a no-op and the assertion would prove nothing.
      gif.save('giphy', '');

      const plan = config.validate({
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: { gif: { provider: 'tenor' } },
      });

      expect(plan.ok).toBe(true);
      if (!plan.ok) {
        throw new Error(plan.problems.join(' / '));
      }
      expect(plan.changes.map((change) => change.to)).toEqual(['klipy']);

      await new Promise<void>((resolve, reject) =>
        config.apply(plan).subscribe({ complete: resolve, error: reject }),
      );

      expect(gif.provider()).toBe('klipy');
    });

    it('says why, and that the old key will not work', () => {
      const { config } = setup();

      const plan = config.validate({
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: { gif: { provider: 'tenor' } },
      });

      expect(plan.warnings).toHaveLength(1);
      expect(plan.warnings[0]).toContain('gif.provider');
      expect(plan.warnings[0]).toContain('klipy');
      expect(plan.warnings[0]).toContain('key');
    });

    it('still refuses an id that was never a provider', () => {
      // The migration is one named retired id, not a general escape hatch — the set stays
      // closed, which is what configSchemaDrift asserts about this entry.
      const { config } = setup();

      const plan = config.validate({
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: { gif: { provider: 'giffy' } },
      });

      expect(plan.ok).toBe(false);
    });
  });
});
