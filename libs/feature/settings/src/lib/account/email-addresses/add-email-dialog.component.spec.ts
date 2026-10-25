import axe from 'axe-core';
import { Subject, of, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TrnDialogRef } from '@trinity/components/overlay';
import {
  EmailAddressesWorkflow,
  type EmailAddResult,
  type EmailAddressStages,
  type EmailLinkResult,
  type PendingEmail,
} from '@trinity/data-access/contact-addresses';
import { fireEvent, render, screen } from '@trinity/testing';
import { AddEmailDialogComponent } from './add-email-dialog.component';

const ALICE = '@alice:example.org';
const PENDING: PendingEmail = {
  accountId: ALICE,
  email: 'a@b.c',
  sid: 's',
  clientSecret: 'c',
  sendAttempt: 1,
};
const SENT: EmailLinkResult = { kind: 'sent', pending: PENDING };

async function setup() {
  const confirmed = new Subject<EmailAddResult>();
  let stages: EmailAddressStages | null = null;
  const workflow = {
    sendLink: vi.fn((): Observable<EmailLinkResult> => of(SENT)),
    resend: vi.fn((): Observable<EmailLinkResult> => of(SENT)),
    add: vi.fn((_pending: PendingEmail, given: EmailAddressStages) => {
      stages = given;
      return confirmed;
    }),
  };
  const close = vi.fn();
  const rendered = await render(AddEmailDialogComponent, {
    inputs: { accountId: ALICE },
    providers: [
      { provide: EmailAddressesWorkflow, useValue: workflow },
      { provide: TrnDialogRef, useValue: { close, titleId: 't' } },
    ],
  });
  const settle = async () => {
    await rendered.fixture.whenStable();
    rendered.fixture.detectChanges();
  };
  return {
    ...rendered,
    workflow,
    close,
    confirmed,
    stages: () => stages!,
    settle,
  };
}

async function sendLink(
  test: Awaited<ReturnType<typeof setup>>,
  value = 'a@b.c',
) {
  fireEvent.input(screen.getByTestId('add-email-input'), {
    target: { value },
  });
  fireEvent.click(screen.getByTestId('add-email-submit'));
  await test.settle();
}

async function expectNoAxeViolations(container: Element) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  expect(results.violations.map((v) => v.id)).toEqual([]);
}

describe('AddEmailDialogComponent', () => {
  it('sends the trimmed address and shows the sent step', async () => {
    const test = await setup();

    await sendLink(test, ' a@b.c ');

    expect(test.workflow.sendLink).toHaveBeenCalledWith(ALICE, 'a@b.c');
    expect(
      screen.getByRole('heading', { name: 'Check your email' }),
    ).toBeTruthy();
    expect(screen.getByTestId('add-email-sent').textContent).toContain(
      'We sent a link to a@b.c. Open it, then select Continue.',
    );
  });

  it('rejects an invalid address without calling the server', async () => {
    const test = await setup();

    await sendLink(test, 'not-an-email');

    expect(test.workflow.sendLink).not.toHaveBeenCalled();
    expect(screen.getByTestId('add-email-error').textContent).toContain(
      'Enter a valid email address.',
    );
  });

  it('shows a refusal from the server next to the field', async () => {
    const test = await setup();
    test.workflow.sendLink.mockReturnValueOnce(
      of({ kind: 'refused', reason: 'in-use' } as EmailLinkResult),
    );

    await sendLink(test);

    expect(screen.getByTestId('add-email-error').textContent).toContain(
      'That address is already used by another account.',
    );
  });

  it('stays on the sent step when the link has not been opened', async () => {
    const test = await setup();
    await sendLink(test);

    fireEvent.click(screen.getByTestId('add-email-continue'));
    test.confirmed.next({ kind: 'refused', reason: 'not-verified' });
    await test.settle();

    expect(screen.getByTestId('add-email-not-verified').textContent).toContain(
      'That link hasn’t been opened yet.',
    );
    expect(
      (screen.getByTestId('add-email-continue') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('disables Continue and Resend while a request runs', async () => {
    const test = await setup();
    await sendLink(test);

    fireEvent.click(screen.getByTestId('add-email-continue'));
    await test.settle();
    fireEvent.click(screen.getByTestId('add-email-continue'));
    fireEvent.click(screen.getByTestId('add-email-resend'));

    expect(test.workflow.add).toHaveBeenCalledTimes(1);
    expect(test.workflow.resend).not.toHaveBeenCalled();
    expect(
      (screen.getByTestId('add-email-continue') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('add-email-resend') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('says a new link was sent, and waits out a rate limit', async () => {
    const test = await setup();
    await sendLink(test);

    fireEvent.click(screen.getByTestId('add-email-resend'));
    await test.settle();
    expect(screen.getByTestId('add-email-resent').textContent).toContain(
      'We sent a new link to a@b.c.',
    );

    test.workflow.resend.mockReturnValueOnce(
      of({
        kind: 'refused',
        reason: 'rate-limited',
        retryAfterMs: 30000,
      } as EmailLinkResult),
    );
    fireEvent.click(screen.getByTestId('add-email-resend'));
    await test.settle();

    expect(screen.getByTestId('add-email-resend-error').textContent).toContain(
      'Too many tries. Try again in 30 seconds.',
    );
    expect(
      (screen.getByTestId('add-email-resend') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('re-enables Resend exactly when the rate-limit wait ends', async () => {
    const test = await setup();
    await sendLink(test);
    const resend = () =>
      screen.getByTestId('add-email-resend') as HTMLButtonElement;
    vi.useFakeTimers();
    try {
      test.workflow.resend.mockReturnValueOnce(
        of({
          kind: 'refused',
          reason: 'rate-limited',
          retryAfterMs: 3000,
        } as EmailLinkResult),
      );
      fireEvent.click(resend());
      test.fixture.detectChanges();
      expect(resend().disabled).toBe(true);

      vi.advanceTimersByTime(2999);
      test.fixture.detectChanges();
      expect(resend().disabled).toBe(true);

      vi.advanceTimersByTime(1);
      test.fixture.detectChanges();
      expect(resend().disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('acts on the account it was opened for, never the active one', async () => {
    const test = await setup();

    await sendLink(test);
    fireEvent.click(screen.getByTestId('add-email-continue'));

    expect(test.workflow.sendLink).toHaveBeenCalledWith(ALICE, 'a@b.c');
    expect(test.workflow.add).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ALICE, email: 'a@b.c' }),
      expect.anything(),
    );
  });

  it('answers the password stage and closes with added', async () => {
    const test = await setup();
    await sendLink(test);
    fireEvent.click(screen.getByTestId('add-email-continue'));

    const answer = test.stages().password({ rejected: false });
    await test.settle();
    expect(
      screen.getByRole('heading', { name: 'Enter your password' }),
    ).toBeTruthy();
    fireEvent.input(screen.getByTestId('add-email-password'), {
      target: { value: 'pw' },
    });
    fireEvent.click(screen.getByTestId('add-email-password-submit'));
    await expect(answer).resolves.toBe('pw');

    test.confirmed.next({ kind: 'added' });
    expect(test.close).toHaveBeenCalledWith({ kind: 'added', email: 'a@b.c' });
  });

  it('returns to the sent step when re-authentication is backed out of', async () => {
    const test = await setup();
    await sendLink(test);
    fireEvent.click(screen.getByTestId('add-email-continue'));
    const answer = test.stages().password({ rejected: false });
    await test.settle();

    fireEvent.click(screen.getByTestId('add-email-back'));
    await expect(answer).resolves.toBeNull();
    test.confirmed.next({ kind: 'refused', reason: 'cancelled' });
    await test.settle();

    expect(screen.getByTestId('add-email-sent')).toBeTruthy();
  });

  it('keeps the verified address and Continue working when the server is unreachable', async () => {
    const test = await setup();
    await sendLink(test);
    fireEvent.click(screen.getByTestId('add-email-continue'));

    test.confirmed.next({ kind: 'refused', reason: 'unreachable' });
    await test.settle();

    expect(screen.getByTestId('add-email-sent')).toBeTruthy();
    expect(screen.getByTestId('add-email-resend-error').textContent).toContain(
      'Trinity couldn’t reach example.org.',
    );
    const continueButton = screen.getByTestId(
      'add-email-continue',
    ) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(false);
    fireEvent.click(continueButton);
    expect(test.workflow.add).toHaveBeenCalledTimes(2);
    expect(test.workflow.add).toHaveBeenLastCalledWith(
      PENDING,
      expect.anything(),
    );
  });

  it('waits out a rate limit on Continue before it can be tried again', async () => {
    const test = await setup();
    await sendLink(test);
    const continueButton = () =>
      screen.getByTestId('add-email-continue') as HTMLButtonElement;
    vi.useFakeTimers();
    try {
      fireEvent.click(continueButton());
      test.confirmed.next({
        kind: 'refused',
        reason: 'rate-limited',
        retryAfterMs: 3000,
      });
      test.fixture.detectChanges();
      expect(
        screen.getByTestId('add-email-resend-error').textContent,
      ).toContain('Too many tries. Try again in 3 seconds.');
      expect(continueButton().disabled).toBe(true);

      vi.advanceTimersByTime(2999);
      test.fixture.detectChanges();
      expect(continueButton().disabled).toBe(true);

      vi.advanceTimersByTime(1);
      test.fixture.detectChanges();
      expect(continueButton().disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a neutral action to add the address after re-authentication', async () => {
    const test = await setup();
    await sendLink(test);
    fireEvent.click(screen.getByTestId('add-email-continue'));
    void test.stages().password({ rejected: false });
    await test.settle();

    expect(
      screen
        .getByTestId('add-email-password-submit')
        .getAttribute('data-trn-variant'),
    ).toBe('primary');
  });

  it('stops on other refusals', async () => {
    const test = await setup();
    await sendLink(test);
    fireEvent.click(screen.getByTestId('add-email-continue'));

    test.confirmed.next({ kind: 'refused', reason: 'attempts-exceeded' });
    await test.settle();

    expect(screen.getByTestId('add-email-stopped').textContent).toContain(
      'Too many incorrect passwords. The address wasn’t added.',
    );
  });

  it('cancels the request when the dialog closes during the password step', async () => {
    const test = await setup();
    await sendLink(test);
    fireEvent.click(screen.getByTestId('add-email-continue'));
    const answer = test.stages().password({ rejected: false });
    await test.settle();

    test.fixture.destroy();

    await expect(answer).resolves.toBeNull();
  });

  it('passes axe on each step', async () => {
    const test = await setup();
    await expectNoAxeViolations(test.container);

    await sendLink(test);
    await expectNoAxeViolations(test.container);

    fireEvent.click(screen.getByTestId('add-email-continue'));
    void test.stages().password({ rejected: true });
    await test.settle();
    await expectNoAxeViolations(test.container);

    test.confirmed.next({ kind: 'refused', reason: 'failed' });
    await test.settle();
    await expectNoAxeViolations(test.container);
  });
});
