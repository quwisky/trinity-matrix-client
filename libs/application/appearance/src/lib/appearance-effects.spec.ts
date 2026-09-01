import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
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

    const subscription = effects.run().subscribe();
    TestBed.flushEffects();
    expect(effects.resolved().mode).toBe('light');
    expect(documentAdapter.apply).toHaveBeenCalledTimes(1);
    expect(nativeAdapter.apply).toHaveBeenLastCalledWith({ mode: 'light' });

    systemMode.next('dark');
    expect(effects.resolved().mode).toBe('dark');
    expect(documentAdapter.apply).toHaveBeenCalledTimes(2);
    expect(nativeAdapter.apply).toHaveBeenLastCalledWith({ mode: 'dark' });

    committed.set({ ...committed(), mode: 'light' });
    TestBed.flushEffects();
    expect(effects.resolved().mode).toBe('light');
    expect(documentAdapter.apply).toHaveBeenCalledTimes(3);
    expect(nativeAdapter.apply).toHaveBeenCalledTimes(3);

    systemMode.next('light');
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
    expect(effects.resolved().mode).toBe('light');
    expect(documentAdapter.apply).toHaveBeenCalledTimes(1);
    expect(nativeAdapter.apply).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
  });
});

function configureEffects(
  appearance: Pick<AppearancePreferences, 'value'>,
  systemMode: BehaviorSubject<'light' | 'dark'>,
  documentAdapter: AppearanceDocumentAdapter,
  nativeAdapter: AppearanceNativeChromeAdapter,
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
      { provide: APPEARANCE_NATIVE_CHROME_ADAPTER, useValue: nativeAdapter },
    ],
  });
}
