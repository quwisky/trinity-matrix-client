import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicePreferenceStorageService } from './device-preference-storage.service';

const h = vi.hoisted(() => ({
  values: new Map<string, string>(),
  get: vi.fn(),
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: h.get,
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      h.values.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      h.values.delete(key);
    }),
  },
}));

describe('DevicePreferenceStorageService', () => {
  beforeEach(() => {
    h.values.clear();
    h.get.mockReset().mockImplementation(async ({ key }: { key: string }) => ({
      value: h.values.get(key) ?? null,
    }));
  });

  it('is cold and reads the value at subscription time', async () => {
    const service = TestBed.inject(DevicePreferenceStorageService);
    const read = service.get('theme');
    expect(h.get).not.toHaveBeenCalled();

    h.values.set('theme', 'dark');
    await expect(firstValueFrom(read)).resolves.toBe('dark');
  });

  it('round-trips bounded batches and removals', async () => {
    const service = TestBed.inject(DevicePreferenceStorageService);
    await firstValueFrom(
      service.setMany([
        { key: 'a', value: '1' },
        { key: 'b', value: '2' },
      ]),
    );
    await expect(
      firstValueFrom(service.getMany(['a', 'b', 'c'])),
    ).resolves.toEqual(['1', '2', null]);

    await firstValueFrom(service.removeMany(['a', 'b']));
    await expect(firstValueFrom(service.getMany(['a', 'b']))).resolves.toEqual([
      null,
      null,
    ]);
  });

  it('completes empty batches without touching the plugin', async () => {
    const service = TestBed.inject(DevicePreferenceStorageService);
    await expect(firstValueFrom(service.getMany([]))).resolves.toEqual([]);
    await expect(firstValueFrom(service.setMany([]))).resolves.toBeUndefined();
    await expect(
      firstValueFrom(service.removeMany([])),
    ).resolves.toBeUndefined();
    expect(h.get).not.toHaveBeenCalled();
  });
});
