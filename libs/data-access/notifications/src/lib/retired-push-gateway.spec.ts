import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RETIRED_PUSH_GATEWAY_KEYS,
  RetiredPushGatewayCleanup,
} from './retired-push-gateway';

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

describe('RetiredPushGatewayCleanup', () => {
  beforeEach(() => {
    prefs.store.clear();
    prefs.failing = false;
    TestBed.resetTestingModule();
  });

  it('deletes the override and ledger an earlier build saved', async () => {
    prefs.store.set(
      'trinity.push.gateway',
      JSON.stringify({
        gatewayUrl: 'https://old.example/_matrix/push/v1/notify',
      }),
    );
    prefs.store.set('trinity.push.applied-app-id', 'old.app.id');
    prefs.store.set('trinity.format.date', 'iso');

    await firstValueFrom(TestBed.inject(RetiredPushGatewayCleanup).run());

    expect(RETIRED_PUSH_GATEWAY_KEYS).toEqual([
      'trinity.push.gateway',
      'trinity.push.applied-app-id',
    ]);
    expect(prefs.store.has('trinity.push.gateway')).toBe(false);
    expect(prefs.store.has('trinity.push.applied-app-id')).toBe(false);
    expect(prefs.store.get('trinity.format.date')).toBe('iso');
  });

  it('completes without an error when storage refuses, so startup continues', async () => {
    prefs.failing = true;

    await expect(
      firstValueFrom(TestBed.inject(RetiredPushGatewayCleanup).run()),
    ).resolves.toBeUndefined();
  });
});
