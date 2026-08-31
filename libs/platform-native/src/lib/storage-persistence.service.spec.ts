import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoragePersistenceService } from './storage-persistence.service';

/** Swap `navigator.storage` for a test double (deleted again in afterEach). */
function setStorage(value: unknown): void {
  Object.defineProperty(navigator, 'storage', { configurable: true, value });
}

function make(): StoragePersistenceService {
  TestBed.configureTestingModule({ providers: [StoragePersistenceService] });
  return TestBed.inject(StoragePersistenceService);
}

describe('StoragePersistenceService', () => {
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, 'storage');
    TestBed.resetTestingModule();
  });

  describe('requestPersistence', () => {
    it('requests persistence and returns the granted state', async () => {
      const persist = vi.fn().mockResolvedValue(true);
      setStorage({ persist, persisted: vi.fn().mockResolvedValue(false) });

      expect(await firstValueFrom(make().requestPersistence())).toBe(true);
      expect(persist).toHaveBeenCalled();
    });

    it('does not re-ask when storage is already persistent', async () => {
      const persist = vi.fn().mockResolvedValue(false);
      setStorage({ persist, persisted: vi.fn().mockResolvedValue(true) });

      expect(await firstValueFrom(make().requestPersistence())).toBe(true);
      expect(persist).not.toHaveBeenCalled();
    });

    it('returns false when the API is unavailable', async () => {
      setStorage(undefined);
      expect(await firstValueFrom(make().requestPersistence())).toBe(false);
    });

    it('swallows a persist() rejection and returns false', async () => {
      setStorage({
        persist: vi.fn().mockRejectedValue(new Error('nope')),
        persisted: vi.fn().mockResolvedValue(false),
      });
      expect(await firstValueFrom(make().requestPersistence())).toBe(false);
    });

    it('fails open when the browser leaves the permission request pending', async () => {
      vi.useFakeTimers();
      setStorage({
        persist: vi.fn(() => new Promise<boolean>(() => undefined)),
        persisted: vi.fn().mockResolvedValue(false),
      });
      const result = firstValueFrom(make().requestPersistence());

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe(false);
    });
  });

  describe('estimate', () => {
    it('reports usage, quota, and percent', async () => {
      setStorage({
        estimate: vi.fn().mockResolvedValue({ usage: 250, quota: 1000 }),
      });
      expect(await make().estimate()).toEqual({
        usageBytes: 250,
        quotaBytes: 1000,
        percentUsed: 25,
      });
    });

    it('returns null when the API is unavailable', async () => {
      setStorage({});
      expect(await make().estimate()).toBeNull();
    });

    it('avoids divide-by-zero when quota is 0', async () => {
      setStorage({
        estimate: vi.fn().mockResolvedValue({ usage: 0, quota: 0 }),
      });
      expect(await make().estimate()).toEqual({
        usageBytes: 0,
        quotaBytes: 0,
        percentUsed: 0,
      });
    });
  });
});
