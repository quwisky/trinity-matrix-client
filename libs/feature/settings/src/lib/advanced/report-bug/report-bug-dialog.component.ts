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
import {
  TrnButton,
  TrnLabel,
  TrnSwitchComponent,
  TrnTextarea,
} from '@trinity/components/controls';
import {
  TrnDialogActions,
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
import {
  DIAGNOSTIC_REPORT_CONFIG,
  DiagnosticLogService,
  buildBugReportUrl,
  type DiagnosticBundle,
} from '@trinity/data-access/diagnostic-log';
import { ExternalBrowserService } from '@trinity/platform-native';
import { HostFileExportService } from '@trinity/runtime/host';

/** The description's ceiling; GitHub gets the rest typed into the issue itself. */
export const REPORT_DESCRIPTION_MAX_LENGTH = 2000;

interface ReportModel {
  description: string;
  includeLogs: boolean;
}

type ReportLog =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly bundle: DiagnosticBundle }
  | { readonly kind: 'unavailable' };

const reportSchema = schema<ReportModel>((path) => {
  maxLength(path.description, REPORT_DESCRIPTION_MAX_LENGTH, {
    message: `Keep this under 2,000 characters; you can add more on GitHub.`,
  });
});

/**
 * Settings › Advanced › Report a bug: describe the problem, preview the redacted diagnostic
 * log, save it as `trinity-<date>.log`, and open a pre-filled GitHub issue. The description
 * only pre-fills the issue and is never stored. The preview and the saved file are the same
 * text, from one export.
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
    TrnSwitchComponent,
    TrnTextarea,
    TrnDialogActions,
    TrnDialogShellComponent,
  ],
})
export class ReportBugDialogComponent {
  private readonly log = inject(DiagnosticLogService);
  private readonly files = inject(HostFileExportService);
  private readonly browser = inject(ExternalBrowserService);
  private readonly config = inject(DIAGNOSTIC_REPORT_CONFIG);
  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly model = signal<ReportModel>({
    description: '',
    includeLogs: true,
  });
  private readonly logState = signal<ReportLog>({ kind: 'loading' });
  private readonly fileSupport = toSignal(this.files.support(), {
    initialValue: { kind: 'unavailable', reason: 'not-implemented' } as const,
  });

  readonly reportForm = form(this.model, reportSchema);
  /** Settings › Advanced › Keep a diagnostic log is off: there is no log to offer. */
  readonly loggingOff = computed(() => !this.log.keepLog());
  readonly includeLogs = computed(() => this.model().includeLogs);
  readonly loading = computed(() => this.logState().kind === 'loading');
  readonly bundle = computed(() => {
    const state = this.logState();
    return state.kind === 'ready' ? state.bundle : null;
  });
  readonly hasLogs = computed(() => (this.bundle()?.entryCount ?? 0) > 0);
  /** A log goes with this report: logging is on, the user kept it in, and there is one. */
  readonly offersLog = computed(
    () => !this.loggingOff() && this.includeLogs() && this.hasLogs(),
  );
  readonly canSaveFile = computed(
    () => this.fileSupport().kind === 'supported',
  );
  readonly showSave = computed(() => this.offersLog() && this.canSaveFile());
  readonly showGitHub = this.config.issueRepositoryUrl !== null;
  readonly descriptionError = computed(
    () => this.reportForm.description().errors()[0]?.message ?? null,
  );
  /** The hint, plus the error while there is one, so a screen reader hears why. */
  readonly descriptionDescribedBy = computed(() =>
    this.descriptionError()
      ? 'report-bug-description-hint report-bug-description-error'
      : 'report-bug-description-hint',
  );
  readonly previewOpen = signal(false);
  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly saveFailed = signal(false);
  readonly openFailed = signal(false);

  constructor() {
    this.log
      .export()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (bundle) => this.logState.set({ kind: 'ready', bundle }),
        error: () => this.logState.set({ kind: 'unavailable' }),
      });
  }

  setIncludeLogs(include: boolean): void {
    this.model.update((model) => ({ ...model, includeLogs: include }));
    if (!include) {
      this.previewOpen.set(false);
    }
  }

  togglePreview(): void {
    this.previewOpen.update((open) => !open);
  }

  save(): void {
    const bundle = this.bundle();
    if (!bundle || this.saving()) {
      return;
    }
    this.saving.set(true);
    this.saveFailed.set(false);
    this.files
      .save({
        bytes: new Blob([bundle.text], { type: 'text/plain;charset=utf-8' }),
        filename: bundle.filename,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (outcome) => {
          this.saving.set(false);
          if (outcome.kind === 'completed') {
            this.saved.set(true);
          } else {
            this.failSave();
          }
        },
        error: () => {
          this.saving.set(false);
          this.failSave();
        },
      });
  }

  openGitHub(): void {
    const repository = this.config.issueRepositoryUrl;
    if (!repository || this.loading() || this.reportForm().invalid()) {
      return;
    }
    const bundle = this.bundle();
    const url = buildBugReportUrl(repository, {
      description: this.model().description,
      facts: bundle?.facts ?? { version: '', platform: '', homeservers: [] },
      logFileName: bundle && this.offersLog() ? bundle.filename : null,
    });
    if (!url) {
      this.openFailed.set(true);
      return;
    }
    this.openFailed.set(false);
    this.browser
      .open(url)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((opened) => this.openFailed.set(!opened));
  }

  close(): void {
    this.dialogRef.close();
  }

  private failSave(): void {
    this.saveFailed.set(true);
    // The text stays reachable: select it in the preview and copy it instead.
    this.previewOpen.set(true);
  }
}
