import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  FormField,
  FormRoot,
  form,
  maxLength,
  schema,
} from '@angular/forms/signals';
import { TrnButton, TrnLabel, TrnTextarea } from '@trinity/components/controls';
import {
  TrnDialogActions,
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
import {
  DIAGNOSTIC_REPORT_CONFIG,
  DiagnosticLogService,
  buildBugReportUrl,
} from '@trinity/data-access/diagnostic-log';
import { finalize } from 'rxjs';
import { ExternalBrowserService } from '@trinity/platform-native';

/** The description's ceiling; GitHub gets the rest typed into the issue itself. */
export const REPORT_DESCRIPTION_MAX_LENGTH = 2000;

interface ReportModel {
  description: string;
}

const reportSchema = schema<ReportModel>((path) => {
  maxLength(path.description, REPORT_DESCRIPTION_MAX_LENGTH, {
    message: `Keep this under ${REPORT_DESCRIPTION_MAX_LENGTH.toLocaleString('en-US')} characters; you can add more on GitHub.`,
  });
});

/**
 * Report a bug, opened from Settings › Advanced, the sign-in screen, System status or the
 * desktop title bar: describe the problem and open a GitHub issue pre-filled with it and the
 * app, platform and homeserver facts. The description only pre-fills the issue and is never
 * stored.
 */
@Component({
  selector: 'trn-report-bug-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './report-bug-dialog.component.html',
  imports: [
    FormField,
    FormRoot,
    TrnButton,
    TrnLabel,
    TrnTextarea,
    TrnDialogActions,
    TrnDialogShellComponent,
  ],
})
export class ReportBugDialogComponent {
  private readonly browser = inject(ExternalBrowserService);
  private readonly config = inject(DIAGNOSTIC_REPORT_CONFIG);
  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly model = signal<ReportModel>({ description: '' });
  /** Undefined until the homeservers answer or the probe budget runs out. */
  private readonly facts = toSignal(inject(DiagnosticLogService).reportFacts());

  readonly reportForm = form(this.model, reportSchema);
  readonly showGitHub = this.config.issueRepositoryUrl !== null;
  readonly canOpenGitHub = computed(
    () => this.facts() !== undefined && !this.reportForm().invalid(),
  );
  readonly descriptionError = computed(
    () => this.reportForm.description().errors()[0]?.message ?? null,
  );
  /** The hint, plus the error while there is one, so a screen reader hears why. */
  readonly descriptionDescribedBy = computed(() =>
    [
      'report-bug-description-hint',
      this.showGitHub ? 'report-bug-public-note' : null,
      this.descriptionError() ? 'report-bug-description-error' : null,
    ]
      .filter((id) => id !== null)
      .join(' '),
  );
  readonly openFailed = signal(false);
  readonly opening = signal(false);

  openGitHub(): void {
    const repository = this.config.issueRepositoryUrl;
    const facts = this.facts();
    if (!repository || !facts || this.opening() || !this.canOpenGitHub()) {
      return;
    }
    const url = buildBugReportUrl(repository, {
      description: this.model().description,
      facts,
    });
    if (!url) {
      this.openFailed.set(true);
      return;
    }
    this.openFailed.set(false);
    this.opening.set(true);
    this.browser
      .open(url)
      .pipe(
        finalize(() => this.opening.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (opened) => this.openFailed.set(!opened),
        error: () => this.openFailed.set(true),
      });
  }

  close(): void {
    this.dialogRef.close();
  }
}
