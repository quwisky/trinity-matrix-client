import { TestBed } from '@angular/core/testing';
import { Preferences } from '@capacitor/preferences';
import { AppConfigService, exportedKeysFor } from '@trinity/platform-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { provideGifConfigEntries } from './gif-config-entries';
import { GifSettingsService } from './gif-settings.service';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

const prefs = vi.mocked(Preferences);

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

  it('exports the picker config under its own group', () => {
    const { config, gif } = setup();
    gif.save('giphy', 'abc123');

    expect(config.settings()).toEqual({
      gif: { provider: 'giphy', apiKey: 'abc123' },
    });
  });

  it('resets to Tenor with no key, whichever half runs first', async () => {
    const { config, gif } = setup();
    gif.save('giphy', 'abc123');

    await new Promise<void>((resolve, reject) =>
      config.resetToDefaults().subscribe({ complete: resolve, error: reject }),
    );

    expect(gif.provider()).toBe('tenor');
    expect(gif.apiKey()).toBe('');
    // Rewritten rather than removed: both fields share one stored blob, so a remove()
    // would drop the provider with the key.
    expect(prefs.remove).not.toHaveBeenCalled();
    expect(prefs.set).toHaveBeenLastCalledWith({
      key: 'trinity.gif.config',
      value: JSON.stringify({ provider: 'tenor', apiKey: '' }),
    });
  });
});
