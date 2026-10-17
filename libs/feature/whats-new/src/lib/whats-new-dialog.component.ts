import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnDialogActions,
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
import { DIAGNOSTIC_REPORT_CONFIG } from '@trinity/data-access/diagnostic-log';
import type { ReleaseNote } from '@trinity/data-access/whats-new';
import { ExternalBrowserService } from '@trinity/platform-native';

/** The notes of the releases a device has not seen yet, newest first, shown after an update. */
@Component({
  selector: 'trn-whats-new-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './whats-new-dialog.component.html',
  imports: [DatePipe, TrnButton, TrnDialogActions, TrnDialogShellComponent],
})
export class WhatsNewDialogComponent {
  private readonly browser = inject(ExternalBrowserService);
  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef);
  private readonly destroyRef = inject(DestroyRef);

  readonly repositoryUrl = inject(DIAGNOSTIC_REPORT_CONFIG).issueRepositoryUrl;
  readonly releases = input.required<readonly ReleaseNote[]>();
  readonly sections = [
    ['added', 'Added'],
    ['fixed', 'Fixed'],
    ['changed', 'Changed'],
    ['reverted', 'Reverted'],
  ] as const;

  openReleasePage(): void {
    this.browser
      .open(`${this.repositoryUrl}/releases/tag/v${this.releases()[0].version}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  close(): void {
    this.dialogRef.close();
  }
}
