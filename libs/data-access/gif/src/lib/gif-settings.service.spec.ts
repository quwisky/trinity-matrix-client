import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Preferences } from '@capacitor/preferences';
import { GifSettingsService } from './gif-settings.service';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

const prefs = vi.mocked(Preferences);

describe('GifSettingsService', () => {
  let svc: GifSettingsService;

  beforeEach(() => {
    vi.clearAllMocks();
    prefs.get.mockResolvedValue({ value: null });
    prefs.set.mockResolvedValue(undefined);
    prefs.remove.mockResolvedValue(undefined);
    TestBed.configureTestingModule({});
    svc = TestBed.inject(GifSettingsService);
  });

  it('defaults to Tenor and unconfigured', () => {
    expect(svc.provider()).toBe('tenor');
    expect(svc.apiKey()).toBe('');
    expect(svc.configured()).toBe(false);
  });

  it('hydrates the provider + key from persisted config on init', async () => {
    prefs.get.mockResolvedValue({
      value: JSON.stringify({ provider: 'giphy', apiKey: 'abc' }),
    });
    await svc.init();
    expect(svc.provider()).toBe('giphy');
    expect(svc.apiKey()).toBe('abc');
    expect(svc.configured()).toBe(true);
  });

  it('keeps defaults when nothing is stored', async () => {
    prefs.get.mockResolvedValue({ value: null });
    await svc.init();
    expect(svc.provider()).toBe('tenor');
    expect(svc.configured()).toBe(false);
  });

  it('ignores a malformed persisted value', async () => {
    prefs.get.mockResolvedValue({ value: '{not json' });
    await svc.init();
    expect(svc.configured()).toBe(false);
  });

  it('ignores an unknown provider id in persisted config', async () => {
    prefs.get.mockResolvedValue({
      value: JSON.stringify({ provider: 'nope', apiKey: 'x' }),
    });
    await svc.init();
    expect(svc.provider()).toBe('tenor');
    // The key still hydrates so the feature is usable with the default provider.
    expect(svc.apiKey()).toBe('x');
  });

  it('save() trims the key, updates the signals and persists JSON', () => {
    svc.save('giphy', '  key123  ');
    expect(svc.provider()).toBe('giphy');
    expect(svc.apiKey()).toBe('key123');
    expect(svc.configured()).toBe(true);
    expect(prefs.set).toHaveBeenCalledWith({
      key: 'trinity.gif.config',
      value: JSON.stringify({ provider: 'giphy', apiKey: 'key123' }),
    });
  });

  it('clear() empties the key and persists the provider with an empty key', () => {
    svc.save('giphy', 'k');
    svc.clear();
    expect(svc.apiKey()).toBe('');
    expect(svc.configured()).toBe(false);
    expect(prefs.set).toHaveBeenLastCalledWith({
      key: 'trinity.gif.config',
      value: JSON.stringify({ provider: 'giphy', apiKey: '' }),
    });
    expect(prefs.remove).not.toHaveBeenCalled();
  });

  it('clear() keeps the provider choice across a reload', async () => {
    // provider + apiKey share a single stored blob, so clearing the key must not
    // take the provider with it: a GIPHY user who clears their key and reloads
    // should still see GIPHY selected, not silently fall back to the Tenor default.
    // Round-trips through a real (in-memory) Preferences store rather than
    // asserting on the mock calls, so it pins behaviour and not implementation.
    const store = new Map<string, string>();
    prefs.get.mockImplementation(async ({ key }) => ({
      value: store.get(key) ?? null,
    }));
    prefs.set.mockImplementation(async ({ key, value }) => {
      store.set(key, value);
    });
    prefs.remove.mockImplementation(async ({ key }) => {
      store.delete(key);
    });

    svc.save('giphy', 'k');
    svc.clear();

    // A fresh service stands in for the next app boot reading persisted config.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const reloaded = TestBed.inject(GifSettingsService);
    await reloaded.init();

    expect(reloaded.provider()).toBe('giphy');
    expect(reloaded.apiKey()).toBe('');
    expect(reloaded.configured()).toBe(false); // key gone → picker stays hidden
  });
});
