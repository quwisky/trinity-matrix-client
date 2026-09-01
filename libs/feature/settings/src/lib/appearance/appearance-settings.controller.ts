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
import type { PreferenceFailure } from '@trinity/runtime/preferences';
import { Subject, concat, defer, exhaustMap, finalize, merge, tap } from 'rxjs';

export type AppearanceAxisKey = keyof AppearancePreferences['axes'];

interface AppearanceAttempt {
  readonly busy: boolean;
  readonly failed: boolean;
  readonly hasCandidate: boolean;
  readonly candidate?: unknown;
}

const IDLE_ATTEMPT: AppearanceAttempt = Object.freeze({
  busy: false,
  failed: false,
  hasCandidate: false,
});

/**
 * Screen-scoped command and recovery model for the six Appearance axes.
 *
 * The screen temporarily starts hydration and projection while the Appearance migration is
 * split across tickets. Application Runtime takes over that lifetime in #387; controls still
 * depend only on this model and descriptor-backed commands.
 */
@Injectable()
export class AppearanceSettingsController {
  private readonly appearance = inject(AppearancePreferences);
  private readonly effects = inject(AppearanceEffects);
  private readonly destroyRef = inject(DestroyRef);
  private readonly hydrationRecoveryRequests = new Subject<void>();
  private hydrationFailures: readonly PreferenceFailure[] = [];
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
  private readonly _hydrationWarning = signal<AppearanceStartupWarning | null>(
    null,
  );

  readonly axes = this.appearance.axes;
  readonly value = this.appearance.value;
  readonly resolved = this.effects.resolved;
  readonly hydrationBusy = this._hydrationBusy.asReadonly();
  readonly hydrationWarning = this._hydrationWarning.asReadonly();
  readonly status = Object.freeze({
    mode: this.statusFor('mode'),
    theme: this.statusFor('theme'),
    textSize: this.statusFor('textSize'),
    density: this.statusFor('density'),
    codeSize: this.statusFor('codeSize'),
    codeLinePresentation: this.statusFor('codeLinePresentation'),
  });

  constructor() {
    concat(
      this.hydrate(),
      merge(
        this.effects.run(),
        this.hydrationRecoveryRequests.pipe(
          exhaustMap(() => this.hydrate(true)),
        ),
      ),
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  update(key: AppearanceAxisKey, candidate: unknown): void {
    if (this.attempts()[key].busy) {
      return;
    }
    this.patchAttempt(key, {
      busy: true,
      failed: false,
      hasCandidate: true,
      candidate,
    });
    this.axes[key]
      .set(candidate)
      .pipe(
        finalize(() => this.patchAttempt(key, { busy: false })),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (outcome) => {
          if (outcome.kind === 'completed') {
            this.patchAttempt(key, {
              failed: false,
              hasCandidate: false,
              candidate: undefined,
            });
          } else {
            this.patchAttempt(key, { failed: true });
          }
        },
        error: () => this.patchAttempt(key, { failed: true }),
      });
  }

  retry(key: AppearanceAxisKey): void {
    const attempt = this.attempts()[key];
    if (!attempt.busy && attempt.hasCandidate) {
      this.update(key, attempt.candidate);
    }
  }

  recoverHydration(): void {
    if (!this._hydrationBusy()) {
      this.hydrationRecoveryRequests.next();
    }
  }

  private hydrate(recover = false) {
    return defer(() => {
      this._hydrationBusy.set(true);
      const hydration =
        recover && this.hydrationFailures.length > 0
          ? this.appearance.recoverHydration(this.hydrationFailures)
          : this.appearance.hydrate();
      return hydration.pipe(
        tap((outcome) => {
          this.hydrationFailures =
            outcome.kind === 'partial' ? outcome.failures : [];
          this._hydrationWarning.set(
            outcome.kind === 'partial' ? outcome.warning : null,
          );
        }),
        finalize(() => this._hydrationBusy.set(false)),
      );
    });
  }

  private statusFor(key: AppearanceAxisKey) {
    return Object.freeze({
      busy: computed(() => this.attempts()[key].busy),
      failed: computed(() => this.attempts()[key].failed),
    });
  }

  private patchAttempt(
    key: AppearanceAxisKey,
    patch: Partial<AppearanceAttempt>,
  ): void {
    this.attempts.update((attempts) => ({
      ...attempts,
      [key]: { ...attempts[key], ...patch },
    }));
  }
}
