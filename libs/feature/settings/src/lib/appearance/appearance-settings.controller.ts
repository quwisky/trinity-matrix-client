import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AppearanceEffects,
  AppearancePreferences,
  type AppearanceStartupWarning,
} from '@trinity/application/appearance';
import { defer, finalize } from 'rxjs';

export type AppearanceAxisKey = keyof AppearancePreferences['axes'];

type AppearanceAttempt =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly candidate: unknown }
  | { readonly kind: 'failed'; readonly candidate: unknown };

const IDLE_ATTEMPT: AppearanceAttempt = Object.freeze({ kind: 'idle' });

/**
 * Screen-scoped command and recovery model for the six Appearance axes.
 *
 * Application Runtime owns hydration and projection. This routed model only owns user
 * commands and recovery initiated from the Appearance screen.
 */
@Injectable()
export class AppearanceSettingsController {
  private readonly appearance = inject(AppearancePreferences);
  private readonly effects = inject(AppearanceEffects);
  private readonly destroyRef = inject(DestroyRef);
  private readonly attempts = signal<
    Readonly<Record<AppearanceAxisKey, AppearanceAttempt>>
  >({
    mode: IDLE_ATTEMPT,
    theme: IDLE_ATTEMPT,
    textSize: IDLE_ATTEMPT,
    density: IDLE_ATTEMPT,
    codeSize: IDLE_ATTEMPT,
    codeLinePresentation: IDLE_ATTEMPT,
  });
  private readonly _hydrationBusy = signal(false);
  private readonly _hydrationWarning =
    computed<AppearanceStartupWarning | null>(() => {
      const hydration = this.appearance.hydration();
      return hydration?.kind === 'partial' ? hydration.warning : null;
    });

  readonly axes = this.appearance.axes;
  readonly value = this.appearance.value;
  readonly resolved = this.effects.resolved;
  readonly hydrationBusy = this._hydrationBusy.asReadonly();
  readonly hydrationWarning = this._hydrationWarning;
  readonly status = Object.freeze({
    mode: this.statusFor('mode'),
    theme: this.statusFor('theme'),
    textSize: this.statusFor('textSize'),
    density: this.statusFor('density'),
    codeSize: this.statusFor('codeSize'),
    codeLinePresentation: this.statusFor('codeLinePresentation'),
  });

  update(key: AppearanceAxisKey, candidate: unknown): void {
    if (this._hydrationBusy() || this.attempts()[key].kind === 'pending') {
      return;
    }
    this.setAttempt(key, { kind: 'pending', candidate });
    this.axes[key]
      .set(candidate)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (outcome) => {
          if (outcome.kind === 'completed') {
            this.setAttempt(key, IDLE_ATTEMPT);
          } else {
            this.setAttempt(key, { kind: 'failed', candidate });
          }
        },
        error: () => this.setAttempt(key, { kind: 'failed', candidate }),
      });
  }

  retry(key: AppearanceAxisKey): void {
    const attempt = this.attempts()[key];
    if (attempt.kind === 'failed') {
      this.update(key, attempt.candidate);
    }
  }

  recoverHydration(): void {
    const hydration = this.appearance.hydration();
    if (!this._hydrationBusy() && hydration?.kind === 'partial') {
      defer(() => {
        this._hydrationBusy.set(true);
        return this.appearance
          .recoverHydration(hydration.failures)
          .pipe(finalize(() => this._hydrationBusy.set(false)));
      })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe();
    }
  }

  private statusFor(key: AppearanceAxisKey) {
    return Object.freeze({
      busy: computed(() => this.attempts()[key].kind === 'pending'),
      failed: computed(() => this.attempts()[key].kind === 'failed'),
    });
  }

  private setAttempt(key: AppearanceAxisKey, attempt: AppearanceAttempt): void {
    this.attempts.update((attempts) => ({
      ...attempts,
      [key]: attempt,
    }));
  }
}
