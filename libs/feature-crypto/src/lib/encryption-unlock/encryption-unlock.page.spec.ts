import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { DialogRef } from '@angular/cdk/dialog';
import { render, screen } from '@trinity/testing';
import { CryptoService } from '@trinity/data-access-crypto';
import { AuthService } from '@trinity/data-access-auth';
import { TrnAlertService } from '@trinity/helm/overlay';
import { UiaUnsupportedError } from '@trinity/util-matrix';
import { Browser } from '@capacitor/browser';
import { MockProvider } from 'ng-mocks';
import { Observable, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EncryptionUnlockPage } from './encryption-unlock.page';

vi.mock('@capacitor/browser', () => ({ Browser: { open: vi.fn() } }));

interface RenderOptions {
  /** Value `CryptoService.recoverWithKey` returns when invoked. */
  recover?: Observable<void>;
  /** `returnTo` query param on the routed page. */
  returnTo?: string | null;
  asModal?: boolean;
  /** What `CryptoService.resetRecovery` returns. */
  reset?: Observable<string>;
  /** What the user types into the type-to-confirm prompt (null = cancelled). */
  typed?: string | null;
  /** What `AuthService.getAccountManagement` resolves to. */
  management?: { url: string; actionsSupported: string[] } | null;
}

/** Renders the page with mocked DI and returns the fixture + mocked deps. */
async function renderPage(options: RenderOptions = {}) {
  const {
    recover,
    returnTo = null,
    asModal,
    reset,
    typed,
    management = null,
  } = options;
  // The type-to-confirm gate and the password prompt both go through prompt(); the
  // first call is the gate, any later one is the password.
  const prompt = vi.fn();
  prompt.mockResolvedValueOnce(typed ?? null).mockResolvedValue('pw');
  const result = await render(EncryptionUnlockPage, {
    inputs: asModal === undefined ? {} : { asModal },
    providers: [
      MockProvider(CryptoService),
      MockProvider(Router),
      MockProvider(ActivatedRoute, {
        snapshot: {
          queryParamMap: {
            get: (key: string) => (key === 'returnTo' ? returnTo : null),
          },
        },
      } as never),
      MockProvider(DialogRef),
      MockProvider(TrnAlertService, { prompt }),
      MockProvider(AuthService, {
        getAccountManagement: () => of(management),
      }),
    ],
  });

  const crypto = TestBed.inject(CryptoService);
  const router = TestBed.inject(Router);
  const dialogRef = TestBed.inject(DialogRef);
  if (recover) {
    vi.mocked(crypto.recoverWithKey).mockReturnValue(recover);
  }
  vi.mocked(crypto.resetRecovery).mockReturnValue(reset ?? of('EsTNew'));

  return { ...result, crypto, router, dialogRef, prompt };
}

/** Let the reset's async provider lookup settle (firstValueFrom + its own awaits). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Queries for the modal-only Close control. */
function closeButton(): HTMLElement | null {
  return screen.queryByRole('button', { name: 'Close' });
}

describe('EncryptionUnlockPage', () => {
  // The Browser module mock is shared by the whole file; without this a later test
  // inherits an earlier one's call and "was not opened" assertions pass or fail by order.
  beforeEach(() => vi.mocked(Browser.open).mockClear());

  it('recovers with the trimmed key and navigates to rooms', async () => {
    const { fixture, crypto, router } = await renderPage({
      recover: of(undefined),
    });

    fixture.componentInstance.unlockForm.recoveryKey().value.set('  my-key  ');
    fixture.componentInstance.unlock();

    expect(crypto.recoverWithKey).toHaveBeenCalledWith('my-key');
    expect(router.navigateByUrl).toHaveBeenCalledWith('/rooms', {
      replaceUrl: true,
    });
    expect(fixture.componentInstance.unlockForm.recoveryKey().value()).toBe(''); // cleared from memory
  });

  it('returns to the launch route (returnTo) on success when routed', async () => {
    const { fixture, router } = await renderPage({
      recover: of(undefined),
      returnTo: '/settings',
    });

    fixture.componentInstance.unlockForm.recoveryKey().value.set('my-key');
    fixture.componentInstance.unlock();

    expect(router.navigateByUrl).toHaveBeenCalledWith('/settings', {
      replaceUrl: true,
    });
  });

  it('does nothing for a blank key', async () => {
    const { fixture, crypto } = await renderPage();

    fixture.componentInstance.unlockForm.recoveryKey().value.set('   ');
    fixture.componentInstance.unlock();

    expect(crypto.recoverWithKey).not.toHaveBeenCalled();
  });

  it('surfaces an incorrect-key error and stays on the page', async () => {
    const { fixture, router } = await renderPage({
      recover: throwError(() => new Error('That recovery key is incorrect.')),
    });

    fixture.componentInstance.unlockForm.recoveryKey().value.set('bad-key');
    fixture.componentInstance.unlock();
    fixture.detectChanges();

    expect(fixture.componentInstance.error()).toBe(
      'That recovery key is incorrect.',
    );
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('dismisses its own modal (and emits close) on success when modal', async () => {
    const { fixture, router, dialogRef } = await renderPage({
      recover: of(undefined),
      asModal: true,
    });
    let closed = false;
    fixture.componentInstance.closed.subscribe(() => (closed = true));

    fixture.componentInstance.unlockForm.recoveryKey().value.set('my-key');
    fixture.componentInstance.unlock();

    expect(closed).toBe(true);
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    expect(dialogRef.close).toHaveBeenCalled();
  });

  it('renders a Close control only in modal mode', async () => {
    const { fixture } = await renderPage();
    expect(closeButton()).toBeNull();

    fixture.componentRef.setInput('asModal', true);
    fixture.detectChanges();
    expect(closeButton()).not.toBeNull();
  });

  describe('losing the recovery key', () => {
    it('does not reset unless the confirmation word is typed', async () => {
      // The only thing between a user and an irreversible, account-wide deletion.
      const { fixture, crypto } = await renderPage({ typed: 'reset please' });

      await fixture.componentInstance.resetRecovery();

      expect(crypto.resetRecovery).not.toHaveBeenCalled();
    });

    it('does not reset when the prompt is cancelled', async () => {
      const { fixture, crypto } = await renderPage({ typed: null });

      await fixture.componentInstance.resetRecovery();

      expect(crypto.resetRecovery).not.toHaveBeenCalled();
    });

    it('accepts the word regardless of case or surrounding space', async () => {
      const { fixture, crypto } = await renderPage({ typed: '  reset  ' });

      await fixture.componentInstance.resetRecovery();

      expect(crypto.resetRecovery).toHaveBeenCalledOnce();
    });

    it('warns about the cost before doing it', async () => {
      // The three consequences are the deliverable as much as the code is: a user
      // cannot discover any of them afterwards.
      const { fixture, prompt } = await renderPage({ typed: 'RESET' });

      await fixture.componentInstance.resetRecovery();

      const message = prompt.mock.calls[0][0].message as string;
      expect(message).toContain('backup on the server is deleted');
      expect(message).toContain('lose their verified status');
      expect(message).toContain('new recovery key');
      expect(prompt.mock.calls[0][0].destructive).toBe(true);
    });

    it('shows the new key once, and only releases Done once it is saved', async () => {
      const { fixture } = await renderPage({
        typed: 'RESET',
        reset: of('EsTBrandNew'),
      });

      await fixture.componentInstance.resetRecovery();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      expect(
        el.querySelector('[data-testid="recovery-key"]')?.textContent,
      ).toContain('EsTBrandNew');
      const done = el.querySelector<HTMLButtonElement>(
        '[data-testid="reset-done"]',
      );
      expect(done?.disabled).toBe(true);

      fixture.componentInstance.confirmedSaved.set(true);
      fixture.detectChanges();
      expect(
        el.querySelector<HTMLButtonElement>('[data-testid="reset-done"]')
          ?.disabled,
      ).toBe(false);
    });

    it('sends an OIDC account to its provider, deep-linked to the reset', async () => {
      // An OIDC-native account cannot answer a password challenge in-app.
      const { fixture } = await renderPage({
        typed: 'RESET',
        reset: throwError(() => new UiaUnsupportedError()),
        management: {
          url: 'https://op.example/account',
          actionsSupported: ['org.matrix.cross_signing_reset'],
        },
      });

      await fixture.componentInstance.resetRecovery();
      await flush();

      expect(Browser.open).toHaveBeenCalledWith({
        url: 'https://op.example/account?action=org.matrix.cross_signing_reset',
      });
    });

    it('explains rather than deep-linking when the provider does not offer it', async () => {
      // Sending someone to a page that cannot do the thing they came for is worse
      // than telling them their provider has to.
      const { fixture } = await renderPage({
        typed: 'RESET',
        reset: throwError(() => new UiaUnsupportedError()),
        management: { url: 'https://op.example/account', actionsSupported: [] },
      });

      await fixture.componentInstance.resetRecovery();
      await flush();
      fixture.detectChanges();

      expect(fixture.componentInstance.error()).toContain(
        'identity provider has to reset encryption',
      );
      expect(Browser.open).not.toHaveBeenCalled();
    });

    it('leaves an ordinary failure’s message alone', async () => {
      // Only the no-password-stage case means "go to your provider". A wrong password
      // or a dropped connection must keep the message it already produced.
      const { fixture } = await renderPage({
        typed: 'RESET',
        reset: throwError(() => new Error('server exploded')),
      });

      await fixture.componentInstance.resetRecovery();
      await flush();

      expect(Browser.open).not.toHaveBeenCalled();
      expect(fixture.componentInstance.error()).toContain('server exploded');
    });
  });
});
