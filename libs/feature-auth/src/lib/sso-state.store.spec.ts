import { TestBed } from '@angular/core/testing';
import { Preferences } from '@capacitor/preferences';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { SsoStateStore } from './sso-state.store';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { set: vi.fn(), get: vi.fn(), remove: vi.fn() },
}));

const set = Preferences.set as unknown as Mock;
const get = Preferences.get as unknown as Mock;
const remove = Preferences.remove as unknown as Mock;

function store(): SsoStateStore {
  TestBed.configureTestingModule({ providers: [SsoStateStore] });
  return TestBed.inject(SsoStateStore);
}

/** Resolve get() from a key→value map, defaulting absent keys to null. */
function getFrom(values: Record<string, string | null>): void {
  get.mockImplementation(({ key }: { key: string }) =>
    Promise.resolve({ value: values[key] ?? null }),
  );
}

describe('SsoStateStore', () => {
  beforeEach(() => {
    set.mockReset().mockResolvedValue(undefined);
    remove.mockReset().mockResolvedValue(undefined);
    get.mockReset();
  });

  it('persists state, baseUrl, and a timestamp', async () => {
    await store().save('NONCE', 'https://hs.example');

    const byKey = Object.fromEntries(
      set.mock.calls.map((c) => [c[0].key, c[0].value]),
    );
    expect(byKey['sso.state']).toBe('NONCE');
    expect(byKey['sso.baseUrl']).toBe('https://hs.example');
    expect(Number(byKey['sso.startedAt'])).toBeGreaterThan(0);
  });

  it('consumes a fresh stash and clears every key (single-use)', async () => {
    getFrom({
      'sso.state': 'NONCE',
      'sso.baseUrl': 'https://hs.example',
      'sso.startedAt': String(Date.now()),
    });

    const stash = await store().consume();

    expect(stash).toEqual({ state: 'NONCE', baseUrl: 'https://hs.example' });
    const removed = remove.mock.calls.map((c) => c[0].key);
    expect(removed).toEqual(
      expect.arrayContaining(['sso.state', 'sso.baseUrl', 'sso.startedAt']),
    );
  });

  it('discards a stash older than the TTL (replay guard)', async () => {
    getFrom({
      'sso.state': 'NONCE',
      'sso.baseUrl': 'https://hs.example',
      'sso.startedAt': String(Date.now() - 11 * 60 * 1000), // 11 min > 10 min TTL
    });

    expect(await store().consume()).toEqual({ state: null, baseUrl: null });
    expect(remove).toHaveBeenCalled(); // still cleared
  });

  it('returns an empty stash when nothing was stored', async () => {
    getFrom({});

    expect(await store().consume()).toEqual({ state: null, baseUrl: null });
  });
});
