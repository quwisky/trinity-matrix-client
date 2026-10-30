import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  DIAGNOSTIC_ACCOUNT_SOURCE,
  DIAGNOSTIC_LOG_STORE_FACTORY,
  DIAGNOSTIC_REPORT_CONFIG,
  DiagnosticLogService,
  MemoryLogStore,
  provideDiagnosticLog,
  type DiagnosticBundle,
  type DiagnosticReportFacts,
  type DiagnosticReportProgress,
} from '@trinity/data-access/diagnostic-log';
import { PREFERENCE_STORAGE_ADAPTER } from '@trinity/runtime/preferences';
import { TrnDialogRef } from '@trinity/components/overlay';
import { ExternalBrowserService } from '@trinity/platform-native';
import { HostFileExportService } from '@trinity/runtime/host';
import { render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, Observable, concat, map, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ReportBugDialogComponent } from './report-bug-dialog.component';

const BUNDLE: DiagnosticBundle = {
  filename: 'trinity-2026-10-11.log',
  text: '# Trinity diagnostic log\n2026-10-11T08:00:00.000Z INFO app/lifecycle app started\n',
  entryCount: 1,
  facts: {
    version: 'Trinity v0.4.0 · abc1234',
    platform: 'Web, Firefox 141 on Linux',
    homeservers: ['Synapse 1.140.0'],
  },
};
const REPOSITORY = 'https://github.com/quwisky/trinity-matrix-client';

interface SetupOptions {
  readonly exported?: Observable<DiagnosticBundle>;
  /** The facts read without the log; the bundle's facts unless a test says otherwise. */
  readonly facts?: Observable<DiagnosticReportFacts>;
  /** Whether anyone is signed in, as the facts report it; yes unless a test says otherwise. */
  readonly signedIn?: boolean;
  /** Opened from Settings › Advanced, beside the switch; elsewhere unless a test says so. */
  readonly fromSettings?: boolean;
  readonly saved?: Observable<unknown>;
  readonly fileExport?: boolean | 'pending';
  readonly repository?: string | null;
  /** Settings › Advanced › Keep a diagnostic log; on unless a test says otherwise. */
  readonly keepLog?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const save = vi.fn(() => options.saved ?? of({ kind: 'completed' }));
  const open = vi.fn(() => of(true));
  const close = vi.fn();
  const rendered = await render(ReportBugDialogComponent, {
    inputs:
      options.fromSettings === undefined
        ? {}
        : { fromSettings: options.fromSettings },
    providers: [
      MockProvider(DiagnosticLogService, {
        prepareReport: () =>
          concat(
            (options.facts ?? of(BUNDLE.facts)).pipe(
              map((facts): DiagnosticReportProgress => ({
                kind: 'facts',
                facts,
                signedIn: options.signedIn ?? true,
              })),
            ),
            (options.exported ?? of(BUNDLE)).pipe(
              map((bundle): DiagnosticReportProgress => ({
                kind: 'bundle',
                bundle,
              })),
            ),
          ),
        keepLog: signal(options.keepLog ?? true).asReadonly(),
      }),
      MockProvider(HostFileExportService, {
        support: () =>
          options.fileExport === 'pending'
            ? NEVER
            : of(
                options.fileExport === false
                  ? ({
                      kind: 'unavailable',
                      reason: 'not-implemented',
                    } as const)
                  : ({ kind: 'supported' } as const),
              ),
        save,
      } as never),
      MockProvider(ExternalBrowserService, { open }),
      {
        provide: DIAGNOSTIC_REPORT_CONFIG,
        useValue: {
          issueRepositoryUrl:
            options.repository === undefined ? REPOSITORY : options.repository,
        },
      },
      { provide: TrnDialogRef, useValue: { close } },
    ],
  });
  await rendered.fixture.whenStable();
  rendered.fixture.detectChanges();
  return { ...rendered, save, open, close };
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsText(blob);
  });
}

function issueFields(open: ReturnType<typeof vi.fn>): Record<string, string> {
  const [url] = open.mock.calls.at(-1) as [string];
  return Object.fromEntries(new URL(url).searchParams);
}

describe('ReportBugDialogComponent', () => {
  it('labels its controls and starts with logs included', async () => {
    await setup();

    expect(screen.getByRole('heading', { name: 'Report a bug' })).toBeTruthy();
    expect(screen.getByLabelText('What went wrong?')).toBeTruthy();
    expect(
      (screen.getByLabelText('Include diagnostic logs') as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it('describes the log switch with what the log holds', async () => {
    await setup();
    const control = screen.getByLabelText('Include diagnostic logs');
    const described = document.getElementById(
      control.getAttribute('aria-describedby') ?? '',
    );

    expect(described?.textContent).toContain(
      'Up to two days of Trinity and Matrix logs from this device.',
    );
  });

  it('previews exactly the text it saves', async () => {
    const { fixture, save } = await setup();

    screen.getByTestId('report-bug-preview-toggle').click();
    fixture.detectChanges();
    const preview = screen.getByRole('region', {
      name: 'Diagnostic log preview',
    });
    expect(preview.textContent).toBe(BUNDLE.text);

    screen.getByTestId('report-bug-save').click();
    fixture.detectChanges();

    const [request] = save.mock.calls[0] as unknown as [
      { bytes: Blob; filename: string },
    ];
    expect(request.filename).toBe('trinity-2026-10-11.log');
    expect(await readBlob(request.bytes)).toBe(BUNDLE.text);
    expect(screen.getByTestId('report-bug-saved').textContent).toContain(
      'trinity-2026-10-11.log',
    );
  });

  it('offers no log file when logs are turned off, and leaves them out of the issue', async () => {
    const { fixture, open } = await setup();

    (
      screen.getByLabelText('Include diagnostic logs') as HTMLInputElement
    ).click();
    fixture.detectChanges();
    screen.getByTestId('report-bug-github').click();

    expect(screen.queryByTestId('report-bug-save')).toBeNull();
    expect(issueFields(open)).not.toHaveProperty('logs');
  });

  it('says so when there are no logs, and still offers GitHub', async () => {
    await setup({ exported: of({ ...BUNDLE, entryCount: 0 }) });

    expect(screen.getByTestId('report-bug-no-logs')).toBeTruthy();
    expect(screen.queryByTestId('report-bug-save')).toBeNull();
    expect(screen.getByTestId('report-bug-github')).toBeTruthy();
  });

  it('shows the error and opens the selectable preview when saving fails', async () => {
    const { fixture } = await setup({
      saved: of({ kind: 'unavailable', reason: 'not-implemented' }),
    });

    screen.getByTestId('report-bug-save').click();
    fixture.detectChanges();

    expect(screen.getByRole('alert').textContent).toContain(
      'Couldn’t save the log file.',
    );
    expect(
      screen.getByRole('region', { name: 'Diagnostic log preview' })
        .textContent,
    ).toBe(BUNDLE.text);
  });

  it('opens the pre-filled issue with the description', async () => {
    const { fixture, open } = await setup();
    const description = screen.getByLabelText(
      'What went wrong?',
    ) as HTMLTextAreaElement;

    description.value = 'Crash on send';
    description.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    screen.getByTestId('report-bug-github').click();

    expect(issueFields(open)).toMatchObject({
      template: 'bug_report.yml',
      summary: 'Crash on send',
      version: 'Trinity v0.4.0 · abc1234',
      os: 'Web, Firefox 141 on Linux',
      homeserver: 'Synapse 1.140.0',
    });
    expect(issueFields(open)['logs']).toContain('trinity-2026-10-11.log');
  });

  it('refuses an over-long description and says why', async () => {
    const { fixture } = await setup();
    const description = screen.getByLabelText(
      'What went wrong?',
    ) as HTMLTextAreaElement;

    description.value = 'x'.repeat(2001);
    description.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(
      screen.getByTestId('report-bug-description-error').textContent,
    ).toContain('2,000 characters');
    expect(description.getAttribute('aria-describedby')).toBe(
      'report-bug-description-hint report-bug-public-note report-bug-description-error',
    );
    expect(
      (screen.getByTestId('report-bug-github') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('leaves GitHub out when the build names no repository', async () => {
    await setup({ repository: null });

    expect(screen.queryByTestId('report-bug-github')).toBeNull();
  });

  it('says when saving a file is not available here', async () => {
    await setup({ fileExport: false });

    expect(screen.queryByTestId('report-bug-save')).toBeNull();
    expect(screen.getByTestId('report-bug-save-unavailable')).toBeTruthy();
  });

  it('offers GitHub while the log is still loading, naming the file the log will be saved as', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 12, 23, 30));
    try {
      const { open } = await setup({ exported: NEVER });
      const github = screen.getByTestId(
        'report-bug-github',
      ) as HTMLButtonElement;

      expect(github.disabled).toBe(false);
      github.click();

      expect(issueFields(open)).toMatchObject({
        version: 'Trinity v0.4.0 · abc1234',
        os: 'Web, Firefox 141 on Linux',
        homeserver: 'Synapse 1.140.0',
      });
      expect(issueFields(open)['logs']).toContain('trinity-2026-10-12.log');
    } finally {
      vi.useRealTimers();
    }
  });

  it('names no log file while loading when logs are left out', async () => {
    const { fixture, open } = await setup({ exported: NEVER });

    (
      screen.getByLabelText('Include diagnostic logs') as HTMLInputElement
    ).click();
    fixture.detectChanges();
    screen.getByTestId('report-bug-github').click();

    expect(issueFields(open)).not.toHaveProperty('logs');
  });

  it('says the log is being prepared, and stops preparing it when closed', async () => {
    const stopped = vi.fn();
    const { fixture } = await setup({
      exported: new Observable<DiagnosticBundle>(() => stopped),
    });

    expect(screen.getByRole('status').textContent).toContain(
      'Preparing the log…',
    );
    fixture.destroy();

    expect(stopped).toHaveBeenCalledOnce();
  });

  it('waits for the facts before offering GitHub', async () => {
    await setup({ exported: NEVER, facts: NEVER });

    expect(
      (screen.getByTestId('report-bug-github') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('says logging is off, offers no log and still opens GitHub', async () => {
    const { open } = await setup({
      keepLog: false,
      exported: of({ ...BUNDLE, text: '', entryCount: 0 }),
    });

    expect(screen.getByTestId('report-bug-logging-off').textContent).toContain(
      'Diagnostic logging is off',
    );
    // Signed in, away from Settings: where the switch is.
    const hint = screen.getByTestId('report-bug-logging-off').textContent;
    expect(hint).toContain('You can turn it on in Settings › Advanced.');
    expect(hint).not.toContain('After you sign in');
    expect(screen.queryByLabelText('Include diagnostic logs')).toBeNull();
    expect(screen.queryByTestId('report-bug-preview-toggle')).toBeNull();
    expect(screen.queryByTestId('report-bug-save')).toBeNull();
    expect(screen.queryByTestId('report-bug-no-logs')).toBeNull();
    // Not stuck waiting for a log: the facts-only export settles the dialog.
    const github = screen.getByTestId('report-bug-github') as HTMLButtonElement;
    expect(github.disabled).toBe(false);

    github.click();

    expect(issueFields(open)).toMatchObject({
      version: 'Trinity v0.4.0 · abc1234',
      os: 'Web, Firefox 141 on Linux',
    });
    expect(issueFields(open)).not.toHaveProperty('logs');
  });

  it('says signed out that logging can be turned on after signing in', async () => {
    await setup({
      keepLog: false,
      signedIn: false,
      exported: of({ ...BUNDLE, text: '', entryCount: 0 }),
    });

    expect(screen.getByTestId('report-bug-logging-off').textContent).toContain(
      'After you sign in, you can turn it on in Settings › Advanced.',
    );
  });

  it('points at the switch itself when opened from Settings', async () => {
    await setup({
      keepLog: false,
      fromSettings: true,
      exported: of({ ...BUNDLE, text: '', entryCount: 0 }),
    });
    const hint = screen.getByTestId('report-bug-logging-off').textContent;

    expect(hint).toContain(
      'To include one, close this and turn on Keep a diagnostic log.',
    );
    expect(hint).not.toContain('Settings › Advanced');
  });

  it('keeps GitHub working, with the facts and no log, when the export code fails to load', async () => {
    const { open } = await setup({
      exported: throwError(
        () => new TypeError('Failed to fetch dynamically imported module'),
      ),
    });

    expect(screen.getByTestId('report-bug-no-logs')).toBeTruthy();
    const github = screen.getByTestId('report-bug-github') as HTMLButtonElement;
    expect(github.disabled).toBe(false);
    github.click();

    expect(open).toHaveBeenCalledOnce();
    expect(issueFields(open)).toMatchObject({
      version: 'Trinity v0.4.0 · abc1234',
    });
    expect(issueFields(open)).not.toHaveProperty('logs');
  });

  it('treats a failed export as no logs, and still files the facts', async () => {
    const { open } = await setup({
      exported: throwError(() => new Error('store unreadable')),
    });

    expect(screen.getByTestId('report-bug-no-logs')).toBeTruthy();
    const github = screen.getByTestId('report-bug-github') as HTMLButtonElement;
    expect(github.disabled).toBe(false);
    github.click();

    expect(issueFields(open)).toMatchObject({
      version: 'Trinity v0.4.0 · abc1234',
      os: 'Web, Firefox 141 on Linux',
    });
    expect(issueFields(open)).not.toHaveProperty('logs');
  });
  it('warns that the issue and the description are public', async () => {
    await setup();

    const note = screen.getByTestId('report-bug-public-note').textContent ?? '';
    expect(screen.getByTestId('report-bug-public-note').id).toBe(
      'report-bug-public-note',
    );
    expect(note).toContain('GitHub issues are public');
    expect(note).toContain('Matrix IDs, room names');
    expect(note).not.toContain('only the log is redacted');
  });

  it('says what the log replaces and asks for a check of the preview', async () => {
    await setup();

    const description =
      document.getElementById('report-bug-include-logs-description')
        ?.textContent ?? '';
    expect(description).toContain(
      'Matrix IDs, email addresses, and the room names, topics and display names this device knows are replaced',
    );
    expect(description).toContain(
      'Check the preview before you attach the log: it may still contain file names or other details.',
    );
  });

  it('keeps the public warning when logging is off', async () => {
    await setup({
      keepLog: false,
      exported: of({ ...BUNDLE, text: '', entryCount: 0 }),
    });

    expect(screen.getByTestId('report-bug-public-note').textContent).toContain(
      'GitHub issues are public',
    );
  });

  it('caps typing at the limit natively; the error covers values set another way', async () => {
    await setup();

    expect(
      screen.getByLabelText('What went wrong?').getAttribute('maxlength'),
    ).toBe('2000');
  });

  it('announces the description error', async () => {
    const { fixture } = await setup();
    const description = screen.getByLabelText(
      'What went wrong?',
    ) as HTMLTextAreaElement;

    description.value = 'x'.repeat(2001);
    description.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(
      screen.getByTestId('report-bug-description-error').getAttribute('role'),
    ).toBe('alert');
  });

  it('shows an error when the host rejects the save, and opens the preview', async () => {
    const { fixture } = await setup({
      saved: of({ kind: 'rejected', diagnostic: { code: 'denied' } }),
    });

    screen.getByTestId('report-bug-save').click();
    fixture.detectChanges();

    expect(screen.getByTestId('report-bug-save-error').textContent).toContain(
      'Try again.',
    );
    expect(screen.queryByTestId('report-bug-saved')).toBeNull();
    expect(
      screen.getByRole('region', { name: 'Diagnostic log preview' }),
    ).toBeTruthy();
  });

  it('shows an error when saving throws', async () => {
    const { fixture } = await setup({
      saved: throwError(() => new Error('disk full')),
    });

    screen.getByTestId('report-bug-save').click();
    fixture.detectChanges();

    expect(screen.getByTestId('report-bug-save-error')).toBeTruthy();
    expect(
      (screen.getByTestId('report-bug-save') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('says nothing when the share sheet is dismissed', async () => {
    const { fixture, save } = await setup();

    screen.getByTestId('report-bug-save').click();
    fixture.detectChanges();
    expect(screen.getByTestId('report-bug-saved')).toBeTruthy();

    save.mockReturnValueOnce(of({ kind: 'cancelled' }));
    screen.getByTestId('report-bug-save').click();
    fixture.detectChanges();

    expect(screen.queryByTestId('report-bug-save-error')).toBeNull();
    expect(screen.queryByTestId('report-bug-saved')).toBeNull();
    expect(
      screen.queryByRole('region', { name: 'Diagnostic log preview' }),
    ).toBeNull();
    expect(
      (screen.getByTestId('report-bug-save') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('does not show a past success next to a later failure', async () => {
    const { fixture, save } = await setup();

    screen.getByTestId('report-bug-save').click();
    fixture.detectChanges();
    expect(screen.getByTestId('report-bug-saved')).toBeTruthy();

    save.mockReturnValueOnce(
      of({ kind: 'rejected', diagnostic: { code: 'denied' } }),
    );
    screen.getByTestId('report-bug-save').click();
    fixture.detectChanges();

    expect(screen.queryByTestId('report-bug-saved')).toBeNull();
    expect(screen.getByTestId('report-bug-save-error')).toBeTruthy();
  });

  it('forgets a saved file when the logs are switched off', async () => {
    const { fixture } = await setup();

    screen.getByTestId('report-bug-save').click();
    fixture.detectChanges();
    (
      screen.getByLabelText('Include diagnostic logs') as HTMLInputElement
    ).click();
    fixture.detectChanges();

    expect(screen.queryByTestId('report-bug-saved')).toBeNull();
  });

  it('says so when GitHub could not be opened', async () => {
    const { fixture, open } = await setup();
    open.mockReturnValue(of(false));

    screen.getByTestId('report-bug-github').click();
    fixture.detectChanges();

    expect(screen.getByTestId('report-bug-open-error').textContent).toContain(
      'Try again.',
    );
  });

  it('opens one tab however many times GitHub is clicked', async () => {
    const { open } = await setup();
    open.mockReturnValue(NEVER);

    screen.getByTestId('report-bug-github').click();
    screen.getByTestId('report-bug-github').click();

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('does not claim saving is unavailable before the host has answered', async () => {
    await setup({ fileExport: 'pending' });

    expect(screen.queryByTestId('report-bug-save-unavailable')).toBeNull();
  });

  it('does not tell the user to attach a saved file when saving is unavailable', async () => {
    await setup({ fileExport: false });

    expect(
      screen.getByTestId('report-bug-public-note').textContent,
    ).not.toContain('attach the saved log file');
  });

  it('only points aria-controls at the preview while it exists', async () => {
    const { fixture } = await setup();
    const toggle = screen.getByTestId('report-bug-preview-toggle');
    expect(toggle.hasAttribute('aria-controls')).toBe(false);

    toggle.click();
    fixture.detectChanges();

    expect(toggle.getAttribute('aria-controls')).toBe('report-bug-preview');
  });

  it('opens signed out, on root services alone, with no accounts in the log', async () => {
    // The sign-in screen opens this with nobody signed in: only the storage boundaries and
    // the app's account source (an empty registry) are supplied; the services are the root's.
    const rendered = await render(ReportBugDialogComponent, {
      providers: [
        {
          provide: DIAGNOSTIC_LOG_STORE_FACTORY,
          useValue: () => Promise.resolve(new MemoryLogStore()),
        },
        {
          provide: PREFERENCE_STORAGE_ADAPTER,
          useValue: {
            read: () => of({ kind: 'missing' } as const),
            write: () => of({ kind: 'completed' } as const),
          },
        },
        {
          provide: DIAGNOSTIC_ACCOUNT_SOURCE,
          useValue: {
            accounts: () => of([]),
            knownNames: () => of([]),
          },
        },
        { provide: TrnDialogRef, useValue: { close: vi.fn() } },
        // Starts the log at app start-up, as the application does.
        provideDiagnosticLog(),
      ],
    });

    // The real export lazy-loads its chunk and builds in slices, so a loaded CI runner can
    // take well over waitFor's default 1 s before the preview toggle appears.
    await vi.waitFor(
      () => {
        rendered.fixture.detectChanges();
        expect(screen.getByTestId('report-bug-preview-toggle')).toBeTruthy();
      },
      { timeout: 10_000 },
    );
    screen.getByTestId('report-bug-preview-toggle').click();
    rendered.fixture.detectChanges();

    expect(
      screen.getByRole('region', { name: 'Diagnostic log preview' })
        .textContent,
    ).toContain('# Accounts signed in: 0');
    expect(TestBed.inject(DIAGNOSTIC_REPORT_CONFIG).issueRepositoryUrl).toBe(
      null,
    );
  }, 15_000);
});
