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
  loadBugReportUrlBuilder,
  type DiagnosticBundle,
  type DiagnosticReportFacts,
} from '@trinity/data-access/diagnostic-log';
import { EMPTY, catchError, finalize, from } from 'rxjs';
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
    message: `Keep this under ${REPORT_DESCRIPTION_MAX_LENGTH.toLocaleString('en-US')} characters; you can add more on GitHub.`,
  });
});

/**
 * Report a bug, opened from Settings › Advanced, the sign-in screen or System status: describe
 * the problem, preview the redacted diagnostic log, save it as `trinity-<date>.log`, and open
 * a pre-filled GitHub issue. The description only pre-fills the issue and is never stored.
 * The preview and the saved file are the same text, from one export.
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
  /** Undefined until the host answers, so "not available" never flashes before then. */
  private readonly fileSupport = toSignal(this.files.support());
  /** The issue's facts, known before the log, so GitHub needn't wait for a slow export. */
  private readonly facts = signal<DiagnosticReportFacts | null>(null);
  /**
   * The issue URL builder, loaded with the export code when the dialog opens, so the click
   * on GitHub can open the issue at once.
   */
  private readonly issueUrl = toSignal(
    from(loadBugReportUrlBuilder()).pipe(catchError(() => EMPTY)),
  );
  /** GitHub needs only the facts: from the export once it is ready, or read on their own. */
  private readonly reportFacts = computed(
    () => this.bundle()?.facts ?? this.facts() ?? null,
  );

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
    () => this.fileSupport()?.kind === 'supported',
  );
  readonly saveUnavailable = computed(() => {
    const support = this.fileSupport();
    return support !== undefined && support.kind !== 'supported';
  });
  readonly showSave = computed(() => this.offersLog() && this.canSaveFile());
  readonly showGitHub = this.config.issueRepositoryUrl !== null;
  readonly canOpenGitHub = computed(
    () =>
      this.reportFacts() !== null &&
      this.issueUrl() !== undefined &&
      !this.reportForm().invalid(),
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
  readonly previewOpen = signal(false);
  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly saveFailed = signal(false);
  readonly openFailed = signal(false);
  readonly opening = signal(false);

  constructor() {
    this.log
      .prepareReport()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (step) => {
          if (step.kind === 'facts') {
            this.facts.set(step.facts);
          } else {
            this.logState.set({ kind: 'ready', bundle: step.bundle });
          }
        },
        error: () => this.logState.set({ kind: 'unavailable' }),
      });
  }

  setIncludeLogs(include: boolean): void {
    this.model.update((model) => ({ ...model, includeLogs: include }));
    if (!include) {
      this.previewOpen.set(false);
      this.saved.set(false);
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
    this.saved.set(false);
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
    const facts = this.reportFacts();
    const buildUrl = this.issueUrl();
    if (
      !repository ||
      !facts ||
      !buildUrl ||
      this.opening() ||
      !this.canOpenGitHub()
    ) {
      return;
    }
    const bundle = this.bundle();
    const url = buildUrl(repository, {
      description: this.model().description,
      facts,
      logFileName: bundle && this.offersLog() ? bundle.filename : null,
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

  private failSave(): void {
    this.saveFailed.set(true);
    // The text stays reachable: select it in the preview and copy it instead.
    this.previewOpen.set(true);
  }
}
