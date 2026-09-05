import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GifSettingsService } from './gif-settings.service';

const prefs = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@capacitor/preferences', () => ({
  Preferences: prefs,
}));

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

  it('defaults to KLIPY and unconfigured', () => {
    expect(svc.provider()).toBe('klipy');
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
    expect(svc.provider()).toBe('klipy');
    expect(svc.configured()).toBe(false);
  });

  it('ignores a malformed persisted value', async () => {
    prefs.get.mockResolvedValue({ value: '{not json' });
    await expect(svc.init()).resolves.toEqual({
      kind: 'defaulted',
      reason: 'invalid-stored-value',
    });
    expect(svc.configured()).toBe(false);
  });

  it('reports its unconfigured default when storage is unavailable', async () => {
    prefs.get.mockRejectedValue(new Error('apiKey=do-not-export'));

    await expect(svc.init()).resolves.toEqual({
      kind: 'defaulted',
      reason: 'storage-unavailable',
    });
    expect(svc.configured()).toBe(false);
  });

  it('ignores an unknown provider id in persisted config', async () => {
    prefs.get.mockResolvedValue({
      value: JSON.stringify({ provider: 'nope', apiKey: 'x' }),
    });
    await svc.init();
    expect(svc.provider()).toBe('klipy');
    // The key still hydrates so the feature is usable with the default provider. This is
    // NOT the retired-provider path: an id we never had says nothing about the key beside
    // it, whereas a Tenor key is known to be dead. See the migration tests below.
    expect(svc.apiKey()).toBe('x');
  });

  describe('migrating off a retired provider', () => {
    it('moves a stored Tenor config to KLIPY and drops the dead key', async () => {
      // The bug this pins (#136). `configured` only asks whether a key is non-empty, so
      // hydrating the two fields independently would open the picker against KLIPY holding
      // a Tenor key: every search 401s and it reads as a broken new provider.
      prefs.get.mockResolvedValue({
        value: JSON.stringify({ provider: 'tenor', apiKey: 'dead-tenor-key' }),
      });

      await svc.init();

      expect(svc.provider()).toBe('klipy');
      expect(svc.apiKey()).toBe('');
      expect(svc.configured()).toBe(false);
      expect(svc.migratedFrom()).toBe('tenor');
    });

    it('persists the migration, so it does not run again on the next boot', async () => {
      const store = new Map<string, string>([
        [
          'trinity.gif.config',
          JSON.stringify({ provider: 'tenor', apiKey: 'dead' }),
        ],
      ]);
      prefs.get.mockImplementation(async ({ key }) => ({
        value: store.get(key) ?? null,
      }));
      prefs.set.mockImplementation(async ({ key, value }) => {
        store.set(key, value);
      });

      await svc.init();
      expect(store.get('trinity.gif.config')).toBe(
        JSON.stringify({ provider: 'klipy', apiKey: '' }),
      );

      // A genuinely fresh instance, not TestBed.inject() again — that returns the same
      // root singleton and would assert nothing about a second boot.
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({});
      const nextBoot = TestBed.inject(GifSettingsService);
      await nextBoot.init();

      expect(nextBoot.provider()).toBe('klipy');
      expect(nextBoot.migratedFrom()).toBeNull();
    });

    it('leaves a current provider alone, key and all', async () => {
      prefs.get.mockResolvedValue({
        value: JSON.stringify({ provider: 'giphy', apiKey: 'live' }),
      });

      await svc.init();

      expect(svc.provider()).toBe('giphy');
      expect(svc.apiKey()).toBe('live');
      expect(svc.migratedFrom()).toBeNull();
    });
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
    // should still see GIPHY selected, not silently fall back to the KLIPY default.
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
