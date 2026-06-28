import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AlertController } from '@ionic/angular/standalone';
import { CryptoService } from '@trinity/core';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { EncryptionSetupPage } from './encryption-setup.page';

const KEY = 'THE-RECOVERY-KEY';

function configure(
  setUp: ReturnType<typeof vi.fn>,
  navigateByUrl = vi.fn(),
): { navigateByUrl: ReturnType<typeof vi.fn> } {
  TestBed.configureTestingModule({
    imports: [EncryptionSetupPage],
    providers: [
      { provide: CryptoService, useValue: { setUp } },
      { provide: Router, useValue: { navigateByUrl } },
      { provide: AlertController, useValue: { create: vi.fn() } },
    ],
  });
  return { navigateByUrl };
}

function continueButton(host: HTMLElement): HTMLElement {
  const buttons = [...host.querySelectorAll('ion-button')] as HTMLElement[];
  return buttons.find((b) => b.textContent?.includes('Continue'))!;
}

describe('EncryptionSetupPage', () => {
  it('shows the recovery key after setUp succeeds', () => {
    const setUp = vi.fn().mockReturnValue(of(KEY));
    configure(setUp);
    const fixture = TestBed.createComponent(EncryptionSetupPage);
    fixture.detectChanges();

    fixture.componentInstance.setUp();
    fixture.detectChanges();

    expect(setUp).toHaveBeenCalledOnce();
    expect(fixture.componentInstance.recoveryKey()).toBe(KEY);
    expect(fixture.nativeElement.textContent).toContain(KEY);
  });

  it('gates Continue until the user confirms they saved the key', () => {
    const setUp = vi.fn().mockReturnValue(of(KEY));
    const { navigateByUrl } = configure(setUp);
    const fixture = TestBed.createComponent(EncryptionSetupPage);
    fixture.componentInstance.setUp();
    fixture.detectChanges();

    expect(
      (continueButton(fixture.nativeElement) as { disabled?: boolean })
        .disabled,
    ).toBe(true);

    fixture.componentInstance.confirmedSaved.set(true);
    fixture.detectChanges();
    expect(
      (continueButton(fixture.nativeElement) as { disabled?: boolean })
        .disabled,
    ).toBe(false);

    fixture.componentInstance.finish();
    expect(navigateByUrl).toHaveBeenCalledWith('/rooms', { replaceUrl: true });
  });

  it('surfaces an error when setUp fails', () => {
    // An arbitrary failure message — the page surfaces whatever setUp emits.
    const setUp = vi
      .fn()
      .mockReturnValue(throwError(() => new Error('Setup failed.')));
    configure(setUp);
    const fixture = TestBed.createComponent(EncryptionSetupPage);
    fixture.componentInstance.setUp();
    fixture.detectChanges();

    expect(fixture.componentInstance.error()).toBe('Setup failed.');
    expect(fixture.nativeElement.textContent).toContain('Setup failed.');
  });
});
