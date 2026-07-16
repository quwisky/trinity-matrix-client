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

  it('persists state, baseUrl, mode, and a timestamp', async () => {
    await store().save('NONCE', 'https://hs.example', 'add');

    const byKey = Object.fromEntries(
      set.mock.calls.map((c) => [c[0].key, c[0].value]),
    );
    expect(byKey['sso.state']).toBe('NONCE');
    expect(byKey['sso.baseUrl']).toBe('https://hs.example');
    expect(byKey['sso.mode']).toBe('add');
    expect(Number(byKey['sso.startedAt'])).toBeGreaterThan(0);
  });

  it('defaults the mode to replace when omitted', async () => {
    await store().save('NONCE', 'https://hs.example');

    const byKey = Object.fromEntries(
      set.mock.calls.map((c) => [c[0].key, c[0].value]),
    );
    expect(byKey['sso.mode']).toBe('replace');
  });

  it('peek reads a fresh stash WITHOUT clearing (verify-before-clear)', async () => {
    getFrom({
      'sso.state': 'NONCE',
      'sso.baseUrl': 'https://hs.example',
      'sso.startedAt': String(Date.now()),
      'sso.mode': 'add',
      'sso.deviceId': 'OLDDEV',
    });

    const stash = await store().peek();

    expect(stash).toEqual({
      state: 'NONCE',
      baseUrl: 'https://hs.example',
      mode: 'add',
      deviceId: 'OLDDEV',
    });
    // A forged callback mustn't be able to wipe an in-flight login → peek never removes.
    expect(remove).not.toHaveBeenCalled();
  });

  it('clear removes every key (single-use consume = peek then clear)', async () => {
    await store().clear();

    const removed = remove.mock.calls.map((c) => c[0].key);
    expect(removed).toEqual(
      expect.arrayContaining([
        'sso.state',
        'sso.baseUrl',
        'sso.startedAt',
        'sso.mode',
        'sso.deviceId',
      ]),
    );
  });

  it('peek discards a stash older than the TTL (replay guard)', async () => {
    getFrom({
      'sso.state': 'NONCE',
      'sso.baseUrl': 'https://hs.example',
      'sso.startedAt': String(Date.now() - 11 * 60 * 1000), // 11 min > 10 min TTL
    });

    expect(await store().peek()).toEqual({
      state: null,
      baseUrl: null,
      mode: 'replace',
      deviceId: null,
    });
  });

  it('peek returns an empty stash when nothing was stored', async () => {
    getFrom({});

    expect(await store().peek()).toEqual({
      state: null,
      baseUrl: null,
      mode: 'replace',
      deviceId: null,
    });
  });

  it('persists the device id only when a re-auth passes one', async () => {
    const svc = store();
    await svc.save('NONCE', 'https://hs.example', 'add', 'OLDDEV');
    const byKey = Object.fromEntries(
      set.mock.calls.map((c) => [c[0].key, c[0].value]),
    );
    expect(byKey['sso.deviceId']).toBe('OLDDEV');

    set.mockClear();
    await svc.save('NONCE', 'https://hs.example', 'replace');
    expect(set.mock.calls.some((c) => c[0].key === 'sso.deviceId')).toBe(false);
  });
});
