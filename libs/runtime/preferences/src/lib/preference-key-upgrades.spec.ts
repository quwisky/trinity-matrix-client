import { TestBed } from '@angular/core/testing';
import { Subject, firstValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PreferenceCatalogService,
  providePreferenceDescriptors,
} from './preference-catalog.service';
import {
  INSTALLATION_PREFERENCE_CONTEXT,
  definePreference,
  type PreferenceDescriptor,
  type PreferenceValue,
  type StoredPreference,
} from './preference.models';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceStorageAdapter,
  type PreferenceStorageReadOutcome,
  type PreferenceStorageRequest,
  type PreferenceStorageWriteOutcome,
} from './preference-storage';
import { PreferenceStoreService } from './preference-store.service';

const CURRENT_KEY = 'test.flag.v2';
const FIRST_LEGACY_KEY = 'test.flag.v1';
const OLDEST_LEGACY_KEY = 'test.flag';

function booleanMigration(stored: StoredPreference) {
  return (stored.version === 0 || stored.version === 1) &&
    typeof stored.value === 'boolean'
    ? ({ kind: 'accepted', value: stored.value } as const)
    : ({
        kind: 'rejected',
        diagnostic: { code: 'expected-legacy-boolean' },
      } as const);
}

function booleanPreference(
  overrides: Partial<PreferenceDescriptor<boolean>> = {},
): PreferenceDescriptor<boolean> {
  return definePreference({
    id: 'conversations.test.flag',
    owner: 'conversations',
    section: 'test',
    order: 0,
    scope: 'installation',
    defaultValue: true,
    sensitivity: 'private',
    storage: 'device-preferences',
    export: 'portable',
    editor: {
      kind: 'toggle',
      label: 'Test flag',
      description: 'A test preference.',
      testId: 'test-flag',
    },
    persistence: {
      key: CURRENT_KEY,
      legacyKeys: [FIRST_LEGACY_KEY, OLDEST_LEGACY_KEY],
      migration: { currentVersion: 1, migrate: booleanMigration },
    },
    validate: (value) =>
      typeof value === 'boolean'
        ? { kind: 'accepted', value }
        : {
            kind: 'rejected',
            diagnostic: { code: 'expected-boolean' },
          },
    ...overrides,
  });
}

function setup(
  descriptors: readonly PreferenceDescriptor<PreferenceValue>[],
  adapter: PreferenceStorageAdapter,
): PreferenceStoreService {
  TestBed.configureTestingModule({
    providers: [
      providePreferenceDescriptors(() => descriptors),
      { provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter },
    ],
  });
  return TestBed.inject(PreferenceStoreService);
}

function mapAdapter(
  values: ReadonlyMap<string, string>,
  writes: (PreferenceStorageRequest & { readonly payload: string })[] = [],
): PreferenceStorageAdapter {
  return {
    read: (request) =>
      of(
        values.has(request.key)
          ? { kind: 'found', payload: values.get(request.key)! }
          : { kind: 'missing' },
      ),
    write: (request) => {
      writes.push(request);
      return of({ kind: 'completed' });
    },
  };
}

describe('PreferenceStoreService descriptor-key upgrades', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('keeps legacy storage keys out of current catalog entries', () => {
    const descriptor = booleanPreference();
    const store = setup([descriptor], mapAdapter(new Map()));

    expect(
      TestBed.inject(PreferenceCatalogService).descriptor(FIRST_LEGACY_KEY),
    ).toBeUndefined();
    const entries = store.entries('test', INSTALLATION_PREFERENCE_CONTEXT);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty('persistence');
  });

  it('uses the current key without consulting legacy keys when both exist', async () => {
    const descriptor = booleanPreference();
    const outcomes: Readonly<Record<string, PreferenceStorageReadOutcome>> = {
      [CURRENT_KEY]: {
        kind: 'found',
        payload: '{"version":1,"value":false}',
      },
      [FIRST_LEGACY_KEY]: { kind: 'found', payload: 'true' },
    };
    const read = vi.fn(
      (
        request: PreferenceStorageRequest,
      ): ReturnType<PreferenceStorageAdapter['read']> =>
        of(outcomes[request.key] ?? { kind: 'missing' }),
    );
    const write = vi.fn(() => of({ kind: 'completed' } as const));
    const store = setup([descriptor], { read, write });

    await expect(
      firstValueFrom(store.hydrate(INSTALLATION_PREFERENCE_CONTEXT)),
    ).resolves.toEqual({ kind: 'ready', hydrated: 1 });

    expect(store.value(descriptor.id, INSTALLATION_PREFERENCE_CONTEXT)()).toBe(
      false,
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ key: CURRENT_KEY }),
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('reads legacy keys in declaration order and writes only the current key', async () => {
    const descriptor = booleanPreference();
    const reads: string[] = [];
    const writes: (PreferenceStorageRequest & {
      readonly payload: string;
    })[] = [];
    const adapter: PreferenceStorageAdapter = {
      read: (request) => {
        reads.push(request.key);
        return of(
          request.key === OLDEST_LEGACY_KEY
            ? { kind: 'found', payload: 'false' }
            : { kind: 'missing' },
        );
      },
      write: (request) => {
        writes.push(request);
        return of({ kind: 'completed' });
      },
    };
    const store = setup([descriptor], adapter);

    await firstValueFrom(store.hydrate(INSTALLATION_PREFERENCE_CONTEXT));
    await firstValueFrom(
      store.set(descriptor.id, INSTALLATION_PREFERENCE_CONTEXT, true),
    );

    expect(reads).toEqual([CURRENT_KEY, FIRST_LEGACY_KEY, OLDEST_LEGACY_KEY]);
    expect(writes).toHaveLength(2);
    expect(writes.every(({ key }) => key === CURRENT_KEY)).toBe(true);
    expect(writes[0]?.payload).toBe('{"version":1,"value":false}');
    expect(writes[1]?.payload).toBe('{"version":1,"value":true}');
  });

  it('persists a valid legacy value before publishing it', async () => {
    const descriptor = booleanPreference();
    const writeResult = new Subject<PreferenceStorageWriteOutcome>();
    const write = vi.fn(() => writeResult.asObservable());
    const store = setup([descriptor], {
      read: (request) =>
        of(
          request.key === FIRST_LEGACY_KEY
            ? { kind: 'found', payload: 'false' }
            : { kind: 'missing' },
        ),
      write,
    });
    const hydration = firstValueFrom(
      store.hydrate(INSTALLATION_PREFERENCE_CONTEXT),
    );

    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        key: CURRENT_KEY,
        payload: '{"version":1,"value":false}',
      }),
    );
    expect(store.value(descriptor.id, INSTALLATION_PREFERENCE_CONTEXT)()).toBe(
      true,
    );

    writeResult.next({ kind: 'completed' });
    writeResult.complete();

    await expect(hydration).resolves.toEqual({ kind: 'ready', hydrated: 1 });
    expect(store.value(descriptor.id, INSTALLATION_PREFERENCE_CONTEXT)()).toBe(
      false,
    );
  });

  it('defaults only the descriptor with invalid legacy data', async () => {
    const hostile = 'access_token=legacy-secret';
    const invalid = booleanPreference();
    const healthy = booleanPreference({
      id: 'conversations.test.healthy',
      order: 1,
      persistence: {
        key: 'test.healthy.v1',
        migration: { currentVersion: 1, migrate: booleanMigration },
      },
    });
    const store = setup(
      [invalid, healthy],
      mapAdapter(
        new Map([
          [FIRST_LEGACY_KEY, hostile],
          ['test.healthy.v1', '{"version":1,"value":false}'],
        ]),
      ),
    );

    const result = await firstValueFrom(
      store.hydrate(INSTALLATION_PREFERENCE_CONTEXT),
    );

    expect(result).toEqual({
      kind: 'partial',
      hydrated: 1,
      failures: [
        {
          preferenceId: invalid.id,
          recovery: 'reset-preference',
          diagnostic: { code: 'preference-migration-rejected' },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(hostile);
    expect(store.value(invalid.id, INSTALLATION_PREFERENCE_CONTEXT)()).toBe(
      true,
    );
    expect(store.value(healthy.id, INSTALLATION_PREFERENCE_CONTEXT)()).toBe(
      false,
    );
  });

  it('does not fall through from an invalid current value to valid legacy data', async () => {
    const descriptor = booleanPreference();
    const read = vi.fn(
      (
        request: PreferenceStorageRequest,
      ): ReturnType<PreferenceStorageAdapter['read']> =>
        of(
          request.key === CURRENT_KEY
            ? { kind: 'found', payload: 'invalid-current' }
            : { kind: 'found', payload: 'false' },
        ),
    );
    const store = setup([descriptor], {
      read,
      write: () => of({ kind: 'completed' }),
    });

    const result = await firstValueFrom(
      store.hydrate(INSTALLATION_PREFERENCE_CONTEXT),
    );

    expect(result.kind).toBe('partial');
    expect(read).toHaveBeenCalledTimes(1);
    expect(store.value(descriptor.id, INSTALLATION_PREFERENCE_CONTEXT)()).toBe(
      true,
    );
  });

  it('contains thrown legacy reads as value-free recoverable failure', async () => {
    const descriptor = booleanPreference();
    const thrown = 'read exposed access_token=thrown-secret';
    const adapter: PreferenceStorageAdapter = {
      read: (request): ReturnType<PreferenceStorageAdapter['read']> => {
        if (request.key === CURRENT_KEY) return of({ kind: 'missing' });
        throw new Error(thrown);
      },
      write: () => of({ kind: 'completed' }),
    };
    const store = setup([descriptor], adapter);

    const result = await firstValueFrom(
      store.hydrate(INSTALLATION_PREFERENCE_CONTEXT),
    );

    expect(result).toEqual({
      kind: 'partial',
      hydrated: 0,
      failures: [
        {
          preferenceId: descriptor.id,
          recovery: 'retry-storage',
          diagnostic: { code: 'preference-storage-read-failed' },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(thrown);
  });

  it('keeps a legacy value private when its current-key write throws', async () => {
    const descriptor = booleanPreference();
    const persisted = 'false';
    const thrown = 'write exposed access_token=thrown-secret';
    const adapter: PreferenceStorageAdapter = {
      read: (request) =>
        of(
          request.key === FIRST_LEGACY_KEY
            ? { kind: 'found', payload: persisted }
            : { kind: 'missing' },
        ),
      write: () => throwError(() => new Error(thrown)),
    };
    const store = setup([descriptor], adapter);

    const result = await firstValueFrom(
      store.hydrate(INSTALLATION_PREFERENCE_CONTEXT),
    );

    expect(result).toEqual({
      kind: 'partial',
      hydrated: 0,
      failures: [
        {
          preferenceId: descriptor.id,
          recovery: 'retry-storage',
          diagnostic: { code: 'preference-storage-write-failed' },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(persisted);
    expect(JSON.stringify(result)).not.toContain(thrown);
    expect(store.value(descriptor.id, INSTALLATION_PREFERENCE_CONTEXT)()).toBe(
      true,
    );
  });

  it('contains thrown current writes without publishing or exposing the candidate', async () => {
    const candidate = 'candidate-secret';
    const thrown = 'write exposed access_token=thrown-secret';
    const descriptor = definePreference({
      ...booleanPreference(),
      id: 'trust.test.secret',
      defaultValue: 'safe-default',
      sensitivity: 'secret',
      storage: 'secure-store',
      export: 'excluded',
      editor: { kind: 'none' },
      persistence: {
        key: 'trust.test.secret.v1',
        legacyKeys: ['trust.test.secret'],
        migration: {
          currentVersion: 1,
          migrate: (stored) =>
            typeof stored.value === 'string'
              ? { kind: 'accepted', value: stored.value }
              : {
                  kind: 'rejected',
                  diagnostic: { code: 'expected-secret-string' },
                },
        },
      },
      validate: (value) =>
        typeof value === 'string'
          ? { kind: 'accepted', value }
          : {
              kind: 'rejected',
              diagnostic: { code: 'expected-secret-string' },
            },
    });
    const store = setup([descriptor], {
      read: () => of({ kind: 'missing' }),
      write: () => {
        throw new Error(thrown);
      },
    });

    const result = await firstValueFrom(
      store.set(descriptor.id, INSTALLATION_PREFERENCE_CONTEXT, candidate),
    );

    expect(result).toEqual({
      kind: 'unavailable',
      recovery: 'retry-storage',
      diagnostic: { code: 'preference-storage-write-failed' },
    });
    expect(JSON.stringify(result)).not.toContain(candidate);
    expect(JSON.stringify(result)).not.toContain(thrown);
    expect(store.value(descriptor.id, INSTALLATION_PREFERENCE_CONTEXT)()).toBe(
      'safe-default',
    );
  });

  it.each([
    ['the current key', [CURRENT_KEY]],
    ['a duplicate legacy key', [FIRST_LEGACY_KEY, FIRST_LEGACY_KEY]],
    ['an empty legacy key', ['']],
  ])('rejects %s in the legacy-key declaration', (_label, legacyKeys) => {
    const descriptor = booleanPreference({
      persistence: {
        key: CURRENT_KEY,
        legacyKeys,
        migration: { currentVersion: 1, migrate: booleanMigration },
      },
    });

    expect(() => setup([descriptor], mapAdapter(new Map()))).toThrowError(
      /legacy persistence keys/,
    );
  });
});
