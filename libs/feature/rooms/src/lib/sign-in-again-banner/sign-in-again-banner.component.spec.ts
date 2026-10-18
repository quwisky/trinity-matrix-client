import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { WORKSPACE_SYSTEM_STATUS } from '@trinity/application/workspace';
import { TrnAlertService } from '@trinity/components/overlay';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { of } from 'rxjs';
import { fireEvent, render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignInAgainBannerComponent } from './sign-in-again-banner.component';

const slot = signal<'status' | 'encryption' | 'sign-in-again' | null>(
  'sign-in-again',
);
const dismissSignInAgain = vi.fn();
const navigate = vi.fn(() => Promise.resolve(true));
const confirm$ = vi.fn(() => of(true));

function renderBanner() {
  return render(SignInAgainBannerComponent, {
    providers: [
      MockProvider(MatrixClientService, {
        activeUserId: signal('@me:hs').asReadonly(),
      }),
      MockProvider(Router, { navigate }),
      MockProvider(TrnAlertService, { confirm$ }),
      {
        provide: WORKSPACE_SYSTEM_STATUS,
        useValue: {
          hasProblems: signal(false),
          show: vi.fn(),
          bannerSlot: slot,
          bannerSlotReserved: signal(false),
          bannerPrompt: signal(null),
          dismissSignInAgain,
        },
      },
    ],
  });
}

beforeEach(() => {
  slot.set('sign-in-again');
  dismissSignInAgain.mockClear();
  navigate.mockClear();
  confirm$.mockReset().mockReturnValue(of(true));
});

describe('SignInAgainBannerComponent', () => {
  it('shows only while it holds the global banner slot', async () => {
    const { fixture, container } = await renderBanner();
    expect(container.querySelector('trn-banner')).not.toBeNull();
    expect(
      container.querySelector('.sr-only[role="status"]')?.textContent,
    ).toContain('Sign in again');

    slot.set('encryption');
    fixture.detectChanges();
    expect(container.querySelector('trn-banner')).toBeNull();
    expect(
      container.querySelector('.sr-only[role="status"]')?.textContent?.trim(),
    ).toBe('');
  });

  it('says what restoring history needs before anything happens, and stops on Cancel', async () => {
    confirm$.mockReturnValue(of(false));
    await renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));

    expect(confirm$).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: expect.stringContaining(
          'recovery key or another signed-in device',
        ),
        confirmText: 'Continue',
      }),
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(dismissSignInAgain).not.toHaveBeenCalled();
  });

  it('signs the active account in again as a new device once confirmed', async () => {
    await renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(confirm$).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(['/login'], {
      queryParams: { reauth: '@me:hs', device: 'new' },
    });
  });

  it('can be dismissed', async () => {
    await renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(dismissSignInAgain).toHaveBeenCalledOnce();
  });
});
