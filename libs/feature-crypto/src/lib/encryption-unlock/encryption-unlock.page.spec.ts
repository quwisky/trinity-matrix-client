import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { ModalController } from '@ionic/angular/standalone';
import { CryptoService } from '@trinity/core';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { EncryptionUnlockPage } from './encryption-unlock.page';

function configure(
  recoverWithKey: ReturnType<typeof vi.fn>,
  returnTo: string | null = null,
) {
  const navigateByUrl = vi.fn();
  const dismiss = vi.fn().mockResolvedValue(true);
  const getTop = vi.fn().mockResolvedValue({ dismiss });
  TestBed.configureTestingModule({
    imports: [EncryptionUnlockPage],
    providers: [
      { provide: CryptoService, useValue: { recoverWithKey } },
      { provide: Router, useValue: { navigateByUrl } },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            queryParamMap: {
              get: (key: string) => (key === 'returnTo' ? returnTo : null),
            },
          },
        },
      },
      { provide: ModalController, useValue: { getTop } },
    ],
  });
  return { navigateByUrl, getTop, dismiss };
}

describe('EncryptionUnlockPage', () => {
  it('recovers with the trimmed key and navigates to rooms', () => {
    const recoverWithKey = vi.fn().mockReturnValue(of(undefined));
    const { navigateByUrl } = configure(recoverWithKey);
    const fixture = TestBed.createComponent(EncryptionUnlockPage);

    fixture.componentInstance.recoveryKey.set('  my-key  ');
    fixture.componentInstance.unlock();

    expect(recoverWithKey).toHaveBeenCalledWith('my-key');
    expect(navigateByUrl).toHaveBeenCalledWith('/rooms', { replaceUrl: true });
    expect(fixture.componentInstance.recoveryKey()).toBe(''); // cleared from memory
  });

  it('returns to the launch route (returnTo) on success when routed', () => {
    const recoverWithKey = vi.fn().mockReturnValue(of(undefined));
    const { navigateByUrl } = configure(recoverWithKey, '/settings');
    const fixture = TestBed.createComponent(EncryptionUnlockPage);

    fixture.componentInstance.recoveryKey.set('my-key');
    fixture.componentInstance.unlock();

    expect(navigateByUrl).toHaveBeenCalledWith('/settings', {
      replaceUrl: true,
    });
  });

  it('does nothing for a blank key', () => {
    const recoverWithKey = vi.fn();
    configure(recoverWithKey);
    const fixture = TestBed.createComponent(EncryptionUnlockPage);

    fixture.componentInstance.recoveryKey.set('   ');
    fixture.componentInstance.unlock();

    expect(recoverWithKey).not.toHaveBeenCalled();
  });

  it('surfaces an incorrect-key error and stays on the page', () => {
    const recoverWithKey = vi
      .fn()
      .mockReturnValue(
        throwError(() => new Error('That recovery key is incorrect.')),
      );
    const { navigateByUrl } = configure(recoverWithKey);
    const fixture = TestBed.createComponent(EncryptionUnlockPage);

    fixture.componentInstance.recoveryKey.set('bad-key');
    fixture.componentInstance.unlock();
    fixture.detectChanges();

    expect(fixture.componentInstance.error()).toBe(
      'That recovery key is incorrect.',
    );
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('dismisses its own modal (and emits close) on success when modal', async () => {
    const recoverWithKey = vi.fn().mockReturnValue(of(undefined));
    const { navigateByUrl, getTop, dismiss } = configure(recoverWithKey);
    const fixture = TestBed.createComponent(EncryptionUnlockPage);
    fixture.componentRef.setInput('asModal', true);
    let closed = false;
    fixture.componentInstance.closed.subscribe(() => (closed = true));

    fixture.componentInstance.recoveryKey.set('my-key');
    fixture.componentInstance.unlock();

    expect(closed).toBe(true);
    expect(navigateByUrl).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(getTop).toHaveBeenCalled());
    await vi.waitFor(() => expect(dismiss).toHaveBeenCalledOnce());
  });

  it('renders a Close control only in modal mode', () => {
    configure(vi.fn());
    const fixture = TestBed.createComponent(EncryptionUnlockPage);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-buttons')).toBeNull();

    fixture.componentRef.setInput('asModal', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-buttons')).not.toBeNull();
  });
});
