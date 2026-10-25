import { TestBed } from '@angular/core/testing';
import axe from 'axe-core';
import { MockProvider } from 'ng-mocks';
import { Subject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TrnDialogRef } from '@trinity/components/overlay';
import {
  ACCOUNT_DELETION_LAUNCHER,
  ACCOUNT_REMOVAL_LAUNCHER,
  ExternalBrowserService,
  type AccountDeletionLauncher,
  type AccountDeletionOutcome,
  type AccountDeletionPrompts,
} from '@trinity/platform-native';
import { fireEvent, render, screen } from '@trinity/testing';
import { DeleteAccountDialogComponent } from './delete-account-dialog.component';

const ALICE = '@alice:example.org';

async function setup() {
  const outcome = new Subject<AccountDeletionOutcome>();
  let prompts: AccountDeletionPrompts | null = null;
  const launcher: Partial<AccountDeletionLauncher> = {
    delete: vi.fn((request) => {
      prompts = request.prompts;
      return outcome;
    }),
    checkDeletion: vi.fn(() => of({ kind: 'deleted' } as const)),
  };
  const close = vi.fn();
  const removal = { remove: vi.fn(() => of({ kind: 'kept' } as const)) };
  const rendered = await render(DeleteAccountDialogComponent, {
    inputs: { accountId: ALICE },
    providers: [
      { provide: ACCOUNT_DELETION_LAUNCHER, useValue: launcher },
      { provide: ACCOUNT_REMOVAL_LAUNCHER, useValue: removal },
      MockProvider(ExternalBrowserService, { open: vi.fn(() => of(true)) }),
      { provide: TrnDialogRef, useValue: { close, titleId: 't' } },
    ],
  });
  const settle = async () => {
    await rendered.fixture.whenStable();
    rendered.fixture.detectChanges();
  };
  return {
    ...rendered,
    cmp: rendered.fixture.componentInstance,
    launcher,
    removal,
    close,
    outcome,
    browser: TestBed.inject(ExternalBrowserService),
    prompts: () => prompts!,
    settle,
  };
}

async function typeAndSubmit(
  test: Awaited<ReturnType<typeof setup>>,
  typed: string,
) {
  fireEvent.input(screen.getByTestId('delete-account-confirm-input'), {
    target: { value: typed },
  });
  fireEvent.click(screen.getByTestId('delete-account-submit'));
  await test.settle();
}

async function expectNoAxeViolations(container: Element) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  expect(results.violations.map((v) => v.id)).toEqual([]);
}

describe('DeleteAccountDialogComponent', () => {
  it('states what deletion means for the exact account', async () => {
    await setup();

    expect(
      screen.getByRole('heading', { name: `Delete ${ALICE}?` }),
    ).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(
      screen.getByText(
        `The user ID ${ALICE} can’t be registered again, by you or anyone else.`,
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByTestId('delete-account-cancel')
        .hasAttribute('data-autofocus'),
    ).toBe(true);
  });

  it('checks Also erase my messages by default and lets it be cleared', async () => {
    const test = await setup();
    const erase = screen.getByLabelText(
      'Also erase my messages',
    ) as HTMLInputElement;

    expect(erase.checked).toBe(true);
    expect(erase.getAttribute('aria-describedby')).toBe(
      'delete-account-erase-description',
    );
    fireEvent.click(erase);
    await typeAndSubmit(test, 'DELETE');

    expect(test.launcher.delete).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ALICE, erase: false }),
    );
  });

  it('sends nothing when DELETE is mistyped, and says so next to the field', async () => {
    const test = await setup();

    await typeAndSubmit(test, 'DELET');

    expect(test.launcher.delete).not.toHaveBeenCalled();
    const field = screen.getByTestId('delete-account-confirm-input');
    expect(
      screen.getByTestId('delete-account-confirm-error').textContent,
    ).toContain('Nothing was deleted. Type DELETE exactly to confirm.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(
      'delete-account-confirm-error',
    );
    expect(document.activeElement).toBe(field);
  });

  it('accepts DELETE typed in any case with spaces around it', async () => {
    const test = await setup();

    await typeAndSubmit(test, '  delete ');

    expect(test.launcher.delete).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ALICE, erase: true }),
    );
  });

  it('asks for the password, then says when it was wrong', async () => {
    const test = await setup();
    await typeAndSubmit(test, 'DELETE');

    const first = test.prompts().password({ rejected: false });
    await test.settle();
    expect(
      screen.getByRole('heading', { name: 'Enter your password' }),
    ).toBeTruthy();
    const field = screen.getByTestId('delete-account-password');
    expect(field.getAttribute('autocomplete')).toBe('current-password');
    expect(document.activeElement).toBe(field);

    fireEvent.input(field, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('delete-account-password-submit'));
    await expect(first).resolves.toBe('wrong');
    await test.settle();
    expect(
      screen.getByTestId('delete-account-deleting').getAttribute('role'),
    ).toBe('status');

    void test.prompts().password({ rejected: true });
    await test.settle();
    expect(
      screen.getByTestId('delete-account-password-error').textContent,
    ).toContain('That password is incorrect. Nothing was deleted.');
  });

  it('does not send an empty password', async () => {
    const test = await setup();
    await typeAndSubmit(test, 'DELETE');
    let answered = false;
    void test
      .prompts()
      .password({ rejected: false })
      .then(() => (answered = true));
    await test.settle();

    fireEvent.click(screen.getByTestId('delete-account-password-submit'));
    await test.settle();

    expect(answered).toBe(false);
    expect(screen.getByTestId('delete-account-password')).toBeTruthy();
  });

  it('forgets the password once it is submitted', async () => {
    const test = await setup();
    await typeAndSubmit(test, 'DELETE');
    void test.prompts().password({ rejected: false });
    await test.settle();

    fireEvent.input(screen.getByTestId('delete-account-password'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByTestId('delete-account-password-submit'));
    await test.settle();
    void test.prompts().password({ rejected: true });
    await test.settle();

    expect(
      (screen.getByTestId('delete-account-password') as HTMLInputElement).value,
    ).toBe('');
  });

  it('titles a refusal as nothing deleted and names one control Cancel', async () => {
    const test = await setup();
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
    await typeAndSubmit(test, 'DELETE');

    test.outcome.next({ kind: 'kept', reason: 'forbidden' });
    await test.settle();

    expect(
      screen.getByRole('heading', { name: 'Nothing was deleted' }),
    ).toBeTruthy();
  });

  it('moves focus to the heading when Back returns to the first step', async () => {
    const test = await setup();
    await typeAndSubmit(test, 'DELETE');
    void test.prompts().password({ rejected: false });
    await test.settle();

    fireEvent.click(screen.getByTestId('delete-account-back'));
    test.outcome.next({ kind: 'kept', reason: 'cancelled' });
    await test.settle();

    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: `Delete ${ALICE}?` }),
    );
  });

  it('ends after too many passwords with only Close', async () => {
    const test = await setup();
    await typeAndSubmit(test, 'DELETE');

    test.outcome.next({ kind: 'kept', reason: 'attempts-exceeded' });
    await test.settle();

    expect(screen.getByTestId('delete-account-stopped').textContent).toContain(
      'Too many incorrect passwords. Nothing was deleted.',
    );
    expect(screen.queryByTestId('delete-account-retry')).toBeNull();
    expect(screen.getByTestId('delete-account-close')).toBeTruthy();
  });

  it('goes back to the first step when Back cancels the password', async () => {
    const test = await setup();
    await typeAndSubmit(test, 'DELETE');
    const answer = test.prompts().password({ rejected: false });
    await test.settle();

    fireEvent.click(screen.getByTestId('delete-account-back'));
    await expect(answer).resolves.toBeNull();
    test.outcome.next({ kind: 'kept', reason: 'cancelled' });
    await test.settle();

    expect(screen.getByTestId('delete-account-confirm-input')).toBeTruthy();
  });

  it('enables the browser confirmation only after the page was opened', async () => {
    const test = await setup();
    await typeAndSubmit(test, 'DELETE');
    const finished = test.prompts().confirmInBrowser({
      url: 'https://example.org/fallback?session=s',
      pending: false,
    });
    await test.settle();
    const confirm = screen.getByTestId(
      'delete-account-browser-confirm',
    ) as HTMLButtonElement;

    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('delete-account-open-page'));
    await test.settle();
    expect(test.browser.open).toHaveBeenCalledWith(
      'https://example.org/fallback?session=s',
    );
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await expect(finished).resolves.toBe(true);
  });

  it('says when the server has not seen the browser confirmation yet', async () => {
    const test = await setup();
    await typeAndSubmit(test, 'DELETE');

    void test.prompts().confirmInBrowser({ url: 'https://x/', pending: true });
    await test.settle();

    expect(
      screen.getByTestId('delete-account-browser-pending').textContent,
    ).toContain('example.org hasn’t received your confirmation yet.');
  });

  it('cannot be dismissed while the request is in flight', async () => {
    const test = await setup();
    expect(test.cmp.canDismiss()).toBe(true);

    await typeAndSubmit(test, 'DELETE');

    expect(test.cmp.canDismiss()).toBe(false);
    expect(screen.queryByTestId('dialog-close')).toBeNull();
  });

  it('moves focus to the heading of a step without a field', async () => {
    const test = await setup();
    await typeAndSubmit(test, 'DELETE');

    test.outcome.next({ kind: 'kept', reason: 'unreachable' });
    await test.settle();

    const heading = screen.getByRole('heading', {
      name: 'Nothing was deleted',
    });
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(heading);
    expect(screen.getByTestId('delete-account-stopped').textContent).toContain(
      'Trinity couldn’t reach example.org. Nothing was deleted.',
    );
  });

  it('offers to check again or remove the account here when the result is unknown', async () => {
    const test = await setup();
    await typeAndSubmit(test, 'DELETE');
    test.outcome.next({ kind: 'unconfirmed' });
    await test.settle();

    fireEvent.click(screen.getByTestId('delete-account-check-again'));
    expect(test.launcher.checkDeletion).toHaveBeenCalledWith(ALICE);

    test.outcome.next({ kind: 'unconfirmed' });
    await test.settle();
    fireEvent.click(screen.getByTestId('delete-account-remove-here'));
    expect(test.close).toHaveBeenCalled();
    expect(test.removal.remove).toHaveBeenCalledWith(ALICE);
  });

  it('closes itself with a result once the account is deleted', async () => {
    const test = await setup();
    await typeAndSubmit(test, 'DELETE');

    test.outcome.next({ kind: 'deleted' });

    expect(test.close).toHaveBeenCalledWith('deleted');
  });

  it('answers an open prompt when the dialog goes away', async () => {
    const test = await setup();
    await typeAndSubmit(test, 'DELETE');
    const answer = test.prompts().password({ rejected: false });
    await test.settle();

    test.fixture.destroy();

    await expect(answer).resolves.toBeNull();
  });

  it('settles a prompt that arrives after the dialog went away', async () => {
    const test = await setup();
    await typeAndSubmit(test, 'DELETE');

    test.fixture.destroy();

    await expect(
      test.prompts().password({ rejected: false }),
    ).resolves.toBeNull();
  });

  it('keeps the re-authentication actions destructive', async () => {
    const test = await setup();
    await typeAndSubmit(test, 'DELETE');
    const answer = test.prompts().password({ rejected: false });
    await test.settle();
    expect(
      screen
        .getByTestId('delete-account-password-submit')
        .getAttribute('data-trn-variant'),
    ).toBe('danger');

    fireEvent.click(screen.getByTestId('delete-account-back'));
    await expect(answer).resolves.toBeNull();
    void test.prompts().confirmInBrowser({ url: 'https://x/', pending: false });
    await test.settle();
    expect(
      screen
        .getByTestId('delete-account-browser-confirm')
        .getAttribute('data-trn-variant'),
    ).toBe('danger');
  });

  it('passes axe on each step', async () => {
    const test = await setup();
    await expectNoAxeViolations(test.container);

    await typeAndSubmit(test, 'DELETE');
    await expectNoAxeViolations(test.container);

    void test.prompts().password({ rejected: true });
    await test.settle();
    await expectNoAxeViolations(test.container);

    test.outcome.next({
      kind: 'kept',
      reason: 'rate-limited',
      retryAfterMs: 2000,
    });
    await test.settle();
    await expectNoAxeViolations(test.container);
  });
});
