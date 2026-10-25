import { TestBed } from '@angular/core/testing';
import axe from 'axe-core';
import { MockProvider } from 'ng-mocks';
import { Subject, of, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  TrnAlertService,
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  EmailAddressesWorkflow,
  type ContactAddress,
  type EmailAddressesLoad,
  type EmailRemoveResult,
} from '@trinity/data-access/contact-addresses';
import { fireEvent, render, screen } from '@trinity/testing';
import { AddEmailDialogComponent } from './add-email-dialog.component';
import { EmailAddressesGroupComponent } from './email-addresses-group.component';

const ALICE = '@alice:example.org';
const ADDRESS: ContactAddress = { medium: 'email', address: 'a@b.c' };
const loaded = (
  addresses: readonly ContactAddress[],
  canChange = true,
): EmailAddressesLoad => ({ kind: 'loaded', addresses, canChange });

async function setup(
  first: EmailAddressesLoad,
  kind: 'legacy' | 'oauth' = 'legacy',
) {
  const closed = new Subject<unknown>();
  const confirmed = new Subject<boolean>();
  const workflow = {
    load: vi.fn((): Observable<EmailAddressesLoad> => of(first)),
    remove: vi.fn((): Observable<EmailRemoveResult> => of({ kind: 'removed' })),
  };
  const rendered = await render(EmailAddressesGroupComponent, {
    inputs: { accountId: ALICE, accountKind: kind },
    providers: [
      { provide: EmailAddressesWorkflow, useValue: workflow },
      MockProvider(TrnSurfaceService, {
        open: vi.fn(() => ({ closed }) as never),
      }),
      MockProvider(TrnAlertService, {
        confirm$: vi.fn(() => confirmed.asObservable()),
      }),
      MockProvider(TrnToastService),
    ],
  });
  return {
    ...rendered,
    workflow,
    closed,
    confirmed,
    alert: TestBed.inject(TrnAlertService),
    surfaces: TestBed.inject(TrnSurfaceService),
    toast: TestBed.inject(TrnToastService),
  };
}

async function expectNoAxeViolations(container: Element) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  expect(results.violations.map((v) => v.id)).toEqual([]);
}

describe('EmailAddressesGroupComponent', () => {
  it('oauth shows the provider line and no list', async () => {
    const test = await setup(loaded([]), 'oauth');

    expect(
      screen.getByText(
        'Your email addresses are managed by your identity provider.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(test.workflow.load).not.toHaveBeenCalled();
  });

  it('lists addresses with a named Remove button each', async () => {
    const test = await setup(
      loaded([ADDRESS, { medium: 'msisdn', address: '+4912345' }]),
    );

    expect(test.workflow.load).toHaveBeenCalledWith(ALICE);
    expect(screen.getByRole('button', { name: 'Remove a@b.c' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Remove +4912345' }),
    ).toBeTruthy();
    await expectNoAxeViolations(test.container);
  });

  it('shows the empty line for an empty list', async () => {
    await setup(loaded([]));

    expect(
      screen.getByText(
        'No email address yet. Add one so you can reset your password.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Add email address' }),
    ).toBeTruthy();
  });

  it('read-only server hides Add and Remove and shows readOnlyLine', async () => {
    const test = await setup(loaded([ADDRESS], false));

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('a@b.c')).toBeTruthy();
    expect(
      screen.getByText('example.org manages the addresses on this account.'),
    ).toBeTruthy();
    await expectNoAxeViolations(test.container);
  });

  it('failed load shows loadFailed and Try again reloads', async () => {
    const test = await setup({ kind: 'refused', reason: 'unreachable' });

    expect(
      screen.getByText(
        'Trinity couldn’t load your email addresses from example.org.',
      ),
    ).toBeTruthy();

    test.workflow.load.mockReturnValue(of(loaded([ADDRESS])));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Remove a@b.c' });

    expect(test.workflow.load).toHaveBeenCalledTimes(2);
  });

  it('removing confirms, then reloads, toasts and announces', async () => {
    const test = await setup(loaded([ADDRESS]));
    fireEvent.click(screen.getByRole('button', { name: 'Remove a@b.c' }));

    expect(test.alert.confirm$).toHaveBeenCalledWith({
      header: 'Remove a@b.c?',
      message: 'You won’t be able to reset your password with it.',
      confirmText: 'Remove',
      variant: 'danger',
    });
    expect(test.workflow.remove).not.toHaveBeenCalled();

    test.workflow.load.mockReturnValue(of(loaded([])));
    test.confirmed.next(true);
    await test.fixture.whenStable();

    expect(test.workflow.remove).toHaveBeenCalledWith(ALICE, ADDRESS);
    expect(test.workflow.load).toHaveBeenCalledTimes(2);
    expect(test.toast.show).toHaveBeenCalledWith('a@b.c was removed.');
    expect(screen.getByRole('status').textContent).toContain(
      'a@b.c was removed.',
    );
  });

  it('does not remove when the confirmation is cancelled', async () => {
    const test = await setup(loaded([ADDRESS]));
    fireEvent.click(screen.getByRole('button', { name: 'Remove a@b.c' }));
    test.confirmed.next(false);
    await test.fixture.whenStable();

    expect(test.workflow.remove).not.toHaveBeenCalled();
  });

  it('says why a removal was refused and keeps the list', async () => {
    const test = await setup(loaded([ADDRESS]));
    test.workflow.remove.mockReturnValue(
      of({ kind: 'refused', reason: 'failed' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove a@b.c' }));
    test.confirmed.next(true);
    await test.fixture.whenStable();

    expect(screen.getByTestId('email-addresses-error').textContent).toContain(
      'Something went wrong. Try again.',
    );
    expect(test.workflow.load).toHaveBeenCalledTimes(1);
  });

  it('a closed add dialog with added reloads and announces added', async () => {
    const test = await setup(loaded([]));
    fireEvent.click(screen.getByRole('button', { name: 'Add email address' }));

    const options = vi.mocked(test.surfaces.open).mock.calls[0][1]!;
    expect(test.surfaces.open).toHaveBeenCalledWith(
      AddEmailDialogComponent,
      expect.objectContaining({
        ariaDescribedBy: 'add-email-body',
        inputs: { accountId: ALICE },
      }),
    );
    expect(options.dismissGuard?.({ canDismiss: () => false } as never)).toBe(
      false,
    );

    test.workflow.load.mockReturnValue(of(loaded([ADDRESS])));
    test.closed.next({ kind: 'added', email: 'a@b.c' });
    await test.fixture.whenStable();

    expect(test.workflow.load).toHaveBeenCalledTimes(2);
    expect(test.toast.show).toHaveBeenCalledWith('a@b.c was added.');
    expect(screen.getByRole('status').textContent).toContain(
      'a@b.c was added.',
    );
  });

  it('names the added address once even when the reload fails', async () => {
    const test = await setup(loaded([ADDRESS]));
    fireEvent.click(screen.getByRole('button', { name: 'Add email address' }));
    test.workflow.load.mockReturnValue(
      of({ kind: 'refused', reason: 'unreachable' } as const),
    );
    test.closed.next({ kind: 'added', email: 'new@b.c' });
    await test.fixture.whenStable();

    test.workflow.load.mockReturnValue(of(loaded([ADDRESS])));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Remove a@b.c' });

    expect(test.toast.show).toHaveBeenCalledTimes(1);
    expect(test.toast.show).toHaveBeenCalledWith('new@b.c was added.');
  });

  it('confirms an added address that was already listed', async () => {
    const test = await setup(loaded([ADDRESS]));
    fireEvent.click(screen.getByRole('button', { name: 'Add email address' }));
    test.closed.next({ kind: 'added', email: 'a@b.c' });
    await test.fixture.whenStable();

    expect(test.toast.show).toHaveBeenCalledWith('a@b.c was added.');
  });

  it('removes from the account the confirmation was opened for', async () => {
    const test = await setup(loaded([ADDRESS]));
    fireEvent.click(screen.getByRole('button', { name: 'Remove a@b.c' }));

    test.fixture.componentRef.setInput('accountId', '@bob:example.org');
    await test.fixture.whenStable();
    test.workflow.load.mockClear();
    test.confirmed.next(true);
    await test.fixture.whenStable();

    expect(test.workflow.remove).toHaveBeenCalledWith(ALICE, ADDRESS);
    expect(test.toast.show).toHaveBeenCalledWith('a@b.c was removed.');
    expect(test.workflow.load).not.toHaveBeenCalled();
  });

  it('does not reload when the add dialog was dismissed', async () => {
    const test = await setup(loaded([]));
    fireEvent.click(screen.getByRole('button', { name: 'Add email address' }));
    test.closed.next(undefined);
    await test.fixture.whenStable();

    expect(test.workflow.load).toHaveBeenCalledTimes(1);
  });
});
