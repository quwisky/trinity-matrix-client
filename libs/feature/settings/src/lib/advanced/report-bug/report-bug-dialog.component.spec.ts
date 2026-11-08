import { TestBed } from '@angular/core/testing';
import { TrnDialogRef } from '@trinity/components/overlay';
import {
  BUG_REPORT_ACCOUNT_SOURCE,
  BUG_REPORT_CONFIG,
  BugReportFactsService,
  ExternalBrowserService,
  type BugReportFacts,
} from '@trinity/platform-native';
import { render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, of, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ReportBugDialogComponent } from './report-bug-dialog.component';

const FACTS: BugReportFacts = {
  version: 'Trinity v0.4.0 · abc1234',
  platform: 'Web, Firefox 141 on Linux',
  homeservers: ['Synapse 1.140.0'],
};
const REPOSITORY = 'https://github.com/quwisky/trinity-matrix-client';

interface SetupOptions {
  readonly facts?: Observable<BugReportFacts>;
  readonly repository?: string | null;
}

async function setup(options: SetupOptions = {}) {
  const open = vi.fn(() => of(true));
  const close = vi.fn();
  const rendered = await render(ReportBugDialogComponent, {
    providers: [
      MockProvider(BugReportFactsService, {
        facts: () => options.facts ?? of(FACTS),
      }),
      MockProvider(ExternalBrowserService, { open }),
      {
        provide: BUG_REPORT_CONFIG,
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
  return { ...rendered, open, close };
}

function issueFields(open: ReturnType<typeof vi.fn>): Record<string, string> {
  const [url] = open.mock.calls.at(-1) as [string];
  return Object.fromEntries(new URL(url).searchParams);
}

describe('ReportBugDialogComponent', () => {
  it('asks what went wrong and offers no log to attach', async () => {
    await setup();

    expect(screen.getByRole('heading', { name: 'Report a bug' })).toBeTruthy();
    expect(screen.getByLabelText('What went wrong?')).toBeTruthy();
    expect(screen.queryByText(/diagnostic log/i)).toBeNull();
    expect(
      screen
        .getAllByRole('button')
        .map(
          (button) =>
            button.getAttribute('aria-label') ?? button.textContent?.trim(),
        ),
    ).toEqual(['Close Report a bug', 'Open bug report on GitHub']);
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
    expect(issueFields(open)).not.toHaveProperty('logs');
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

  it('waits for the facts before offering GitHub', async () => {
    await setup({ facts: NEVER });

    expect(
      (screen.getByTestId('report-bug-github') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('warns that the issue and the description are public', async () => {
    await setup();

    const note = screen.getByTestId('report-bug-public-note').textContent ?? '';
    expect(screen.getByTestId('report-bug-public-note').id).toBe(
      'report-bug-public-note',
    );
    expect(note).toContain('GitHub issues are public');
    expect(note).toContain('Matrix IDs, room names');
    expect(note).not.toContain('log');
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

  it('opens signed out, on root services alone', async () => {
    // The sign-in screen opens this with nobody signed in: only the app's account source (an
    // empty registry) is supplied; the services are the root's.
    await render(ReportBugDialogComponent, {
      providers: [
        {
          provide: BUG_REPORT_ACCOUNT_SOURCE,
          useValue: { accounts: () => of([]) },
        },
        { provide: TrnDialogRef, useValue: { close: vi.fn() } },
      ],
    });

    expect(screen.getByLabelText('What went wrong?')).toBeTruthy();
    expect(TestBed.inject(BUG_REPORT_CONFIG).issueRepositoryUrl).toBe(null);
  });
});
