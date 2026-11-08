import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RETIRED_DIAGNOSTIC_LOG_DB_NAME,
  RetiredDiagnosticLogCleanup,
} from './retired-diagnostic-log';

const prefs = vi.hoisted(() => ({
  store: new Map<string, string>(),
  failing: false,
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => ({})),
  Capacitor: {
    getPlatform: () => 'web',
    isNativePlatform: () => false,
    isPluginAvailable: () => false,
  },
}));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: prefs.store.get(key) ?? null,
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      prefs.store.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      if (prefs.failing) throw new Error('storage unavailable');
      prefs.store.delete(key);
    }),
  },
}));

describe('RetiredDiagnosticLogCleanup', () => {
  /** A delete request that never settles, as when an older window holds the database. */
  const deleteDatabase = vi.fn(() => ({}) as IDBOpenDBRequest);

  beforeEach(() => {
    prefs.store.clear();
    prefs.failing = false;
    deleteDatabase.mockClear();
    vi.stubGlobal('indexedDB', { deleteDatabase });
    TestBed.resetTestingModule();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('deletes the log database and its setting, and leaves other settings alone', async () => {
    prefs.store.set(
      'trinity.diagnostics.keep-log',
      JSON.stringify({ version: 1, value: true }),
    );
    prefs.store.set('trinity.format.date', 'iso');

    await firstValueFrom(TestBed.inject(RetiredDiagnosticLogCleanup).run());

    expect(deleteDatabase).toHaveBeenCalledExactlyOnceWith(
      RETIRED_DIAGNOSTIC_LOG_DB_NAME,
    );
    expect(RETIRED_DIAGNOSTIC_LOG_DB_NAME).toBe('trinity-diagnostic-log');
    expect(prefs.store.has('trinity.diagnostics.keep-log')).toBe(false);
    expect(prefs.store.get('trinity.format.date')).toBe('iso');
  });

  it('completes without waiting for a blocked delete or a refusing storage', async () => {
    prefs.failing = true;

    await expect(
      firstValueFrom(TestBed.inject(RetiredDiagnosticLogCleanup).run()),
    ).resolves.toBeUndefined();
  });
});
