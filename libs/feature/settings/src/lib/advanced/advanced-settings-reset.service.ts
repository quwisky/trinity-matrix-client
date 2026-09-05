import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import {
  AppConfigService,
  type ConfigResetOutcome,
} from '@trinity/platform-native';
import { EMPTY, finalize, switchMap, type Observable } from 'rxjs';
import {
  RESET_CONFIG_MISTYPED_MESSAGE,
  confirmResetConfigIntent$,
} from './reset-config';

/** Component-scoped owner for confirmation, reset observation and partial-result UI state. */
@Injectable()
export class AdvancedSettingsResetService {
  private readonly config = inject(AppConfigService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  readonly resetting = signal(false);
  readonly result = signal<Extract<
    ConfigResetOutcome,
    { readonly kind: 'partial' }
  > | null>(null);
  readonly outstandingEntries = computed(
    () =>
      this.result()?.entries.filter((entry) => entry.status !== 'completed') ??
      [],
  );

  start(onChanged: () => void): void {
    confirmResetConfigIntent$(this.alert)
      .pipe(
        switchMap((intent) => {
          if (intent === 'cancelled') return EMPTY;
          if (intent === 'mistyped') {
            this.toast.show(RESET_CONFIG_MISTYPED_MESSAGE, { duration: 4000 });
            return EMPTY;
          }
          this.resetting.set(true);
          return this.config.resetToDefaults();
        }),
        finalize(() => this.resetting.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (outcome) => this.present(outcome, onChanged),
        error: () => this.failure(),
      });
  }

  retry(onChanged: () => void): void {
    const attempt = this.result()?.attempt;
    if (attempt === undefined || this.resetting()) return;
    this.resetting.set(true);
    this.observe(this.config.retryResetToDefaults(attempt), onChanged);
  }

  private observe(
    reset$: Observable<ConfigResetOutcome>,
    onChanged: () => void,
  ): void {
    reset$
      .pipe(
        finalize(() => this.resetting.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (outcome) => this.present(outcome, onChanged),
        error: () => this.failure(),
      });
  }

  private present(outcome: ConfigResetOutcome, onChanged: () => void): void {
    if (outcome.kind === 'completed') {
      this.result.set(null);
      onChanged();
      this.toast.show('Settings reset to defaults.', {
        duration: 3000,
        variant: 'success',
      });
      return;
    }
    if (outcome.kind === 'partial') {
      this.result.set(outcome);
      onChanged();
      this.toast.show('Some settings still need to be reset.', {
        duration: 4000,
        variant: 'danger',
      });
      return;
    }
    this.toast.show('That reset attempt is no longer available.', {
      duration: 4000,
      variant: 'danger',
    });
  }

  private failure(): void {
    this.toast.show('Could not reset every setting.', {
      duration: 4000,
      variant: 'danger',
    });
  }
}
