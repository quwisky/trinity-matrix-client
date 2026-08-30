import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { render, screen } from '@trinity/testing';
import { TrustService } from '@trinity/data-access/trust';
import { TrnAlertService } from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { Observable, Subject, of, throwError } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { EncryptionSetupPage } from './encryption-setup.page';

const KEY = 'THE-RECOVERY-KEY';

interface SetupOptions {
  /** What the "are you sure you want to leave" guard resolves to. */
  confirmLeave?: boolean;
}

async function setup(options: SetupOptions = {}): Promise<{
  fixture: Awaited<ReturnType<typeof render<EncryptionSetupPage>>>['fixture'];
  crypto: TrustService;
  router: Router;
  confirm: Mock;
}> {
  const confirm = vi.fn().mockResolvedValue(options.confirmLeave ?? true);
  const { fixture } = await render(EncryptionSetupPage, {
    providers: [
      MockProvider(TrustService),
      MockProvider(Router),
      MockProvider(TrnAlertService, { confirm }),
    ],
  });
  const crypto = TestBed.inject(TrustService);
  const router = TestBed.inject(Router);
  return { fixture, crypto, router, confirm };
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
        '[data-testid="recovery-key-saved"] button[role="checkbox"]',
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

      await expect(fixture.componentInstance.confirmLeave()).resolves.toBe(
        false,
      );
      expect(confirm).toHaveBeenCalledOnce();
    });

    it('lets them leave when they insist', async () => {
      const { fixture, crypto } = await setup({ confirmLeave: true });
      showKey(fixture, crypto);

      await expect(fixture.componentInstance.confirmLeave()).resolves.toBe(
        true,
      );
    });

    it('stays put if the question itself cannot be asked', async () => {
      // Failing towards staying loses nothing that cannot be retried; failing towards
      // leaving loses a key that is shown once.
      const { fixture, crypto, confirm } = await setup();
      showKey(fixture, crypto);
      confirm.mockRejectedValue(new Error('no overlay container'));

      await expect(fixture.componentInstance.confirmLeave()).resolves.toBe(
        false,
      );
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

      await expect(fixture.componentInstance.confirmLeave()).resolves.toBe(
        false,
      );
      expect(confirm).toHaveBeenCalledOnce();
      // Copy has to describe setup, not the unlock page's reset.
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ header: 'Encryption setup in progress' }),
      );
    });

    it('lets them leave when they insist', async () => {
      const { fixture, crypto, confirm } = await setup({ confirmLeave: true });
      startSetUp(fixture, crypto);

      await expect(fixture.componentInstance.confirmLeave()).resolves.toBe(
        true,
      );
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

      await fixture.componentInstance.confirmLeave();

      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ header: 'Leave without saving your key?' }),
      );
    });
  });

  it('leaves without a word before anything has started', async () => {
    const { fixture, confirm } = await setup();

    await expect(fixture.componentInstance.confirmLeave()).resolves.toBe(true);
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
    await expect(fixture.componentInstance.confirmLeave()).resolves.toBe(true);
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
  });
});
