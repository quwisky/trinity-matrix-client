import {
  Injectable,
  computed,
  inject,
  makeEnvironmentProviders,
  type Signal,
} from '@angular/core';
import {
  CODE_LINE_PRESENTATION_PREFERENCE,
  CODE_SIZE_PREFERENCE,
  CONVERSATION_APPEARANCE_PREFERENCE_DESCRIPTORS,
  provideConversationAppearancePreferences,
  type CodeLinePresentation,
  type CodeSize,
} from '@trinity/data-access/timeline';
import {
  INSTALLATION_PREFERENCE_CONTEXT,
  PreferenceStoreService,
  type PreferenceDescriptor,
  type PreferenceFailure,
  type PreferenceState,
  type PreferenceValue,
} from '@trinity/runtime/preferences';
import type { ThemeId, ThemeMode } from '@trinity/theme-foundation';
import { map, type Observable } from 'rxjs';
import {
  DENSITY_PREFERENCE,
  DESIGN_SYSTEM_APPEARANCE_PREFERENCE_DESCRIPTORS,
  MODE_PREFERENCE,
  TEXT_SIZE_PREFERENCE,
  THEME_PREFERENCE,
  provideDesignSystemAppearancePreferences,
  type AppearanceDensity,
  type TextSize,
} from './design-system-appearance-preferences';

export const APPEARANCE_PREFERENCE_DESCRIPTORS: readonly PreferenceDescriptor<PreferenceValue>[] =
  [
    ...DESIGN_SYSTEM_APPEARANCE_PREFERENCE_DESCRIPTORS,
    ...CONVERSATION_APPEARANCE_PREFERENCE_DESCRIPTORS,
  ];

export interface AppearanceValue {
  readonly mode: ThemeMode;
  readonly theme: ThemeId;
  readonly textSize: TextSize;
  readonly density: AppearanceDensity;
  readonly codeSize: CodeSize;
  readonly codeLinePresentation: CodeLinePresentation;
}

export interface AppearanceAxis<T extends PreferenceValue> {
  readonly descriptor: PreferenceDescriptor<T>;
  readonly state: Signal<PreferenceState<T>>;
  readonly value: Signal<T>;
}

export interface AppearanceStartupWarning {
  readonly code: 'appearance-preference-hydration-partial';
  readonly recovery: 'reset-preferences';
}

export type AppearanceHydrationOutcome =
  | { readonly kind: 'ready'; readonly hydrated: 6 }
  | {
      readonly kind: 'partial';
      readonly hydrated: number;
      readonly failures: readonly PreferenceFailure[];
      readonly warning: AppearanceStartupWarning;
    };

/**
 * Application-level read model over six capability-owned preference cells.
 *
 * Persistence remains in PreferenceStoreService and in each descriptor. This projection only
 * groups their committed values, preserves per-axis failure state, and reduces any partial
 * hydration to one warning for Application Runtime.
 */
@Injectable({ providedIn: 'root' })
export class AppearancePreferences {
  private readonly preferences = inject(PreferenceStoreService);

  readonly axes = Object.freeze({
    mode: this.axis(MODE_PREFERENCE),
    theme: this.axis(THEME_PREFERENCE),
    textSize: this.axis(TEXT_SIZE_PREFERENCE),
    density: this.axis(DENSITY_PREFERENCE),
    codeSize: this.axis(CODE_SIZE_PREFERENCE),
    codeLinePresentation: this.axis(CODE_LINE_PRESENTATION_PREFERENCE),
  });

  readonly value = computed<AppearanceValue>(() => ({
    mode: this.axes.mode.value(),
    theme: this.axes.theme.value(),
    textSize: this.axes.textSize.value(),
    density: this.axes.density.value(),
    codeSize: this.axes.codeSize.value(),
    codeLinePresentation: this.axes.codeLinePresentation.value(),
  }));

  hydrate(): Observable<AppearanceHydrationOutcome> {
    return this.preferences
      .hydrateDescriptors(
        INSTALLATION_PREFERENCE_CONTEXT,
        APPEARANCE_PREFERENCE_DESCRIPTORS,
      )
      .pipe(
        map((outcome): AppearanceHydrationOutcome =>
          outcome.kind === 'ready'
            ? { kind: 'ready', hydrated: 6 }
            : {
                ...outcome,
                warning: {
                  code: 'appearance-preference-hydration-partial',
                  recovery: 'reset-preferences',
                },
              },
        ),
      );
  }

  private axis<T extends PreferenceValue>(
    descriptor: PreferenceDescriptor<T>,
  ): AppearanceAxis<T> {
    const state = this.preferences.stateFor(
      descriptor,
      INSTALLATION_PREFERENCE_CONTEXT,
    );
    return Object.freeze({
      descriptor,
      state,
      value: computed(() => state().value),
    });
  }
}

/** Contributes all six descriptors without moving their capability ownership. */
export function provideAppearancePreferences() {
  return makeEnvironmentProviders([
    provideDesignSystemAppearancePreferences(),
    provideConversationAppearancePreferences(),
  ]);
}
