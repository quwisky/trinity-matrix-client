import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { render, screen } from '@trinity/testing';
import { CryptoService } from '@trinity/data-access/crypto';
import { AuthService } from '@trinity/data-access/auth';
import { DialogRef, TrnAlertService } from '@trinity/helm/overlay';
import { UiaCancelledError, UiaUnsupportedError } from '@trinity/util/matrix';
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
  /** Arrive with the reset already offered (Settings' lost-key door). */
  offerReset?: boolean;
  /** What `CryptoService.resetRecovery` returns. */
  reset?: Observable<string>;
  /** What the user types into the type-to-confirm prompt (null = cancelled). */
  typed?: string | null;
  /** What `AuthService.getAccountManagement` resolves to. */
  management?: { url: string; actionsSupported: string[] } | null;
  /** Make the provider lookup reject, as a locked keychain would. */
  managementFails?: boolean;
  /** What the "are you sure you want to close" guard resolves to. */
  confirmClose?: boolean;
}

/** Renders the page with mocked DI and returns the fixture + mocked deps. */
async function renderPage(options: RenderOptions = {}) {
  const {
    recover,
    returnTo = null,
    asModal,
    offerReset,
    reset,
    typed,
    management = null,
    managementFails = false,
    confirmClose = true,
  } = options;
  // The type-to-confirm gate and the password prompt both go through prompt(); the
  // first call is the gate, any later one is the password.
  const prompt = vi.fn();
  prompt.mockResolvedValueOnce(typed ?? null).mockResolvedValue('pw');
  const confirm = vi.fn().mockResolvedValue(confirmClose);
  const result = await render(EncryptionUnlockPage, {
    inputs: {
      ...(asModal === undefined ? {} : { asModal }),
      ...(offerReset === undefined ? {} : { offerReset }),
    },
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
      MockProvider(TrnAlertService, { prompt, confirm }),
      MockProvider(AuthService, {
        getAccountManagement: () =>
          managementFails
            ? throwError(() => new Error('keychain locked'))
            : of(management),
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

  return { ...result, crypto, router, dialogRef, prompt, confirm };
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

      el.querySelector<HTMLElement>(
        '[data-testid="recovery-key-saved"] button[role="checkbox"]',
      )?.click();
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

  describe('when only the provider can do it', () => {
    it('renders a link, not just an attempt to open a popup', async () => {
      // Browser.open lands several awaits after the click, outside the gesture window,
      // so on web it is blocked — the message alone would be a dead end.
      const { fixture } = await renderPage({
        typed: 'RESET',
        reset: throwError(() => new UiaUnsupportedError()),
        management: {
          url: 'https://auth.example/account',
          actionsSupported: ['org.matrix.cross_signing_reset'],
        },
      });

      await fixture.componentInstance.resetRecovery();
      await flush();
      fixture.detectChanges();

      const link = (
        fixture.nativeElement as HTMLElement
      ).querySelector<HTMLAnchorElement>('[data-testid="provider-reset-link"]');
      expect(link?.href).toContain('action=org.matrix.cross_signing_reset');
    });

    it('drops the link once the next action clears the error it belongs to', async () => {
      // The link is the second half of a message. Left behind, it sits next to an
      // unrelated error (or next to none at all) telling the user two contradictory
      // things: "your provider has to do this" and "that recovery key is incorrect".
      const { fixture } = await renderPage({
        typed: 'RESET',
        reset: throwError(() => new UiaUnsupportedError()),
        management: {
          url: 'https://auth.example/account',
          actionsSupported: ['org.matrix.cross_signing_reset'],
        },
        recover: throwError(() => new Error('That recovery key is incorrect.')),
      });
      await fixture.componentInstance.resetRecovery();
      await flush();
      fixture.detectChanges();
      expect(fixture.componentInstance.providerResetUrl()).not.toBeNull();

      fixture.componentInstance.unlockForm.recoveryKey().value.set('EsTx');
      fixture.componentInstance.unlock();
      fixture.detectChanges();

      expect(fixture.componentInstance.providerResetUrl()).toBeNull();
      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="provider-reset-link"]',
        ),
      ).toBeNull();
      expect(fixture.componentInstance.error()).toContain('incorrect');
    });

    it('offers no link when the provider advertises no reset action', async () => {
      const { fixture } = await renderPage({
        typed: 'RESET',
        reset: throwError(() => new UiaUnsupportedError()),
        management: {
          url: 'https://auth.example/account',
          actionsSupported: [],
        },
      });

      await fixture.componentInstance.resetRecovery();
      await flush();
      fixture.detectChanges();

      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="provider-reset-link"]',
        ),
      ).toBeNull();
    });
  });

  describe('closing without losing something', () => {
    it('asks before discarding a key that is only shown once', async () => {
      const { fixture, confirm, dialogRef } = await renderPage({
        asModal: true,
        typed: 'RESET',
        reset: of('EsTBrandNew'),
        confirmClose: false,
      });
      await fixture.componentInstance.resetRecovery();
      fixture.detectChanges();

      await fixture.componentInstance.close();

      expect(confirm).toHaveBeenCalledOnce();
      expect(dialogRef.close).not.toHaveBeenCalled();
      expect(fixture.componentInstance.newRecoveryKey()).toBe('EsTBrandNew');
    });

    it('closes anyway when the user insists', async () => {
      const { fixture, dialogRef } = await renderPage({
        asModal: true,
        typed: 'RESET',
        reset: of('EsTBrandNew'),
        confirmClose: true,
      });
      await fixture.componentInstance.resetRecovery();
      fixture.detectChanges();

      await fixture.componentInstance.close();

      expect(dialogRef.close).toHaveBeenCalled();
    });

    it('asks while a reset is still running, since closing cannot stop it', async () => {
      // Unsubscribing does not abort the promise: the SDK finishes and emits the only
      // copy of the new key into a subscriber that is gone.
      const { fixture, confirm, dialogRef } = await renderPage({
        asModal: true,
        typed: 'RESET',
        reset: new Observable<string>(() => undefined), // never settles
        confirmClose: false,
      });
      void fixture.componentInstance.resetRecovery();
      await flush();
      expect(fixture.componentInstance.busy()).toBe(true);

      await fixture.componentInstance.close();

      expect(confirm).toHaveBeenCalledOnce();
      expect(dialogRef.close).not.toHaveBeenCalled();
    });

    it('leaves the Close control ENABLED throughout', async () => {
      // The desktop dialog opens with disableClose, so this is the only way out —
      // disabling it would trap the user behind a reset that never settles.
      const { fixture } = await renderPage({
        asModal: true,
        typed: 'RESET',
        reset: new Observable<string>(() => undefined),
      });
      void fixture.componentInstance.resetRecovery();
      await flush();
      fixture.detectChanges();

      expect(closeButton()).toBeEnabled();
    });

    it('stays put if the question itself cannot be asked', async () => {
      // Failing towards staying loses nothing that cannot be retried; failing towards
      // leaving loses a key that is shown once.
      const { fixture } = await renderPage({
        asModal: true,
        typed: 'RESET',
        reset: of('EsTBrandNew'),
      });
      await fixture.componentInstance.resetRecovery();
      vi.mocked(TestBed.inject(TrnAlertService).confirm).mockRejectedValue(
        new Error('no overlay container'),
      );

      await expect(fixture.componentInstance.confirmLeave()).resolves.toBe(
        false,
      );
    });

    it('closes without asking when there is nothing to lose', async () => {
      const { fixture, confirm, dialogRef } = await renderPage({
        asModal: true,
      });

      await fixture.componentInstance.close();

      expect(confirm).not.toHaveBeenCalled();
      expect(dialogRef.close).toHaveBeenCalled();
    });
  });

  describe('telling the two operations apart', () => {
    it('does not call an ordinary unlock a reset', async () => {
      // `busy` is shared with unlock(), so a guard keyed off it tells someone who is
      // simply entering their key that an encryption reset is in progress.
      const { fixture, confirm, dialogRef } = await renderPage({
        asModal: true,
        recover: new Observable<void>(() => undefined), // never settles
      });
      fixture.componentInstance.unlockForm().value.set({ recoveryKey: 'EsTx' });
      fixture.componentInstance.unlock();
      await flush();
      expect(fixture.componentInstance.busy()).toBe(true);

      await fixture.componentInstance.close();

      expect(confirm).not.toHaveBeenCalled();
      expect(dialogRef.close).toHaveBeenCalled();
    });

    it('says which operation the spinner is for', async () => {
      const { fixture } = await renderPage({
        typed: 'RESET',
        reset: new Observable<string>(() => undefined),
      });
      expect(fixture.componentInstance.progressMessage()).toContain(
        'Unlocking',
      );

      void fixture.componentInstance.resetRecovery();
      await flush();

      expect(fixture.componentInstance.progressMessage()).toContain(
        'Resetting',
      );
    });

    it('titles the page for what it is showing', async () => {
      const { fixture } = await renderPage({
        typed: 'RESET',
        reset: of('EsTBrandNew'),
      });
      expect(fixture.componentInstance.title()).toBe('Verify this device');

      await fixture.componentInstance.resetRecovery();

      expect(fixture.componentInstance.title()).toBe('Encryption reset');
    });
  });

  describe('arriving from a door that promised the reset', () => {
    it('opens the confirmation gate on arrival', async () => {
      const { prompt } = await renderPage({ offerReset: true, typed: null });

      await flush();

      expect(prompt).toHaveBeenCalledOnce();
    });

    it('stays put when nobody asked', async () => {
      const { prompt } = await renderPage({ typed: null });

      await flush();

      expect(prompt).not.toHaveBeenCalled();
    });
  });

  describe('when the reset does not run', () => {
    it('says so when the confirmation word is wrong', async () => {
      // A bare return here is indistinguishable from a broken button.
      const { fixture, crypto } = await renderPage({ typed: 'yes please' });

      await fixture.componentInstance.resetRecovery();

      expect(crypto.resetRecovery).not.toHaveBeenCalled();
      expect(fixture.componentInstance.error()).toContain('RESET');
    });

    it('stays quiet when the user simply cancels', async () => {
      const { fixture, crypto } = await renderPage({ typed: null });

      await fixture.componentInstance.resetRecovery();

      expect(crypto.resetRecovery).not.toHaveBeenCalled();
      expect(fixture.componentInstance.error()).toBeNull();
    });

    it('says nothing when the password prompt is cancelled', async () => {
      // A cancel is now a routine answer given BEFORE anything is destroyed, not a
      // failure worth reporting back at the user.
      const { fixture } = await renderPage({
        typed: 'RESET',
        reset: throwError(() => new UiaCancelledError()),
      });

      await fixture.componentInstance.resetRecovery();
      await flush();

      expect(fixture.componentInstance.error()).toBeNull();
      expect(fixture.componentInstance.busy()).toBe(false);
    });

    it('still explains itself when the provider lookup throws', async () => {
      // The whole job of this branch is to say something; a swallowed rejection would
      // leave the user staring at a screen that appears to have done nothing.
      const { fixture } = await renderPage({
        typed: 'RESET',
        reset: throwError(() => new UiaUnsupportedError()),
        managementFails: true,
      });

      await fixture.componentInstance.resetRecovery();
      await flush();

      expect(fixture.componentInstance.error()).toContain('identity provider');
      expect(fixture.componentInstance.busy()).toBe(false);
    });
  });
});
