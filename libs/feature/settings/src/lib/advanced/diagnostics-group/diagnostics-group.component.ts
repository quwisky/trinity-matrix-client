import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton, TrnSwitchComponent } from '@trinity/components/controls';
import {
  TrnSettingsGroupComponent,
  TrnSettingsRowComponent,
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  DiagnosticLogNotDeletedError,
  DiagnosticLogService,
} from '@trinity/data-access/diagnostic-log';
import { ReportBugDialogComponent } from '../report-bug/report-bug-dialog.component';

/**
 * Settings › Advanced › Diagnostics: Keep a diagnostic log, Report a bug and Clear
 * diagnostic logs. The sign-in screen and System status open the same dialog through
 * `BUG_REPORT_LAUNCHER`; here it opens directly.
 */
@Component({
  selector: 'trn-diagnostics-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './diagnostics-group.component.html',
  imports: [
    TrnButton,
    TrnSettingsGroupComponent,
    TrnSettingsRowComponent,
    TrnSwitchComponent,
  ],
})
export class DiagnosticsGroupComponent {
  private readonly log = inject(DiagnosticLogService);
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  readonly keepLog = this.log.keepLog;
  readonly clearing = signal(false);

  /** True while the stored setting is still being read; `keepLog()` is not yet authoritative. */
  readonly pending = computed(() => this.log.available() === 'pending');

  /** True while a change to the switch is being saved. */
  readonly saving = signal(false);

  /** The log is off, but the stored copy could not be deleted and is still on this device. */
  readonly notDeleted = signal(false);

  readonly memoryOnly = computed(
    () =>
      !this.pending() &&
      this.keepLog() &&
      this.log.available() === 'memory-only',
  );

  /** Clear is offered while the log is on, and while a log that failed to delete remains. */
  readonly canClear = computed(
    () => !this.pending() && (this.keepLog() || this.notDeleted()),
  );

  openReport(): void {
    this.surfaces.open(ReportBugDialogComponent, {
      ariaLabel: 'Report a bug',
      autoFocus: '[data-autofocus]',
    });
  }

  /** Off stops the log and deletes it at once; on starts a fresh one. */
  setKeepLog(keep: boolean): void {
    this.saving.set(true);
    this.notDeleted.set(false);
    this.log
      .setKeepLog(keep)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (outcome) => {
          this.saving.set(false);
          if (outcome.kind !== 'completed') {
            this.showSaveFailed();
          }
        },
        error: (error: unknown) => {
          this.saving.set(false);
          // The choice was saved and the switch is off; only the stored log remains.
          if (error instanceof DiagnosticLogNotDeletedError) {
            this.notDeleted.set(true);
          } else {
            this.showSaveFailed();
          }
        },
      });
  }

  clear(): void {
    this.clearing.set(true);
    this.log
      .clear()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.clearing.set(false);
          this.notDeleted.set(false);
          this.toast.show('Diagnostic logs cleared.', {
            duration: 3000,
            variant: 'success',
          });
        },
        error: () => {
          this.clearing.set(false);
          this.toast.show('Couldn’t clear the diagnostic logs. Try again.', {
            duration: 4000,
            variant: 'danger',
          });
        },
      });
  }

  private showSaveFailed(): void {
    this.toast.show('Couldn’t save this setting. Try again.', {
      duration: 4000,
      variant: 'danger',
    });
  }
}
