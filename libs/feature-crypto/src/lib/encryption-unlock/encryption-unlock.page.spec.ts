import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { CryptoService } from '@trinity/core';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { EncryptionUnlockPage } from './encryption-unlock.page';

function configure(
  recoverWithKey: ReturnType<typeof vi.fn>,
  navigateByUrl = vi.fn(),
): { navigateByUrl: ReturnType<typeof vi.fn> } {
  TestBed.configureTestingModule({
    imports: [EncryptionUnlockPage],
    providers: [
      { provide: CryptoService, useValue: { recoverWithKey } },
      { provide: Router, useValue: { navigateByUrl } },
    ],
  });
  return { navigateByUrl };
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
});
