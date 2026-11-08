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
  TrnDialogDismiss,
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
import {
  BUG_REPORT_CONFIG,
  ExternalBrowserService,
} from '@trinity/platform-native';
import type { ReleaseNote } from '@trinity/data-access/whats-new';

/** The notes of the releases a device has not seen yet, newest first, shown after an update. */
@Component({
  selector: 'trn-whats-new-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './whats-new-dialog.component.html',
  imports: [
    DatePipe,
    TrnButton,
    TrnDialogActions,
    TrnDialogDismiss,
    TrnDialogShellComponent,
  ],
})
export class WhatsNewDialogComponent {
  private readonly browser = inject(ExternalBrowserService);
  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef);
  private readonly destroyRef = inject(DestroyRef);

  readonly repositoryUrl = inject(BUG_REPORT_CONFIG).issueRepositoryUrl;
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
