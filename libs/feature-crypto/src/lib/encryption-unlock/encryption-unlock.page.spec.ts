import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { DialogRef } from '@angular/cdk/dialog';
import { render, screen } from '@trinity/testing';
import { CryptoService } from '@trinity/data-access-crypto';
import { MockProvider } from 'ng-mocks';
import { Observable, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { EncryptionUnlockPage } from './encryption-unlock.page';

interface RenderOptions {
  /** Value `CryptoService.recoverWithKey` returns when invoked. */
  recover?: Observable<void>;
  /** `returnTo` query param on the routed page. */
  returnTo?: string | null;
  asModal?: boolean;
}

/** Renders the page with mocked DI and returns the fixture + mocked deps. */
async function renderPage(options: RenderOptions = {}) {
  const { recover, returnTo = null, asModal } = options;
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
    ],
  });

  const crypto = TestBed.inject(CryptoService);
  const router = TestBed.inject(Router);
  const dialogRef = TestBed.inject(DialogRef);
  if (recover) {
    vi.mocked(crypto.recoverWithKey).mockReturnValue(recover);
  }

  return { ...result, crypto, router, dialogRef };
}

/** Queries for the modal-only Close control. */
function closeButton(): HTMLElement | null {
  return screen.queryByRole('button', { name: 'Close' });
}

describe('EncryptionUnlockPage', () => {
  it('recovers with the trimmed key and navigates to rooms', async () => {
    const { fixture, crypto, router } = await renderPage({
      recover: of(undefined),
    });

    fixture.componentInstance.recoveryKey.set('  my-key  ');
    fixture.componentInstance.unlock();

    expect(crypto.recoverWithKey).toHaveBeenCalledWith('my-key');
    expect(router.navigateByUrl).toHaveBeenCalledWith('/rooms', {
      replaceUrl: true,
    });
    expect(fixture.componentInstance.recoveryKey()).toBe(''); // cleared from memory
  });

  it('returns to the launch route (returnTo) on success when routed', async () => {
    const { fixture, router } = await renderPage({
      recover: of(undefined),
      returnTo: '/settings',
    });

    fixture.componentInstance.recoveryKey.set('my-key');
    fixture.componentInstance.unlock();

    expect(router.navigateByUrl).toHaveBeenCalledWith('/settings', {
      replaceUrl: true,
    });
  });

  it('does nothing for a blank key', async () => {
    const { fixture, crypto } = await renderPage();

    fixture.componentInstance.recoveryKey.set('   ');
    fixture.componentInstance.unlock();

    expect(crypto.recoverWithKey).not.toHaveBeenCalled();
  });

  it('surfaces an incorrect-key error and stays on the page', async () => {
    const { fixture, router } = await renderPage({
      recover: throwError(() => new Error('That recovery key is incorrect.')),
    });

    fixture.componentInstance.recoveryKey.set('bad-key');
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

    fixture.componentInstance.recoveryKey.set('my-key');
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
});
