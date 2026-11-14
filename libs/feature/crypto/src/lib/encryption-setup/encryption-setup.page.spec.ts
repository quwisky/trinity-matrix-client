import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { render, screen } from '@trinity/testing';
import {
  TrustOperationError,
  TrustService,
  type TrustRecovery,
} from '@trinity/data-access/trust';
import { TrnAlertService } from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { Observable, Subject, firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { EncryptionSetupPage } from './encryption-setup.page';

const KEY = 'THE-RECOVERY-KEY';

interface SetupOptions {
  /** What the "are you sure you want to leave" guard resolves to. */
  confirmLeave?: boolean;
  /** The Account the opener named: `account` query param. */
  account?: string;
}

async function setup(options: SetupOptions = {}): Promise<{
  fixture: Awaited<ReturnType<typeof render<EncryptionSetupPage>>>['fixture'];
  crypto: TrustService;
  router: Router;
  confirm: Mock;
  activeAccountId: WritableSignal<string | null>;
}> {
  const confirm = vi.fn(() => of(options.confirmLeave ?? true));
  // Writable so a test can switch account under the open screen.
  const activeAccountId = signal<string | null>('@me:hs');
  const { fixture } = await render(EncryptionSetupPage, {
    providers: [
      MockProvider(TrustService, {
        activeAccountId: activeAccountId.asReadonly(),
      }),
      MockProvider(Router),
      MockProvider(ActivatedRoute, {
        snapshot: {
          queryParamMap: {
            get: (key: string) =>
              key === 'account' ? (options.account ?? null) : null,
          },
        },
      } as never),
      MockProvider(TrnAlertService, { confirm$: confirm }),
    ],
  });
  const crypto = TestBed.inject(TrustService);
  const router = TestBed.inject(Router);
  return { fixture, crypto, router, confirm, activeAccountId };
}

/** Get to step 2 — the key is on screen and has not been confirmed saved. */
function showKey(
  fixture: Awaited<ReturnType<typeof setup>>['fixture'],
  crypto: TrustService,
): void {
  vi.mocked(crypto.setUp).mockReturnValue(of(KEY));
  fixture.componentInstance.setUp();
  fixture.detectChanges();
}

/**
 * Get to step 1.5 — setup is running and cannot be aborted.
 *
 * `TrustService.setUp` is `defer(() => from(promise))`, so unsubscribing only detaches
 * the subscriber; the SDK work carries on. A never-settling Observable is the honest
 * model of that: nothing the page does can make it emit.
 */
function startSetUp(
  fixture: Awaited<ReturnType<typeof setup>>['fixture'],
  crypto: TrustService,
): void {
  vi.mocked(crypto.setUp).mockReturnValue(
    new Observable<string>(() => undefined),
  );
  fixture.componentInstance.setUp();
  fixture.detectChanges();
}

function continueButton(): HTMLElement {
  return screen.getByRole('button', { name: /Continue to Trinity/i });
}

describe('EncryptionSetupPage', () => {
  it('names the account being set up in the password prompt', async () => {
    const { fixture, crypto } = await setup();
    const prompt = vi
      .mocked(TestBed.inject(TrnAlertService).prompt$)
      .mockReturnValue(of('pw'));
    vi.mocked(crypto.setUp).mockReturnValue(of(KEY));
    fixture.componentInstance.setUp();

    await vi.mocked(crypto.setUp).mock.calls[0][0]('@alice:example.org', true);

    expect(prompt.mock.calls[0][0].message).toBe(
      'Enter the password for @alice:example.org to set up encryption.',
    );
  });

  describe('when another account becomes active', () => {
    const REFUSED =
      'Nothing was set up: you switched account while this was open.';

    it('closes the password prompt when the page itself goes away, as a switch does on a phone', async () => {
      const { fixture, crypto } = await setup();
      const prompt = vi
        .mocked(TestBed.inject(TrnAlertService).prompt$)
        .mockReturnValue(new Subject<string | null>());
      vi.mocked(crypto.setUp).mockReturnValue(of(KEY));
      fixture.componentInstance.setUp();
      void vi.mocked(crypto.setUp).mock.calls[0][0]('@me:hs', true);
      let withdrawn = false;
      (prompt.mock.calls[0][0].closeWhen as Observable<unknown>).subscribe(
        () => (withdrawn = true),
      );

      fixture.destroy();

      expect(withdrawn).toBe(true);
    });

    it('closes the password prompt', async () => {
      const { fixture, crypto, activeAccountId } = await setup();
      const prompt = vi
        .mocked(TestBed.inject(TrnAlertService).prompt$)
        .mockReturnValue(new Subject<string | null>());
      vi.mocked(crypto.setUp).mockReturnValue(of(KEY));
      fixture.componentInstance.setUp();
      void vi.mocked(crypto.setUp).mock.calls[0][0]('@me:hs', true);
      let withdrawn = false;
      (prompt.mock.calls[0][0].closeWhen as Observable<unknown>).subscribe(
        () => (withdrawn = true),
      );
      fixture.detectChanges();
      expect(withdrawn).toBe(false);

      activeAccountId.set('@other:hs');
      fixture.detectChanges();

      expect(withdrawn).toBe(true);
    });

    it('sets nothing up when Set up is pressed after the switch', async () => {
      const { fixture, crypto, activeAccountId } = await setup();
      vi.mocked(crypto.setUp).mockReturnValue(of(KEY));

      activeAccountId.set('@other:hs');
      fixture.componentInstance.setUp();

      expect(crypto.setUp).not.toHaveBeenCalled();
      expect(fixture.componentInstance.recoveryKey()).toBeNull();
      expect(fixture.componentInstance.error()).toBe(REFUSED);
    });

    it('sets up again once the original account is back on screen', async () => {
      const { fixture, crypto, activeAccountId } = await setup();
      vi.mocked(crypto.setUp).mockReturnValue(of(KEY));
      activeAccountId.set('@other:hs');
      fixture.componentInstance.setUp();

      activeAccountId.set('@me:hs');
      fixture.componentInstance.setUp();

      expect(crypto.setUp).toHaveBeenCalledOnce();
      expect(fixture.componentInstance.error()).toBeNull();
      expect(fixture.componentInstance.recoveryKey()).toBe(KEY);
    });

    it('sets nothing up when built after the account that asked left the screen', async () => {
      const { fixture, crypto } = await setup({ account: '@asked:hs' });
      vi.mocked(crypto.setUp).mockReturnValue(of(KEY));

      fixture.componentInstance.setUp();

      expect(crypto.setUp).not.toHaveBeenCalled();
      expect(fixture.componentInstance.error()).toBe(REFUSED);
    });

    it('keeps naming the account whose recovery key is on screen', async () => {
      const { fixture, crypto, activeAccountId } = await setup();
      showKey(fixture, crypto);

      activeAccountId.set('@other:hs');
      fixture.detectChanges();

      expect(
        screen.getByTestId('recovery-key-account').textContent?.trim(),
      ).toBe('This recovery key is for @me:hs.');
    });
  });

  it('shows the recovery key after setUp succeeds', async () => {
    const { fixture, crypto } = await setup();
    vi.mocked(crypto.setUp).mockReturnValue(of(KEY));

    fixture.componentInstance.setUp();
    fixture.detectChanges();

    expect(crypto.setUp).toHaveBeenCalledOnce();
    expect(fixture.componentInstance.recoveryKey()).toBe(KEY);
    expect(fixture.nativeElement.textContent).toContain(KEY);
  });

  it('gates Continue until the user confirms they saved the key', async () => {
    const { fixture, crypto, router } = await setup();
    vi.mocked(crypto.setUp).mockReturnValue(of(KEY));

    fixture.componentInstance.setUp();
    fixture.detectChanges();

    expect(continueButton()).toBeDisabled();

    // Drive the rendered control, not the component's state: the gate a user meets is
    // the checkbox, and a test that sets the signal passes even if the two are unwired.
    const tickSaved = (): void => {
      const box = (
        fixture.nativeElement as HTMLElement
      ).querySelector<HTMLElement>(
        '[data-testid="recovery-key-saved"] input[role="checkbox"]',
      );
      box?.click();
      fixture.detectChanges();
    };
    tickSaved();
    expect(continueButton()).toBeEnabled();

    fixture.componentInstance.finish();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/rooms', {
      replaceUrl: true,
    });
  });

  describe('leaving while the key is on screen', () => {
    it('asks first — the browser back button would drop it silently', async () => {
      // First-run setup is the path every user is on, and this key is shown once and
      // never persisted: a back press must not be a silent way to lose it.
      const { fixture, crypto, confirm } = await setup({ confirmLeave: false });
      showKey(fixture, crypto);

      await expect(
        firstValueFrom(fixture.componentInstance.confirmLeave()),
      ).resolves.toBe(false);
      expect(confirm).toHaveBeenCalledOnce();
    });

    it('lets them leave when they insist', async () => {
      const { fixture, crypto } = await setup({ confirmLeave: true });
      showKey(fixture, crypto);

      await expect(
        firstValueFrom(fixture.componentInstance.confirmLeave()),
      ).resolves.toBe(true);
    });

    it('stays put if the question itself cannot be asked', async () => {
      // Failing towards staying loses nothing that cannot be retried; failing towards
      // leaving loses a key that is shown once.
      const { fixture, crypto, confirm } = await setup();
      showKey(fixture, crypto);
      confirm.mockReturnValue(
        throwError(() => new Error('no overlay container')),
      );

      await expect(
        firstValueFrom(fixture.componentInstance.confirmLeave()),
      ).resolves.toBe(false);
    });
  });

  describe('leaving while setup is still running', () => {
    it('asks first — leaving does not stop it', async () => {
      // Worse than the unsaved-key case: the SDK finishes, provisions 4S and a key
      // backup, and emits the only copy of the recovery key into a subscriber that is
      // gone. Settings then reports the account as secured, so nothing ever prompts
      // the user to fix it.
      const { fixture, crypto, confirm } = await setup({ confirmLeave: false });
      startSetUp(fixture, crypto);
      expect(fixture.componentInstance.busy()).toBe(true);

      await expect(
        firstValueFrom(fixture.componentInstance.confirmLeave()),
      ).resolves.toBe(false);
      expect(confirm).toHaveBeenCalledOnce();
      // Copy has to describe setup, not the unlock page's reset.
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ header: 'Encryption setup in progress' }),
      );
    });

    it('lets them leave when they insist', async () => {
      const { fixture, crypto, confirm } = await setup({ confirmLeave: true });
      startSetUp(fixture, crypto);

      await expect(
        firstValueFrom(fixture.componentInstance.confirmLeave()),
      ).resolves.toBe(true);
      expect(confirm).toHaveBeenCalledOnce();
    });

    it('still asks about the key first once one is on screen', async () => {
      // Both risks at once (emitted, not yet complete). The key is one press from
      // being saved, so it stays the more urgent question.
      const { fixture, crypto, confirm } = await setup();
      const pending = new Subject<string>();
      vi.mocked(crypto.setUp).mockReturnValue(pending);
      fixture.componentInstance.setUp();
      pending.next(KEY);
      fixture.detectChanges();
      expect(fixture.componentInstance.busy()).toBe(true);

      await firstValueFrom(fixture.componentInstance.confirmLeave());

      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ header: 'Leave without saving your key?' }),
      );
    });
  });

  it('leaves without a word before anything has started', async () => {
    const { fixture, confirm } = await setup();

    await expect(
      firstValueFrom(fixture.componentInstance.confirmLeave()),
    ).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('leaves without a word on the success path', async () => {
    // A guard that fired here would interrupt every new account on its way into the
    // app — worse than the bug it exists for. finish() drops the key, and a completed
    // setUp has already cleared busy.
    const { fixture, crypto, confirm } = await setup();
    showKey(fixture, crypto);

    fixture.componentInstance.finish();

    expect(fixture.componentInstance.busy()).toBe(false);
    expect(fixture.componentInstance.recoveryKey()).toBeNull();
    await expect(
      firstValueFrom(fixture.componentInstance.confirmLeave()),
    ).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('surfaces an error when setUp fails', async () => {
    const { fixture, crypto } = await setup();
    // An arbitrary failure message — the page surfaces whatever setUp emits.
    vi.mocked(crypto.setUp).mockReturnValue(
      throwError(() => new Error('Setup failed.')),
    );

    fixture.componentInstance.setUp();
    fixture.detectChanges();

    expect(fixture.componentInstance.error()).toBe('Setup failed.');
    expect(fixture.nativeElement.textContent).toContain('Setup failed.');
    expect(screen.queryByTestId('setup-security-settings')).toBeNull();
  });

  describe('when setup fails after minting the recovery key', () => {
    const partial = () =>
      new TrustOperationError(
        'setup',
        'partial-update',
        'retry',
        'Encryption setup didn’t finish. Save this recovery key now.',
        true,
        KEY,
      );

    it('shows the key to save alongside what went wrong', async () => {
      const { fixture, crypto } = await setup();
      vi.mocked(crypto.setUp).mockReturnValue(throwError(partial));

      fixture.componentInstance.setUp();
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain(KEY);
      expect(screen.getByRole('alert').textContent).toContain(
        'Save this recovery key now.',
      );
    });

    it('offers to finish with the same key', async () => {
      const { fixture, crypto } = await setup();
      vi.mocked(crypto.setUp).mockReturnValue(throwError(partial));
      fixture.componentInstance.setUp();
      fixture.detectChanges();

      vi.mocked(crypto.setUp).mockReturnValue(of(KEY));
      screen.getByRole('button', { name: 'Try again' }).click();
      fixture.detectChanges();

      expect(crypto.setUp).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      expect(fixture.nativeElement.textContent).toContain(KEY);
    });

    it('keeps Try again when the retry fails for a reason a retry answers', async () => {
      const { fixture, crypto } = await setup();
      vi.mocked(crypto.setUp).mockReturnValue(throwError(partial));
      fixture.componentInstance.setUp();
      fixture.detectChanges();

      vi.mocked(crypto.setUp).mockReturnValue(
        throwError(
          () =>
            new TrustOperationError(
              'setup',
              'server-failure',
              'retry',
              'The homeserver could not confirm this account’s encryption identity. Try again.',
            ),
        ),
      );
      screen.getByRole('button', { name: 'Try again' }).click();
      fixture.detectChanges();

      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
      expect(fixture.nativeElement.textContent).toContain(KEY);
    });

    it('drops the key when the account provably uses another one', async () => {
      const { fixture, crypto } = await setup();
      vi.mocked(crypto.setUp).mockReturnValue(throwError(partial));
      fixture.componentInstance.setUp();
      fixture.detectChanges();

      vi.mocked(crypto.setUp).mockReturnValue(
        throwError(
          () =>
            new TrustOperationError(
              'setup',
              'invalid-secret',
              'review-security-settings',
              'This account now has a different recovery key.',
            ),
        ),
      );
      screen.getByRole('button', { name: 'Try again' }).click();
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).not.toContain(KEY);
      expect(screen.getByRole('alert').textContent).toContain(
        'different recovery key',
      );
      expect(screen.getByTestId('setup-security-settings')).toBeTruthy();
    });

    it('withdraws Try again, but keeps the key, when the retry is refused', async () => {
      const { fixture, crypto } = await setup();
      vi.mocked(crypto.setUp).mockReturnValue(throwError(partial));
      fixture.componentInstance.setUp();
      fixture.detectChanges();

      vi.mocked(crypto.setUp).mockReturnValue(
        throwError(
          () =>
            new TrustOperationError(
              'setup',
              'stale-state',
              'review-security-settings',
              'This account already has a recovery key.',
            ),
        ),
      );
      screen.getByRole('button', { name: 'Try again' }).click();
      fixture.detectChanges();

      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      expect(screen.getByTestId('setup-security-settings')).toBeTruthy();
      expect(fixture.nativeElement.textContent).toContain(KEY);
    });
  });

  describe('when setup is refused because the identity lives elsewhere', () => {
    const refusal = (recovery: TrustRecovery) =>
      new TrustOperationError(
        'setup',
        'stale-state',
        recovery,
        'This account already has encryption set up on another device.',
      );

    it.each(['verify-another-device', 'review-security-settings'] as const)(
      'offers the way to Security settings (%s)',
      async (recovery) => {
        // The message tells them to verify or reset; both live in Security settings.
        const { fixture, crypto, router } = await setup();
        vi.mocked(crypto.setUp).mockReturnValue(
          throwError(() => refusal(recovery)),
        );

        fixture.componentInstance.setUp();
        fixture.detectChanges();
        screen.getByRole('button', { name: 'Security settings' }).click();

        expect(router.navigateByUrl).toHaveBeenCalledWith('/settings/security');
      },
    );

    it('does not offer it for a failure that a retry answers', async () => {
      const { fixture, crypto } = await setup();
      vi.mocked(crypto.setUp).mockReturnValue(
        throwError(
          () =>
            new TrustOperationError(
              'setup',
              'server-failure',
              'retry',
              'The homeserver did not answer.',
            ),
        ),
      );

      fixture.componentInstance.setUp();
      fixture.detectChanges();

      expect(screen.queryByTestId('setup-security-settings')).toBeNull();
    });

    it('drops the offer when the next attempt starts', async () => {
      const { fixture, crypto } = await setup();
      vi.mocked(crypto.setUp).mockReturnValue(
        throwError(() => refusal('verify-another-device')),
      );
      fixture.componentInstance.setUp();
      fixture.detectChanges();

      startSetUp(fixture, crypto);

      expect(screen.queryByTestId('setup-security-settings')).toBeNull();
    });
  });
});
