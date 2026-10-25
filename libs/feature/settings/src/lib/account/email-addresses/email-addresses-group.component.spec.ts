import { By } from '@angular/platform-browser';
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
  IdentityServerService,
  type ContactAddress,
  type EmailAddressesLoad,
  type EmailRemoveResult,
  type IdentityServerChoice,
  type IdentityServerRefused,
} from '@trinity/data-access/contact-addresses';
import { fireEvent, render, screen } from '@trinity/testing';
import { AddEmailDialogComponent } from './add-email-dialog.component';
import { ChangeIdentityServerDialogComponent } from './change-identity-server-dialog.component';
import { EmailAddressesGroupComponent } from './email-addresses-group.component';
import { IdentityServerRowComponent } from './identity-server-row.component';
import { IdentityTermsDialogComponent } from './identity-terms-dialog.component';
import { PublishEmailDialogComponent } from './publish-email-dialog.component';

const ALICE = '@alice:example.org';
const ADDRESS: ContactAddress = { medium: 'email', address: 'a@b.c' };
const loaded = (
  addresses: readonly ContactAddress[],
  canChange = true,
): EmailAddressesLoad => ({ kind: 'loaded', addresses, canChange });

async function setup(
  first: EmailAddressesLoad,
  kind: 'legacy' | 'oauth' = 'legacy',
  choice: IdentityServerChoice | IdentityServerRefused = { kind: 'none' },
  findable?: Observable<unknown>,
) {
  const closed = new Subject<unknown>();
  const closers: Subject<unknown>[] = [closed];
  let opened = 0;
  const confirmed = new Subject<boolean>();
  const workflow = {
    load: vi.fn((): Observable<EmailAddressesLoad> => of(first)),
    remove: vi.fn((): Observable<EmailRemoveResult> =>
      of({ kind: 'removed', unbind: 'success' }),
    ),
  };
  const identity = {
    choice: vi.fn(() => of(choice)),
    unpublishAll: vi.fn(() => of({ kind: 'unpublished' } as const)),
    turnOff: vi.fn(() => of({ kind: 'saved' } as const)),
    use: vi.fn((): Observable<unknown> =>
      of({ kind: 'saved', url: 'https://vector.im' } as const),
    ),
    terms: vi.fn((): Observable<unknown> => of({ kind: 'accepted' } as const)),
    acceptTerms: vi.fn((): Observable<unknown> =>
      of({ kind: 'accepted' } as const),
    ),
    unpublish: vi.fn((): Observable<unknown> =>
      of({ kind: 'unpublished' } as const),
    ),
    findable: vi.fn(
      (): Observable<unknown> =>
        findable ??
        of({ kind: 'loaded', published: new Set(['a@b.c']) } as const),
    ),
  };
  const rendered = await render(EmailAddressesGroupComponent, {
    inputs: { accountId: ALICE, accountKind: kind },
    providers: [
      { provide: EmailAddressesWorkflow, useValue: workflow },
      { provide: IdentityServerService, useValue: identity },
      MockProvider(TrnSurfaceService, {
        open: vi.fn(() => {
          closers[opened] ??= new Subject<unknown>();
          return { closed: closers[opened++] } as never;
        }),
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
    identity,
    closed,
    closers,
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

    expect(screen.queryByRole('button', { name: /^(Remove|Add)/ })).toBeNull();
    expect(screen.getByTestId('identity-server-row')).toBeTruthy();
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

  it('loads the choice and the findable emails only for a set server on a legacy account', async () => {
    const set: IdentityServerChoice = {
      kind: 'set',
      url: 'https://vector.im',
      source: 'account',
    };
    const test = await setup(
      loaded([ADDRESS, { medium: 'msisdn', address: '+4912345' }]),
      'legacy',
      set,
    );

    expect(test.identity.findable).toHaveBeenCalledWith(
      ALICE,
      'https://vector.im',
      ['a@b.c'],
    );
    expect(screen.getByTestId('identity-server-value').textContent).toBe(
      'vector.im',
    );
  });

  it('does not contact a well-known identity server on load', async () => {
    const test = await setup(loaded([ADDRESS]), 'legacy', {
      kind: 'set',
      url: 'https://vector.im',
      source: 'well-known',
    });

    expect(test.identity.findable).not.toHaveBeenCalled();
    expect(screen.getByTestId('identity-server-value').textContent).toBe(
      'vector.im',
    );
  });

  it('treats a refused findable as unknown and offers every email to unpublish', async () => {
    const test = await setup(
      loaded([ADDRESS]),
      'legacy',
      { kind: 'set', url: 'https://vector.im', source: 'account' },
      of({ kind: 'refused', reason: 'unreachable' }),
    );
    fireEvent.click(screen.getByTestId('identity-server-turn-off'));

    expect(test.alert.confirm$).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message:
          'Trinity will first stop vector.im from finding you by 1 address.',
      }),
    );
    test.confirmed.next(true);

    expect(test.identity.unpublishAll).toHaveBeenCalledWith(
      ALICE,
      'https://vector.im',
      ['a@b.c'],
    );
  });

  it('says why the choice cannot be read and Try again reloads it', async () => {
    const test = await setup(loaded([ADDRESS]), 'legacy', {
      kind: 'refused',
      reason: 'unreachable',
    });

    expect(screen.queryByTestId('identity-server-row')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove a@b.c' })).toBeTruthy();
    expect(screen.getByTestId('identity-server-error').textContent).toContain(
      'Trinity couldn’t reach example.org. Try again later.',
    );

    test.identity.choice.mockReturnValue(of({ kind: 'off' }));
    fireEvent.click(screen.getByTestId('identity-server-retry'));
    await test.fixture.whenStable();
    test.fixture.detectChanges();

    expect(test.identity.choice).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('identity-server-value').textContent).toBe('Off');
    expect(screen.queryByTestId('identity-server-error')).toBeNull();
  });

  it('lists the addresses while what is findable is still loading', async () => {
    await setup(
      loaded([ADDRESS]),
      'legacy',
      { kind: 'set', url: 'https://vector.im', source: 'account' },
      new Subject<never>(),
    );

    expect(screen.getByRole('button', { name: 'Remove a@b.c' })).toBeTruthy();
    expect(screen.queryByTestId('identity-server-row')).toBeNull();
  });

  it('reloads the list and what is findable when the row changed', async () => {
    const test = await setup(loaded([ADDRESS]), 'legacy', {
      kind: 'set',
      url: 'https://vector.im',
      source: 'account',
    });
    test.workflow.load.mockClear();
    fireEvent.click(screen.getByTestId('identity-server-turn-off'));
    test.confirmed.next(true);
    await test.fixture.whenStable();

    expect(test.workflow.load).toHaveBeenCalledTimes(1);
  });

  it('shows the row for an off server without asking what is findable', async () => {
    const test = await setup(loaded([ADDRESS]), 'legacy', { kind: 'off' });

    expect(test.identity.findable).not.toHaveBeenCalled();
    expect(screen.getByTestId('identity-server-value').textContent).toBe('Off');
  });

  it('oauth accounts get no identity server row and no lookups', async () => {
    const test = await setup(loaded([]), 'oauth');

    expect(screen.queryByTestId('identity-server-row')).toBeNull();
    expect(test.identity.choice).not.toHaveBeenCalled();
  });

  it('warns that the server may still list a removed address when it cannot unbind', async () => {
    const test = await setup(loaded([ADDRESS]), 'legacy', {
      kind: 'set',
      url: 'https://vector.im',
      source: 'account',
    });
    test.workflow.remove.mockReturnValue(
      of({ kind: 'removed', unbind: 'no-support' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove a@b.c' }));
    test.confirmed.next(true);
    await test.fixture.whenStable();

    const line =
      'a@b.c was removed. vector.im may still let people find you by it.';
    expect(test.toast.show).toHaveBeenCalledWith(line);
    expect(screen.getByRole('status').textContent).toContain(line);
  });

  it('warns without a host when no identity server is chosen and it cannot unbind', async () => {
    const test = await setup(loaded([ADDRESS]));
    test.workflow.remove.mockReturnValue(
      of({ kind: 'removed', unbind: 'no-support' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove a@b.c' }));
    test.confirmed.next(true);
    await test.fixture.whenStable();

    expect(test.toast.show).toHaveBeenCalledWith(
      'a@b.c was removed. An identity server may still let people find you by it.',
    );
  });
});

describe('EmailAddressesGroupComponent findable switches', () => {
  const ACCOUNT: IdentityServerChoice = {
    kind: 'set',
    url: 'https://vector.im',
    source: 'account',
  };
  const found = (...emails: string[]) =>
    of({ kind: 'loaded', published: new Set(emails) } as const);
  const toggle = (index = 0) =>
    screen
      .getByTestId(`findable-${index}`)
      .querySelector<HTMLInputElement>('input')!;

  async function ready(
    findable: Observable<unknown> = found(),
    choice: IdentityServerChoice = ACCOUNT,
  ) {
    const test = await setup(loaded([ADDRESS]), 'legacy', choice, findable);
    await test.fixture.whenStable();
    test.fixture.detectChanges();
    return test;
  }
  const settle = async (test: Awaited<ReturnType<typeof ready>>) => {
    await test.fixture.whenStable();
    test.fixture.detectChanges();
  };

  it('shows each switch from what the server finds, named by its email', async () => {
    await ready(found('a@b.c'));

    expect(toggle().checked).toBe(true);
    expect(toggle().getAttribute('aria-label')).toBe(
      'Findable: let people find you by a@b.c',
    );
    expect(screen.getByText('Findable')).toBeTruthy();
  });

  it('shows the failure line and disables the switches when findable is refused', async () => {
    await ready(of({ kind: 'refused', reason: 'unreachable' } as const));

    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(true);
    expect(screen.getByTestId('findable-error').textContent).toContain(
      'Trinity couldn’t reach vector.im. Try again later.',
    );
  });

  describe('when the server needs the terms signed', () => {
    const TERMS = of({ kind: 'terms-needed' } as const);
    const EMAILS = loaded([
      ADDRESS,
      { medium: 'email', address: 'd@e.f' },
      { medium: 'msisdn', address: '+31600000000' },
    ]);
    const readyWithTerms = async () => {
      const test = await setup(EMAILS, 'legacy', ACCOUNT, TERMS);
      await settle(test);
      return test;
    };

    it('shows enabled switches that are off', async () => {
      await readyWithTerms();

      expect(toggle().checked).toBe(false);
      expect(toggle().disabled).toBe(false);
      expect(screen.queryByTestId('findable-error')).toBeNull();
    });

    it('unpublishes every email before turning off', async () => {
      const test = await readyWithTerms();
      fireEvent.click(screen.getByTestId('identity-server-turn-off'));

      expect(test.alert.confirm$).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            'Trinity will first stop vector.im from finding you by 2 addresses.',
        }),
      );
      test.confirmed.next(true);

      expect(test.identity.unpublishAll).toHaveBeenCalledWith(
        ALICE,
        'https://vector.im',
        ['a@b.c', 'd@e.f'],
      );
    });

    it('offers every email to unpublish before changing', async () => {
      const test = await readyWithTerms();
      fireEvent.click(screen.getByTestId('identity-server-change'));

      expect(test.surfaces.open).toHaveBeenCalledWith(
        ChangeIdentityServerDialogComponent,
        expect.objectContaining({
          inputs: {
            accountId: ALICE,
            current: 'https://vector.im',
            published: ['a@b.c', 'd@e.f'],
          },
        }),
      );
    });
  });

  it.each([{ kind: 'off' }, { kind: 'none' }] as const)(
    'renders no switches for %j',
    async (choice) => {
      await ready(found(), choice);

      expect(screen.queryByTestId('findable-0')).toBeNull();
    },
  );

  it('goes straight to the publish dialog when terms are accepted', async () => {
    const test = await ready();

    fireEvent.click(toggle());
    await settle(test);

    expect(test.identity.terms).toHaveBeenCalledWith(
      ALICE,
      'https://vector.im',
    );
    expect(test.surfaces.open).toHaveBeenCalledWith(
      PublishEmailDialogComponent,
      expect.objectContaining({
        ariaDescribedBy: 'publish-email-body',
        inputs: { accountId: ALICE, url: 'https://vector.im', email: 'a@b.c' },
      }),
    );
  });

  const POLICIES = [
    { id: 'tos', name: 'Terms', url: 'https://vector.im/tos', version: '1' },
  ];
  const needsConsent = (test: Awaited<ReturnType<typeof ready>>) =>
    test.identity.terms.mockReturnValue(
      of({ kind: 'needs-consent', policies: POLICIES } as const),
    );

  it('Not now sends nothing further and leaves the switch off', async () => {
    const test = await ready();
    needsConsent(test);

    fireEvent.click(toggle());
    await settle(test);
    expect(test.surfaces.open).toHaveBeenCalledWith(
      IdentityTermsDialogComponent,
      expect.objectContaining({
        ariaDescribedBy: 'identity-terms-body',
        inputs: { host: 'vector.im', policies: POLICIES },
      }),
    );
    test.closers[0].next(undefined);
    await settle(test);

    expect(test.identity.acceptTerms).not.toHaveBeenCalled();
    expect(test.surfaces.open).toHaveBeenCalledTimes(1);
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(false);
  });

  it('Accept saves the consent, then opens the publish dialog', async () => {
    const test = await ready();
    needsConsent(test);

    fireEvent.click(toggle());
    await settle(test);
    test.closers[0].next(true);
    await settle(test);

    expect(test.identity.acceptTerms).toHaveBeenCalledWith(
      ALICE,
      'https://vector.im',
      POLICIES,
    );
    expect(vi.mocked(test.surfaces.open).mock.calls[1][0]).toBe(
      PublishEmailDialogComponent,
    );
  });

  it('a published result toasts, re-reads and sets the switch on', async () => {
    const test = await ready();

    fireEvent.click(toggle());
    await settle(test);
    test.identity.findable.mockReturnValue(found('a@b.c'));
    test.closers[0].next({ kind: 'published' });
    await settle(test);

    expect(test.toast.show).toHaveBeenCalledWith(
      'People who know a@b.c can now find you.',
    );
    expect(test.identity.findable).toHaveBeenCalledTimes(2);
    expect(toggle().checked).toBe(true);
  });

  const WELL_KNOWN: IdentityServerChoice = {
    kind: 'set',
    url: 'https://vector.im',
    source: 'well-known',
  };

  it('does not save a well-known server when its terms get Not now', async () => {
    const test = await ready(found(), WELL_KNOWN);
    needsConsent(test);

    fireEvent.click(toggle());
    await settle(test);
    test.closers[0].next(undefined);
    await settle(test);

    expect(test.identity.use).not.toHaveBeenCalled();
  });

  it('saves a well-known server after its terms are accepted, before publishing', async () => {
    const test = await ready(found(), WELL_KNOWN);
    needsConsent(test);
    const order: string[] = [];
    test.identity.acceptTerms.mockImplementation(() => {
      order.push('acceptTerms');
      return of({ kind: 'accepted' } as const);
    });
    test.identity.use.mockImplementation(() => {
      order.push('use');
      return of({ kind: 'saved', url: 'https://vector.im' } as const);
    });
    vi.mocked(test.surfaces.open).mockImplementation(((component: unknown) => {
      order.push(
        component === PublishEmailDialogComponent ? 'publish' : 'terms',
      );
      const index = order.filter(
        (o) => o === 'publish' || o === 'terms',
      ).length;
      test.closers[index - 1] ??= new Subject<unknown>();
      return { closed: test.closers[index - 1] };
    }) as never);

    fireEvent.click(toggle());
    await settle(test);
    test.closers[0].next(true);
    await settle(test);

    expect(order).toEqual(['terms', 'acceptTerms', 'use', 'publish']);
  });

  it('first saves a well-known server as the account’s choice', async () => {
    const test = await ready(found(), WELL_KNOWN);
    expect(test.identity.findable).not.toHaveBeenCalled();

    fireEvent.click(toggle());
    await settle(test);

    expect(test.identity.use).toHaveBeenCalledWith(ALICE, 'https://vector.im');
    expect(test.identity.terms.mock.invocationCallOrder[0]).toBeLessThan(
      test.identity.use.mock.invocationCallOrder[0],
    );
    expect(
      vi.mocked(test.surfaces.open).mock.invocationCallOrder[0],
    ).toBeGreaterThan(test.identity.use.mock.invocationCallOrder[0]);
    const row = test.fixture.debugElement.query(
      By.directive(IdentityServerRowComponent),
    );
    expect(row.componentInstance.choice()).toEqual({
      kind: 'set',
      url: 'https://vector.im',
      source: 'account',
    });
  });

  it('stops with the failure line when the well-known server cannot be saved', async () => {
    const test = await ready(found(), {
      kind: 'set',
      url: 'https://vector.im',
      source: 'well-known',
    });
    test.identity.use.mockReturnValue(
      of({ kind: 'refused', reason: 'unreachable' } as const),
    );

    fireEvent.click(toggle());
    await settle(test);

    expect(test.surfaces.open).not.toHaveBeenCalled();
    expect(screen.getByTestId('email-addresses-error').textContent).toContain(
      'Trinity couldn’t reach vector.im.',
    );
  });

  it('turning off unpublishes, re-reads, toasts and sets the switch off', async () => {
    const test = await ready(found('a@b.c'));
    test.identity.findable.mockReturnValue(found());

    fireEvent.click(toggle());
    await settle(test);

    expect(test.identity.unpublish).toHaveBeenCalledWith(
      ALICE,
      'https://vector.im',
      'a@b.c',
    );
    expect(test.toast.show).toHaveBeenCalledWith(
      'People can no longer find you by a@b.c.',
    );
    expect(toggle().checked).toBe(false);
  });

  it('does not claim success when the server still lists the address', async () => {
    const test = await ready(found('a@b.c'));

    fireEvent.click(toggle());
    await settle(test);

    expect(test.toast.show).not.toHaveBeenCalled();
    expect(screen.getByTestId('email-addresses-error').textContent).toContain(
      'vector.im may still let people find you by a@b.c.',
    );
    expect(toggle().checked).toBe(true);
    expect(screen.getByRole('status').textContent).toContain(
      'vector.im may still let people find you by a@b.c.',
    );
  });

  it('keeps a busy switch focusable and ignores a second toggle while a request is in flight', async () => {
    const test = await ready(found('a@b.c'));
    test.identity.unpublish.mockReturnValue(new Subject<unknown>());

    fireEvent.click(toggle());
    test.fixture.detectChanges();
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(toggle());

    expect(test.identity.unpublish).toHaveBeenCalledTimes(1);
    expect(test.identity.terms).not.toHaveBeenCalled();
  });

  it('disables the identity server row while a toggle is in flight', async () => {
    const test = await ready(found('a@b.c'));
    test.identity.unpublish.mockReturnValue(new Subject<unknown>());

    fireEvent.click(toggle());
    test.fixture.detectChanges();

    for (const id of ['identity-server-change', 'identity-server-turn-off']) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('declines toggles while the row is turning the server off', async () => {
    const test = await ready(found('a@b.c'));
    test.identity.unpublishAll.mockReturnValue(new Subject<never>() as never);

    fireEvent.click(screen.getByTestId('identity-server-turn-off'));
    test.confirmed.next(true);
    test.fixture.detectChanges();
    await test.fixture.whenStable();
    test.fixture.detectChanges();
    expect(toggle().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(toggle());

    expect(test.identity.unpublish).not.toHaveBeenCalled();
  });

  it('offers Try again after a failed read, which reloads', async () => {
    const test = await ready(
      of({ kind: 'refused', reason: 'unreachable' } as const),
    );

    test.identity.findable.mockReturnValue(found('a@b.c'));
    fireEvent.click(screen.getByTestId('findable-retry'));
    await settle(test);

    expect(test.workflow.load).toHaveBeenCalledTimes(2);
    expect(toggle().checked).toBe(true);
    expect(screen.queryByTestId('findable-error')).toBeNull();
  });

  it('gives a phone number no switch', async () => {
    const test = await setup(
      loaded([ADDRESS, { medium: 'msisdn', address: '+4912345' }]),
      'legacy',
      ACCOUNT,
    );
    await settle(test);

    expect(screen.getByTestId('findable-0')).toBeTruthy();
    expect(screen.queryByTestId('findable-1')).toBeNull();
  });

  it('opens the terms dialog focused on Not now, not Accept', async () => {
    const test = await ready();
    test.identity.terms.mockReturnValue(
      of({ kind: 'needs-consent', policies: [] } as const),
    );

    fireEvent.click(toggle());
    await settle(test);

    expect(vi.mocked(test.surfaces.open).mock.calls[0][1]?.autoFocus).toBe(
      '[data-autofocus]',
    );
  });
});
