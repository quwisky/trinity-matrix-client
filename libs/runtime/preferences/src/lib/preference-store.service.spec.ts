import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PreferenceCatalogService,
  providePreferenceDescriptors,
} from './preference-catalog.service';
import {
  definePreference,
  type PreferenceContext,
  type PreferenceDescriptor,
  type PreferenceValue,
  type StoredPreference,
} from './preference.models';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceStorageAdapter,
  type PreferenceStorageRequest,
} from './preference-storage';
import { PreferenceStoreService } from './preference-store.service';

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
      key: 'test.flag',
      migration: {
        currentVersion: 1,
        migrate: booleanMigration,
      },
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

function booleanMigration(
  stored: StoredPreference,
): ReturnType<PreferenceDescriptor<boolean>['validate']> {
  if (
    (stored.version === 0 || stored.version === 1) &&
    typeof stored.value === 'boolean'
  ) {
    return { kind: 'accepted', value: stored.value };
  }
  return {
    kind: 'rejected',
    diagnostic: { code: 'boolean-migration-rejected' },
  };
}

function setup(
  descriptors: readonly PreferenceDescriptor<PreferenceValue>[],
  adapter: PreferenceStorageAdapter,
) {
  TestBed.configureTestingModule({
    providers: [
      providePreferenceDescriptors(() => descriptors),
      { provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter },
    ],
  });
  return TestBed.inject(PreferenceStoreService);
}

describe('PreferenceStoreService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lets a capability facade use its owned descriptor without application catalog wiring', async () => {
    const descriptor = booleanPreference();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PREFERENCE_STORAGE_ADAPTER,
          useValue: {
            read: () => of({ kind: 'missing' }),
            write: () => of({ kind: 'completed' }),
          } satisfies PreferenceStorageAdapter,
        },
      ],
    });
    const store = TestBed.inject(PreferenceStoreService);

    expect(store.valueFor(descriptor, { kind: 'installation' })()).toBe(true);
    await expect(
      firstValueFrom(
        store.setPreference(descriptor, { kind: 'installation' }, false),
      ),
    ).resolves.toEqual({ kind: 'completed' });
    expect(store.valueFor(descriptor, { kind: 'installation' })()).toBe(false);
  });

  it('hydrates defaults without writing when a preference is absent', async () => {
    const descriptor = booleanPreference();
    const adapter: PreferenceStorageAdapter = {
      read: vi.fn(() => of({ kind: 'missing' } as const)),
      write: vi.fn(() => of({ kind: 'completed' } as const)),
    };
    const store = setup([descriptor], adapter);

    await expect(
      firstValueFrom(store.hydrate({ kind: 'installation' })),
    ).resolves.toEqual({ kind: 'ready', hydrated: 1 });
    expect(store.value(descriptor.id, { kind: 'installation' })()).toBe(true);
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('keeps selective hydration cold and reports unknown ids as typed recovery', async () => {
    const descriptor = booleanPreference();
    const read = vi.fn(() => of({ kind: 'missing' } as const));
    const store = setup([descriptor], {
      read,
      write: () => of({ kind: 'completed' }),
    });

    const hydration = store.hydrate({ kind: 'installation' }, [
      descriptor.id,
      'conversations.unknown',
    ]);

    expect(read).not.toHaveBeenCalled();
    await expect(firstValueFrom(hydration)).resolves.toEqual({
      kind: 'partial',
      hydrated: 1,
      failures: [
        {
          preferenceId: 'conversations.unknown',
          recovery: 'fix-value',
          diagnostic: { code: 'preference-not-registered' },
        },
      ],
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('migrates a legacy value and persists the current envelope', async () => {
    const descriptor = booleanPreference();
    const write = vi.fn(() => of({ kind: 'completed' } as const));
    const store = setup([descriptor], {
      read: () => of({ kind: 'found', payload: 'false' }),
      write,
    });

    await expect(
      firstValueFrom(store.hydrate({ kind: 'installation' })),
    ).resolves.toEqual({ kind: 'ready', hydrated: 1 });
    expect(store.value(descriptor.id, { kind: 'installation' })()).toBe(false);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ payload: '{"version":1,"value":false}' }),
    );
  });

  it('keeps account and conversation scopes distinct while switching context', async () => {
    const accountPreference = booleanPreference({
      id: 'accounts.test.flag',
      owner: 'accounts',
      scope: 'account',
    });
    const conversationPreference = booleanPreference({
      id: 'conversations.test.flag',
      scope: 'conversation',
    });
    const values = new Map<string, string>();
    const key = (request: PreferenceStorageRequest) =>
      `${JSON.stringify(request.context)}:${request.key}`;
    const adapter: PreferenceStorageAdapter = {
      read: (request) =>
        of(
          values.has(key(request))
            ? { kind: 'found', payload: values.get(key(request))! }
            : { kind: 'missing' },
        ),
      write: (request) => {
        values.set(key(request), request.payload);
        return of({ kind: 'completed' });
      },
    };
    const store = setup([accountPreference, conversationPreference], adapter);
    const firstAccount: PreferenceContext = {
      kind: 'account',
      accountId: '@a:hs',
    };
    const secondAccount: PreferenceContext = {
      kind: 'account',
      accountId: '@b:hs',
    };
    const firstConversation: PreferenceContext = {
      kind: 'conversation',
      accountId: '@a:hs',
      conversationId: '!first:hs',
    };
    const secondConversation: PreferenceContext = {
      kind: 'conversation',
      accountId: '@a:hs',
      conversationId: '!second:hs',
    };

    await firstValueFrom(store.set(accountPreference.id, firstAccount, false));
    await firstValueFrom(
      store.set(conversationPreference.id, firstConversation, false),
    );
    await firstValueFrom(store.hydrate(secondAccount));
    await firstValueFrom(store.hydrate(secondConversation));

    expect(store.value(accountPreference.id, firstAccount)()).toBe(false);
    expect(store.value(accountPreference.id, secondAccount)()).toBe(true);
    expect(store.value(conversationPreference.id, firstConversation)()).toBe(
      false,
    );
    expect(store.value(conversationPreference.id, secondConversation)()).toBe(
      true,
    );
    expect(values.size).toBe(2);
  });

  it('rejects an invalid value before persistence', async () => {
    const descriptor = booleanPreference();
    const write = vi.fn(() => of({ kind: 'completed' } as const));
    const store = setup([descriptor], {
      read: () => of({ kind: 'missing' }),
      write,
    });

    await expect(
      firstValueFrom(
        store.set(descriptor.id, { kind: 'installation' }, 'not-a-boolean'),
      ),
    ).resolves.toEqual({
      kind: 'rejected',
      recovery: 'fix-value',
      diagnostic: { code: 'preference-validation-rejected' },
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps reset cold and rejects an unknown id as a typed outcome', async () => {
    const descriptor = booleanPreference();
    const write = vi.fn(() => of({ kind: 'completed' } as const));
    const store = setup([descriptor], {
      read: () => of({ kind: 'missing' }),
      write,
    });

    const unknownReset = store.reset('conversations.unknown', {
      kind: 'installation',
    });

    expect(write).not.toHaveBeenCalled();
    await expect(firstValueFrom(unknownReset)).resolves.toEqual({
      kind: 'rejected',
      recovery: 'fix-value',
      diagnostic: { code: 'preference-not-registered' },
    });
    expect(write).not.toHaveBeenCalled();

    await firstValueFrom(
      store.set(descriptor.id, { kind: 'installation' }, false),
    );
    write.mockClear();
    const knownReset = store.reset(descriptor.id, { kind: 'installation' });

    expect(store.value(descriptor.id, { kind: 'installation' })()).toBe(false);
    expect(write).not.toHaveBeenCalled();
    await expect(firstValueFrom(knownReset)).resolves.toEqual({
      kind: 'completed',
    });
    expect(store.value(descriptor.id, { kind: 'installation' })()).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('recovers only failed hydration entries through their declared defaults', async () => {
    const first = booleanPreference({ id: 'conversations.first' });
    const second = booleanPreference({
      id: 'conversations.second',
      persistence: {
        key: 'test.second',
        migration: {
          currentVersion: 1,
          migrate: booleanMigration,
        },
      },
    });
    const write = vi.fn(() => of({ kind: 'completed' } as const));
    const store = setup([first, second], {
      read: (request) =>
        of(
          request.key === 'test.second'
            ? { kind: 'found', payload: '{"version":1,"value":"bad"}' }
            : { kind: 'found', payload: '{"version":1,"value":false}' },
        ),
      write,
    });
    const hydration = await firstValueFrom(
      store.hydrate({ kind: 'installation' }),
    );
    if (hydration.kind !== 'partial') {
      throw new Error('Expected partial hydration.');
    }

    const recovery = await firstValueFrom(
      store.recoverHydration({ kind: 'installation' }, hydration.failures),
    );

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'test.second',
        payload: '{"version":1,"value":true}',
      }),
    );
    expect(recovery).toEqual({ kind: 'ready', hydrated: 1 });
    expect(store.value(first.id, { kind: 'installation' })()).toBe(false);
    expect(store.value(second.id, { kind: 'installation' })()).toBe(true);
  });

  it('keeps the current value and emits secret-safe recovery on persistence failure', async () => {
    const secret = 'do-not-leak-this-value';
    const descriptor = definePreference({
      ...booleanPreference(),
      id: 'trust.secret',
      defaultValue: secret,
      sensitivity: 'secret',
      storage: 'secure-store',
      export: 'excluded',
      editor: { kind: 'none' },
      validate: (value: unknown) =>
        typeof value === 'string'
          ? { kind: 'accepted' as const, value }
          : {
              kind: 'rejected' as const,
              diagnostic: { code: 'expected-string' },
            },
      persistence: {
        key: 'trust.secret',
        migration: {
          currentVersion: 1,
          migrate: (stored) =>
            typeof stored.value === 'string'
              ? { kind: 'accepted' as const, value: stored.value }
              : {
                  kind: 'rejected' as const,
                  diagnostic: { code: 'secret-migration-rejected' },
                },
        },
      },
    });
    const store = setup([descriptor], {
      read: () => of({ kind: 'missing' }),
      write: () =>
        of({
          kind: 'unavailable',
          diagnostic: { code: 'secure-store-unavailable' },
        }),
    });

    const result = await firstValueFrom(
      store.set(descriptor.id, { kind: 'installation' }, secret),
    );

    expect(result).toEqual({
      kind: 'unavailable',
      recovery: 'retry-storage',
      diagnostic: { code: 'preference-storage-write-failed' },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(store.value(descriptor.id, { kind: 'installation' })()).toBe(secret);
  });

  it('reports migration failure without including the hostile stored value', async () => {
    const secret = 'access_token=stored-secret';
    const descriptor = booleanPreference({
      persistence: {
        key: 'test.flag',
        migration: {
          currentVersion: 1,
          migrate: (stored) => ({
            kind: 'rejected',
            diagnostic: { code: String(stored.value) },
          }),
        },
      },
    });
    const store = setup([descriptor], {
      read: () => of({ kind: 'found', payload: secret }),
      write: () => of({ kind: 'completed' }),
    });

    const result = await firstValueFrom(
      store.hydrate({ kind: 'installation' }),
    );

    expect(result).toEqual({
      kind: 'partial',
      hydrated: 0,
      failures: [
        {
          preferenceId: descriptor.id,
          recovery: 'reset-preference',
          diagnostic: { code: 'preference-migration-rejected' },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('contains a throwing migration as typed, secret-safe recovery', async () => {
    const secret = 'access_token=stored-secret';
    const descriptor = booleanPreference({
      persistence: {
        key: 'test.flag',
        migration: {
          currentVersion: 1,
          migrate: () => {
            throw new Error(`hostile migration included ${secret}`);
          },
        },
      },
    });
    const store = setup([descriptor], {
      read: () => of({ kind: 'found', payload: secret }),
      write: () => of({ kind: 'completed' }),
    });

    const result = await firstValueFrom(
      store.hydrate({ kind: 'installation' }),
    );

    expect(result).toEqual({
      kind: 'partial',
      hydrated: 0,
      failures: [
        {
          preferenceId: descriptor.id,
          recovery: 'reset-preference',
          diagnostic: { code: 'preference-migration-rejected' },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('PreferenceCatalogService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('rejects a secret descriptor without protected storage and export exclusion', () => {
    const descriptor = booleanPreference({
      sensitivity: 'secret',
      storage: 'device-preferences',
      export: 'portable',
    });
    TestBed.configureTestingModule({
      providers: [providePreferenceDescriptors(() => [descriptor])],
    });

    expect(() => TestBed.inject(PreferenceCatalogService)).toThrowError(
      /secure-store storage and stay out of exports/,
    );
  });

  it('does not treat server-authoritative storage as secret storage', () => {
    const descriptor = booleanPreference({
      scope: 'server-authoritative',
      sensitivity: 'secret',
      storage: 'server-authoritative',
      export: 'excluded',
    });
    TestBed.configureTestingModule({
      providers: [providePreferenceDescriptors(() => [descriptor])],
    });

    expect(() => TestBed.inject(PreferenceCatalogService)).toThrowError(
      /must use secure-store storage/,
    );
  });

  it('requires server-authoritative scope to stay on its distinct storage policy', () => {
    const descriptor = booleanPreference({
      scope: 'server-authoritative',
      storage: 'device-preferences',
    });
    TestBed.configureTestingModule({
      providers: [providePreferenceDescriptors(() => [descriptor])],
    });

    expect(() => TestBed.inject(PreferenceCatalogService)).toThrowError(
      /needs server-authoritative storage/,
    );
  });
});
