import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import {
  PREFERENCE_STORAGE_ADAPTER,
  PreferenceStoreService,
  type PreferenceState,
  type PreferenceStorageAdapter,
  type PreferenceValue,
} from '@trinity/runtime/preferences';
import { EMPTY, firstValueFrom, of, throwError, type Observable } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_LOCK_ENABLED_PREFERENCE,
  APP_LOCK_LOCK_AFTER_PREFERENCE,
  readAppLockSettings,
} from './app-lock.preferences';

function store(adapter: PreferenceStorageAdapter): PreferenceStoreService {
  TestBed.configureTestingModule({
    providers: [{ provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter }],
  });
  return TestBed.inject(PreferenceStoreService);
}

const unavailable: PreferenceStorageAdapter = {
  read: () => of({ kind: 'unavailable', diagnostic: { code: 'io' } }),
  write: () => of({ kind: 'completed' }),
};

const stored = (values: Record<string, unknown>): PreferenceStorageAdapter => ({
  read: ({ key }) =>
    of(
      key in values
        ? {
            kind: 'found',
            payload: JSON.stringify({ version: 1, value: values[key] }),
          }
        : { kind: 'missing' },
    ),
  write: () => of({ kind: 'completed' }),
});

describe('App lock preferences', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('are per device and kept out of the exported settings', () => {
    for (const descriptor of [
      APP_LOCK_ENABLED_PREFERENCE,
      APP_LOCK_LOCK_AFTER_PREFERENCE,
    ]) {
      expect(descriptor).toMatchObject({
        owner: 'app-lock',
        scope: 'installation',
        storage: 'device-preferences',
        export: 'excluded',
        sensitivity: 'private',
      });
    }
    expect(APP_LOCK_ENABLED_PREFERENCE.persistence.key).toBe(
      'trinity.app-lock.enabled',
    );
    expect(APP_LOCK_LOCK_AFTER_PREFERENCE.persistence.key).toBe(
      'trinity.app-lock.lock-after',
    );
    expect(APP_LOCK_ENABLED_PREFERENCE.defaultValue).toBe(false);
    expect(APP_LOCK_LOCK_AFTER_PREFERENCE.defaultValue).toBe('1m');
  });

  it('accept only their own values', () => {
    expect(APP_LOCK_ENABLED_PREFERENCE.validate('yes').kind).toBe('rejected');
    expect(APP_LOCK_LOCK_AFTER_PREFERENCE.validate('2m').kind).toBe('rejected');
    expect(APP_LOCK_LOCK_AFTER_PREFERENCE.validate('15m')).toEqual({
      kind: 'accepted',
      value: '15m',
    });
  });

  it('read as unreadable, never as off, when storage fails', async () => {
    await expect(
      firstValueFrom(readAppLockSettings(store(unavailable))),
    ).resolves.toEqual({
      enabled: 'unreadable',
      lockAfter: '1m',
    });
  });

  it('read as unreadable, never as off, when the stored switch is not a boolean', async () => {
    await expect(
      firstValueFrom(
        readAppLockSettings(
          store(stored({ 'trinity.app-lock.enabled': 'yes' })),
        ),
      ),
    ).resolves.toEqual({ enabled: 'unreadable', lockAfter: '1m' });
  });

  it('read as unreadable, never as off, when the adapter throws', async () => {
    const throwing: PreferenceStorageAdapter = {
      read: () => throwError(() => new Error('io')),
      write: () => of({ kind: 'completed' }),
    };
    await expect(
      firstValueFrom(readAppLockSettings(store(throwing))),
    ).resolves.toEqual({
      enabled: 'unreadable',
      lockAfter: '1m',
    });
  });

  it('read as unreadable, never as off, without a storage adapter', async () => {
    TestBed.configureTestingModule({});
    const preferences = TestBed.inject(PreferenceStoreService);
    await expect(
      firstValueFrom(readAppLockSettings(preferences)),
    ).resolves.toEqual({
      enabled: 'unreadable',
      lockAfter: '1m',
    });
  });

  it('read as off when nothing is stored', async () => {
    await expect(
      firstValueFrom(readAppLockSettings(store(stored({})))),
    ).resolves.toEqual({
      enabled: false,
      lockAfter: '1m',
    });
  });

  it('read the stored values', async () => {
    await expect(
      firstValueFrom(
        readAppLockSettings(
          store(
            stored({
              'trinity.app-lock.enabled': true,
              'trinity.app-lock.lock-after': '15m',
            }),
          ),
        ),
      ),
    ).resolves.toEqual({ enabled: true, lockAfter: '15m' });
  });

  it('keep the stored switch when only the delay is unreadable', async () => {
    await expect(
      firstValueFrom(
        readAppLockSettings(
          store(
            stored({
              'trinity.app-lock.enabled': true,
              'trinity.app-lock.lock-after': '2m',
            }),
          ),
        ),
      ),
    ).resolves.toEqual({ enabled: true, lockAfter: '1m' });
  });

  describe('with a store that reports an unexpected load state', () => {
    /** A store whose hydration succeeds but whose cells hold `state`, whatever its kind. */
    function reporting(
      state: unknown,
      hydration: Observable<unknown> = of({ kind: 'ready', hydrated: 2 }),
    ): PreferenceStoreService {
      return {
        hydrateDescriptors: () => hydration,
        stateFor: () => signal(state as PreferenceState<PreferenceValue>),
      } as unknown as PreferenceStoreService;
    }

    it.each([
      ['its default state', { kind: 'default', value: false }],
      ['a state kind added later', { kind: 'stale', value: false }],
    ])(
      'read as unreadable, never as off, when the switch is in %s',
      async (_name, state) => {
        await expect(
          firstValueFrom(readAppLockSettings(reporting(state))),
        ).resolves.toEqual({
          enabled: 'unreadable',
          lockAfter: '1m',
        });
      },
    );

    it('read as unreadable, never as off, when hydration completes without an outcome', async () => {
      await expect(
        firstValueFrom(
          readAppLockSettings(
            reporting({ kind: 'ready', value: false }, EMPTY),
          ),
        ),
      ).resolves.toEqual({ enabled: 'unreadable', lockAfter: '1m' });
    });
  });
});
