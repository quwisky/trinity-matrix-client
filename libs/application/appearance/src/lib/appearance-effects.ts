import { Injectable, inject, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  EMPTY,
  catchError,
  combineLatest,
  concatMap,
  defer,
  distinctUntilChanged,
  ignoreElements,
  map,
  merge,
  of,
  shareReplay,
  tap,
  type Observable,
} from 'rxjs';
import { AppearancePreferences } from './appearance-preferences';
import { APPEARANCE_DOCUMENT_ADAPTER } from './appearance-document.adapter';
import { APPEARANCE_NATIVE_CHROME_ADAPTER } from './appearance-native-chrome.adapter';
import {
  resolveAppearance,
  sameResolvedAppearance,
  toNativeChromeAppearance,
  type ResolvedAppearance,
} from './appearance-resolution';
import { APPEARANCE_SYSTEM_MODE_SOURCE } from './appearance-system-mode.source';

/**
 * Session-long imperative projection of committed Appearance state.
 *
 * The stream is cold: Application Runtime will own its one subscription in the migration
 * ticket. Preference commands publish only after persistence succeeds, so this layer never
 * sees or renders an uncommitted candidate.
 */
@Injectable({ providedIn: 'root' })
export class AppearanceEffects {
  private readonly preferences = inject(AppearancePreferences);
  private readonly documentAdapter = inject(APPEARANCE_DOCUMENT_ADAPTER);
  private readonly systemMode = inject(APPEARANCE_SYSTEM_MODE_SOURCE);
  private readonly nativeChrome = inject(APPEARANCE_NATIVE_CHROME_ADAPTER, {
    optional: true,
  });
  private readonly committed = toObservable(this.preferences.value);
  private readonly _resolved = signal<ResolvedAppearance | undefined>(
    undefined,
  );

  /** Last Appearance projected by the effect lifetime, or undefined before it first runs. */
  readonly resolved = this._resolved.asReadonly();

  run(): Observable<never> {
    return defer(() => {
      const resolved = combineLatest([
        this.committed,
        this.systemMode.observe(),
      ]).pipe(
        map(([committed, systemMode]) =>
          resolveAppearance(committed, systemMode),
        ),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
      const documentEffects = resolved.pipe(
        tap((appearance) => {
          const previous = this._resolved();
          if (!previous || !sameResolvedAppearance(previous, appearance)) {
            this._resolved.set(appearance);
          }
          // ThemeService remains an earlier document-root listener until #387. Reasserting
          // the committed carriers after each OS event prevents that temporary co-owner from
          // overriding a fixed Mode; resolved state and native chrome remain deduplicated.
          this.documentAdapter.apply(appearance);
        }),
        ignoreElements(),
      );
      const nativeChromeEffects = resolved.pipe(
        map(toNativeChromeAppearance),
        distinctUntilChanged((left, right) => left.mode === right.mode),
        concatMap((appearance) =>
          defer(() =>
            this.nativeChrome
              ? this.nativeChrome.apply(appearance)
              : of(void 0),
          ).pipe(catchError(() => EMPTY)),
        ),
        ignoreElements(),
      );

      return merge(documentEffects, nativeChromeEffects);
    });
  }
}
