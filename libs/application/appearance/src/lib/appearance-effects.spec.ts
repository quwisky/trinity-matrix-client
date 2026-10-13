import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppearancePreferences,
  provideAppearancePreferences,
  type AppearanceValue,
} from './appearance-preferences';
import {
  APPEARANCE_DOCUMENT_ADAPTER,
  type AppearanceDocumentAdapter,
} from './appearance-document.adapter';
import { AppearanceEffects } from './appearance-effects';
import {
  APPEARANCE_NATIVE_CHROME_ADAPTER,
  type AppearanceNativeChromeAdapter,
} from './appearance-native-chrome.adapter';
import {
  APPEARANCE_SYSTEM_MODE_SOURCE,
  type AppearanceSystemModeSource,
} from './appearance-system-mode.source';
import {
  INSTALLATION_PREFERENCE_CONTEXT,
  PREFERENCE_STORAGE_ADAPTER,
  PreferenceStoreService,
  type PreferenceStorageAdapter,
} from '@trinity/runtime/preferences';
import { MODE_PREFERENCE } from './design-system-appearance-preferences';

const defaults = (): AppearanceValue => ({
  mode: 'system',
  theme: 'trinity',
  textSize: 'default',
  density: 'cosy',
  roomList: 'rich',
  codeSize: 'default',
  codeLinePresentation: 'auto',
});

describe('AppearanceEffects', () => {
  it('updates document and native projections only for relevant committed changes', () => {
    const committed = signal(defaults());
    const systemMode = new BehaviorSubject<'light' | 'dark'>('light');
    const documentAdapter: AppearanceDocumentAdapter = {
      apply: vi.fn(),
    };
    const nativeAdapter: AppearanceNativeChromeAdapter = {
      apply: vi.fn(() => of(void 0)),
    };
    configureEffects(
      { value: committed.asReadonly() },
      systemMode,
      documentAdapter,
      nativeAdapter,
    );
    const effects = TestBed.inject(AppearanceEffects);

    expect(effects.resolved()).toBeUndefined();
    const subscription = effects.run().subscribe();
    TestBed.flushEffects();
    expect(effects.resolved()?.mode).toBe('light');
    expect(documentAdapter.apply).toHaveBeenCalledTimes(1);
    expect(nativeAdapter.apply).toHaveBeenLastCalledWith({ mode: 'light' });

    systemMode.next('dark');
    expect(effects.resolved()?.mode).toBe('dark');
    expect(documentAdapter.apply).toHaveBeenCalledTimes(2);
    expect(nativeAdapter.apply).toHaveBeenLastCalledWith({ mode: 'dark' });

    committed.set({ ...committed(), mode: 'light' });
    TestBed.flushEffects();
    expect(effects.resolved()?.mode).toBe('light');
    expect(documentAdapter.apply).toHaveBeenCalledTimes(3);
    expect(nativeAdapter.apply).toHaveBeenCalledTimes(3);

    const fixedAppearance = effects.resolved();
    systemMode.next('light');
    expect(effects.resolved()).toBe(fixedAppearance);
    expect(documentAdapter.apply).toHaveBeenCalledTimes(3);
    expect(nativeAdapter.apply).toHaveBeenCalledTimes(3);

    committed.set({ ...committed(), theme: 'amethyst' });
    TestBed.flushEffects();
    expect(documentAdapter.apply).toHaveBeenCalledTimes(4);
    expect(nativeAdapter.apply).toHaveBeenCalledTimes(3);

    subscription.unsubscribe();
    committed.set({ ...committed(), mode: 'dark' });
    TestBed.flushEffects();
    expect(documentAdapter.apply).toHaveBeenCalledTimes(4);
  });

  it('keeps the document effect alive without a native adapter', () => {
    const committed = signal(defaults());
    const systemMode = new BehaviorSubject<'light' | 'dark'>('light');
    const documentAdapter: AppearanceDocumentAdapter = {
      apply: vi.fn(),
    };
    configureEffects(
      { value: committed.asReadonly() },
      systemMode,
      documentAdapter,
    );
    const effects = TestBed.inject(AppearanceEffects);

    const subscription = effects.run().subscribe();
    TestBed.flushEffects();
    systemMode.next('dark');

    expect(effects.resolved()?.mode).toBe('dark');
    expect(documentAdapter.apply).toHaveBeenCalledTimes(2);
    subscription.unsubscribe();
  });

  it('keeps the document effect alive when native chrome rejects a command', () => {
    const committed = signal(defaults());
    const systemMode = new BehaviorSubject<'light' | 'dark'>('light');
    const documentAdapter: AppearanceDocumentAdapter = {
      apply: vi.fn(),
    };
    const nativeAdapter: AppearanceNativeChromeAdapter = {
      apply: vi.fn(() => throwError(() => new Error('native unavailable'))),
    };
    configureEffects(
      { value: committed.asReadonly() },
      systemMode,
      documentAdapter,
      nativeAdapter,
    );
    const effects = TestBed.inject(AppearanceEffects);

    const subscription = effects.run().subscribe();
    TestBed.flushEffects();
    systemMode.next('dark');

    expect(effects.resolved()?.mode).toBe('dark');
    expect(documentAdapter.apply).toHaveBeenCalledTimes(2);
    expect(nativeAdapter.apply).toHaveBeenCalledTimes(2);
    subscription.unsubscribe();
  });

  it('never resolves or renders an uncommitted persistence failure', async () => {
    const systemMode = new BehaviorSubject<'light' | 'dark'>('light');
    const documentAdapter: AppearanceDocumentAdapter = {
      apply: vi.fn(),
    };
    const nativeAdapter: AppearanceNativeChromeAdapter = {
      apply: vi.fn(() => of(void 0)),
    };
    const storage: PreferenceStorageAdapter = {
      read: () => of({ kind: 'missing' }),
      write: () =>
        of({
          kind: 'unavailable',
          diagnostic: { code: 'test-write-failed' },
        }),
    };
    TestBed.configureTestingModule({
      providers: [
        provideAppearancePreferences(),
        { provide: PREFERENCE_STORAGE_ADAPTER, useValue: storage },
        {
          provide: APPEARANCE_SYSTEM_MODE_SOURCE,
          useValue: {
            observe: () => systemMode,
          } satisfies AppearanceSystemModeSource,
        },
        { provide: APPEARANCE_DOCUMENT_ADAPTER, useValue: documentAdapter },
        { provide: APPEARANCE_NATIVE_CHROME_ADAPTER, useValue: nativeAdapter },
      ],
    });
    const appearance = TestBed.inject(AppearancePreferences);
    await firstValueFrom(appearance.hydrate());
    const effects = TestBed.inject(AppearanceEffects);
    const subscription = effects.run().subscribe();
    TestBed.flushEffects();

    const outcome = await firstValueFrom(
      TestBed.inject(PreferenceStoreService).setPreference(
        MODE_PREFERENCE,
        INSTALLATION_PREFERENCE_CONTEXT,
        'dark',
      ),
    );
    TestBed.flushEffects();

    expect(outcome).toEqual({
      kind: 'unavailable',
      recovery: 'retry-storage',
      diagnostic: { code: 'preference-storage-write-failed' },
    });
    expect(appearance.value().mode).toBe('system');
    expect(effects.resolved()?.mode).toBe('light');
    expect(documentAdapter.apply).toHaveBeenCalledTimes(1);
    expect(nativeAdapter.apply).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
  });
});

describe('AppearanceEffects.applySaved', () => {
  const root = document.documentElement;

  afterEach(() => {
    vi.unstubAllGlobals();
    root.classList.remove('dark');
    root.removeAttribute('data-theme');
    root.removeAttribute('data-density');
    root.style.removeProperty('font-size');
    TestBed.resetTestingModule();
  });

  it('applies saved dark Mode and Theme before hydration, writing nothing', async () => {
    const storage = savedStorage({
      'trinity.appearance.mode': '{"version":1,"value":"dark"}',
      'trinity.appearance.theme': '{"version":2,"value":"amethyst"}',
      'trinity.appearance.density': '{"version":1,"value":"compact"}',
    });
    const effects = configureSaved(storage, 'light');

    await firstValueFrom(effects.applySaved(), { defaultValue: undefined });

    expect(root.classList.contains('dark')).toBe(true);
    expect(root.getAttribute('data-theme')).toBe('amethyst');
    expect(root.getAttribute('data-density')).toBe('compact');
    expect(storage.write).not.toHaveBeenCalled();
    expect(TestBed.inject(AppearancePreferences).value().mode).toBe('system');
    expect(effects.resolved()).toBeUndefined();
  });

  it('follows a dark system colour scheme when the saved Mode is System', async () => {
    const storage = savedStorage({
      'trinity.appearance.mode': '{"version":1,"value":"system"}',
    });
    const effects = configureSaved(storage, 'dark');

    await firstValueFrom(effects.applySaved(), { defaultValue: undefined });

    expect(root.classList.contains('dark')).toBe(true);
  });

  it('stays light when the saved Mode is Light on a dark system', async () => {
    root.classList.add('dark');
    const storage = savedStorage({ 'trinity.theme': '"light"' });
    const effects = configureSaved(storage, 'dark');

    await firstValueFrom(effects.applySaved(), { defaultValue: undefined });

    expect(root.classList.contains('dark')).toBe(false);
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('falls back to defaults for unreadable or invalid values without throwing', async () => {
    const storage: PreferenceStorageAdapter & {
      write: ReturnType<typeof vi.fn>;
    } = {
      read: (request) => {
        if (request.key === 'trinity.appearance.mode') {
          throw new Error('storage blew up');
        }
        return of({ kind: 'found', payload: '{"version":1,"value":"huge"}' });
      },
      write: vi.fn(() => of({ kind: 'completed' } as const)),
    };
    const effects = configureSaved(storage, 'light');

    await expect(
      firstValueFrom(effects.applySaved(), { defaultValue: undefined }),
    ).resolves.toBeUndefined();

    expect(root.classList.contains('dark')).toBe(false);
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(root.style.getPropertyValue('font-size')).toBe('');
    expect(storage.write).not.toHaveBeenCalled();
  });
});

function savedStorage(
  saved: Readonly<Record<string, string>>,
): PreferenceStorageAdapter & { write: ReturnType<typeof vi.fn> } {
  return {
    read: (request) =>
      of(
        Object.hasOwn(saved, request.key)
          ? ({ kind: 'found', payload: saved[request.key] } as const)
          : ({ kind: 'missing' } as const),
      ),
    write: vi.fn(() => of({ kind: 'completed' } as const)),
  };
}

/** Real Appearance owners over stubbed storage and a stubbed `prefers-color-scheme`. */
function configureSaved(
  storage: PreferenceStorageAdapter,
  system: 'light' | 'dark',
): AppearanceEffects {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: system === 'dark' && query === '(prefers-color-scheme: dark)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  TestBed.configureTestingModule({
    providers: [
      provideAppearancePreferences(),
      { provide: PREFERENCE_STORAGE_ADAPTER, useValue: storage },
    ],
  });
  return TestBed.inject(AppearanceEffects);
}

function configureEffects(
  appearance: Pick<AppearancePreferences, 'value'>,
  systemMode: BehaviorSubject<'light' | 'dark'>,
  documentAdapter: AppearanceDocumentAdapter,
  nativeAdapter?: AppearanceNativeChromeAdapter,
): void {
  TestBed.configureTestingModule({
    providers: [
      { provide: AppearancePreferences, useValue: appearance },
      {
        provide: APPEARANCE_SYSTEM_MODE_SOURCE,
        useValue: {
          observe: () => systemMode,
        } satisfies AppearanceSystemModeSource,
      },
      { provide: APPEARANCE_DOCUMENT_ADAPTER, useValue: documentAdapter },
      ...(nativeAdapter
        ? [
            {
              provide: APPEARANCE_NATIVE_CHROME_ADAPTER,
              useValue: nativeAdapter,
            },
          ]
        : []),
    ],
  });
}
