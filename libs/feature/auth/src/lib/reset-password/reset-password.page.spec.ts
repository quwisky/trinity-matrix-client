import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import {
  AUTHENTICATION_HOMESERVER_DISCOVERY,
  PasswordResetWorkflow,
  type PendingReset,
  type ResetLinkResult,
  type ResetResult,
} from '@trinity/data-access/auth';
import { TIMERS, fireEvent, render, screen } from '@trinity/testing';
import { Subject, of, throwError, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ResetPasswordPage } from './reset-password.page';

const PENDING: PendingReset = {
  baseUrl: 'https://hs.example',
  email: 'a@b.c',
  sid: 'sid',
  clientSecret: 'secret',
  sendAttempt: 1,
};
const SENT: ResetLinkResult = { kind: 'sent', pending: PENDING };

interface Options {
  homeserver?: string | null;
  add?: boolean;
  discover?: () => Observable<{ baseUrl: string }>;
  reset?: () => Observable<ResetResult>;
}

async function renderPage(options: Options = {}) {
  const homeserver =
    options.homeserver === undefined ? 'hs.test' : options.homeserver;
  const workflow = {
    sendLink: vi.fn(() => of(SENT)),
    resend: vi.fn(() => of(SENT)),
    reset: vi.fn(options.reset ?? (() => of({ kind: 'reset' } as ResetResult))),
  };
  const queryParamMap = {
    get: (key: string) => (key === 'homeserver' ? homeserver : null),
    has: (key: string) => key === 'add' && !!options.add,
  };
  const { fixture } = await render(ResetPasswordPage, {
    providers: [
      { provide: PasswordResetWorkflow, useValue: workflow },
      {
        provide: AUTHENTICATION_HOMESERVER_DISCOVERY,
        useValue: {
          discover: vi.fn(
            options.discover ?? (() => of({ baseUrl: 'https://hs.example' })),
          ),
        },
      },
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap } } },
    ],
  });
  await fixture.whenStable();
  const router = TestBed.inject(Router);
  vi.spyOn(router, 'navigate').mockResolvedValue(true);
  return { fixture, workflow, router };
}

function type(testId: string, value: string) {
  fireEvent.input(screen.getByTestId(testId), { target: { value } });
}

async function click(
  fixture: { whenStable(): Promise<unknown> },
  testId: string,
) {
  fireEvent.click(screen.getByTestId(testId));
  await fixture.whenStable();
}

async function toSent(page: Awaited<ReturnType<typeof renderPage>>) {
  type('reset-email-input', ' a@b.c ');
  await click(page.fixture, 'reset-send');
}

async function toPassword(
  page: Awaited<ReturnType<typeof renderPage>>,
  password = 'pw',
  confirm = password,
) {
  await toSent(page);
  await click(page.fixture, 'reset-continue');
  type('reset-password-input', password);
  type('reset-confirm-input', confirm);
}

const logoutBox = () =>
  screen.getByTestId('reset-logout-devices').querySelector('input');

describe('ResetPasswordPage', () => {
  it('walks the happy path and returns to sign-in with the reset flag', async () => {
    const page = await renderPage();
    await toSent(page);

    expect(page.workflow.sendLink).toHaveBeenCalledWith(
      'https://hs.example',
      'a@b.c',
    );
    expect(screen.getByTestId('reset-sent')).toHaveTextContent(
      'We sent a link to a@b.c. Open it and confirm, then come back here.',
    );
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 2 }),
    );

    await click(page.fixture, 'reset-continue');
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 2 }),
    );
    expect(logoutBox()).toBeChecked();

    type('reset-password-input', 'pw');
    type('reset-confirm-input', 'pw');
    await click(page.fixture, 'reset-submit');

    expect(page.workflow.reset).toHaveBeenCalledWith(PENDING, 'pw', true);
    expect(page.router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { homeserver: 'hs.test' },
      state: { passwordReset: true },
    });
  });

  it('keeps add mode on the way back to sign-in', async () => {
    const page = await renderPage({ add: true });
    await toPassword(page);
    await click(page.fixture, 'reset-submit');

    expect(page.router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { homeserver: 'hs.test', add: '' },
      state: { passwordReset: true },
    });
  });

  it('keeps the devices signed in when the box is unchecked', async () => {
    const page = await renderPage();
    await toPassword(page);
    fireEvent.click(logoutBox() as HTMLInputElement);
    await click(page.fixture, 'reset-submit');

    expect(page.workflow.reset).toHaveBeenCalledWith(PENDING, 'pw', false);
  });

  it('stays on the email step for an unknown address', async () => {
    const page = await renderPage();
    page.workflow.sendLink.mockReturnValue(
      of({ kind: 'refused', refusal: 'unknown-address' }) as never,
    );
    await toSent(page);

    expect(screen.getByTestId('reset-error')).toHaveTextContent(
      "Trinity couldn't send a link to that address. Check it, or use the address on your account.",
    );
    expect(screen.getByTestId('reset-email-input')).toBeInTheDocument();
  });

  it('does not reset when the passwords differ', async () => {
    const page = await renderPage();
    await toPassword(page, 'one', 'two');
    await click(page.fixture, 'reset-submit');

    expect(page.workflow.reset).not.toHaveBeenCalled();
    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
  });

  it('returns to the sent step when the link is not confirmed, keeping the passwords and the pending reset', async () => {
    const page = await renderPage({
      reset: () => of({ kind: 'refused', refusal: 'not-confirmed' }),
    });
    await toPassword(page);
    await click(page.fixture, 'reset-submit');

    expect(screen.getByTestId('reset-sent')).toBeInTheDocument();
    expect(screen.getByTestId('reset-error')).toHaveTextContent(
      'Confirm the link in the email first, then try again.',
    );

    await click(page.fixture, 'reset-resend');
    expect(page.workflow.resend).toHaveBeenCalledWith(PENDING);

    await click(page.fixture, 'reset-continue');
    expect(screen.getByTestId('reset-password-input')).toHaveValue('pw');
    expect(screen.getByTestId('reset-confirm-input')).toHaveValue('pw');
  });

  it('calls reset once while the first request is pending', async () => {
    const pending = new Subject<ResetResult>();
    const page = await renderPage({ reset: () => pending });
    await toPassword(page);
    await click(page.fixture, 'reset-submit');
    await click(page.fixture, 'reset-submit');

    expect(page.workflow.reset).toHaveBeenCalledTimes(1);
  });

  it('counts the wait down on the button while the alert text stays constant', async () => {
    const page = await renderPage({
      reset: () =>
        of({ kind: 'refused', refusal: 'rate-limited', retryAfterMs: 30_000 }),
    });
    await toPassword(page);
    vi.useFakeTimers(TIMERS);
    fireEvent.click(screen.getByTestId('reset-submit'));
    page.fixture.detectChanges();

    const alert = screen.getByTestId('reset-error').textContent?.trim();

    expect(alert).toBe('Too many tries. Wait a moment, then try again.');
    expect(screen.getByTestId('reset-submit')).toBeDisabled();
    expect(screen.getByTestId('reset-submit')).toHaveTextContent(
      'Try again in 30s',
    );

    vi.advanceTimersByTime(1000);
    page.fixture.detectChanges();

    expect(screen.getByTestId('reset-submit')).toHaveTextContent(
      'Try again in 29s',
    );
    expect(screen.getByTestId('reset-error').textContent?.trim()).toBe(alert);
    vi.useRealTimers();
  });

  it('gives the email step a focusable heading', async () => {
    await renderPage();

    expect(screen.getByRole('heading', { level: 2 })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });

  it('shows the reason a password was refused', async () => {
    const page = await renderPage({
      reset: () =>
        of({ kind: 'refused', refusal: 'weak-password', reason: 'Too short' }),
    });
    await toPassword(page);
    await click(page.fixture, 'reset-submit');

    expect(screen.getByTestId('reset-error')).toHaveTextContent('Too short');
  });

  it('asks for a server when none was chosen', async () => {
    await renderPage({ homeserver: null });

    expect(screen.getByTestId('reset-no-server')).toHaveTextContent(
      'Choose your server on the sign-in page first',
    );
    expect(screen.queryByTestId('reset-email-input')).toBeNull();
  });

  it('asks for a server when discovery fails', async () => {
    await renderPage({
      discover: () => throwError(() => new Error('no')),
    });

    expect(screen.getByTestId('reset-no-server')).toBeInTheDocument();
    expect(screen.queryByTestId('reset-email-input')).toBeNull();

    expect(screen.getByTestId('reset-back')).toHaveAttribute(
      'href',
      '/login?homeserver=hs.test',
    );
  });
});
