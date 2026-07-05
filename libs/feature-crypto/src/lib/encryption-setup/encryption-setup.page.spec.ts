import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import { CryptoService } from '@trinity/data-access-crypto';
import { TrnAlertService } from '@trinity/helm/overlay';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { EncryptionSetupPage } from './encryption-setup.page';

const KEY = 'THE-RECOVERY-KEY';

async function setup(): Promise<{
  fixture: Awaited<ReturnType<typeof render<EncryptionSetupPage>>>['fixture'];
  crypto: CryptoService;
  router: Router;
}> {
  const { fixture } = await render(EncryptionSetupPage, {
    providers: [
      MockProvider(CryptoService),
      MockProvider(Router),
      MockProvider(TrnAlertService),
    ],
  });
  const crypto = TestBed.inject(CryptoService);
  const router = TestBed.inject(Router);
  return { fixture, crypto, router };
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

    fixture.componentInstance.confirmedSaved.set(true);
    fixture.detectChanges();
    expect(continueButton()).toBeEnabled();

    fixture.componentInstance.finish();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/rooms', {
      replaceUrl: true,
    });
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
