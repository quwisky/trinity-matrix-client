import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { WORKSPACE_SYSTEM_STATUS } from '@trinity/application/workspace';
import { TrnAlertService } from '@trinity/components/overlay';
import {
  ACCOUNT_LIFECYCLE_PORT,
  MENTION_HISTORY_LOSS,
} from '@trinity/data-access/accounts';
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

function renderBanner(hasMentionHistory = false) {
  return render(SignInAgainBannerComponent, {
    providers: [
      {
        provide: ACCOUNT_LIFECYCLE_PORT,
        useValue: { hasMentionHistory: () => of(hasMentionHistory) },
      },
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
  it.each([
    [true, true],
    [false, false],
  ])(
    'the question says the mention history goes only with history (%s)',
    async (hasHistory, says) => {
      const { container } = await renderBanner(hasHistory);

      fireEvent.click(
        [...container.querySelectorAll('button')].find((button) =>
          button.textContent?.includes('Sign in again'),
        ) as HTMLButtonElement,
      );

      const { message } = (
        confirm$.mock.calls as unknown as [{ message: string }][]
      )[0]![0];
      expect(message.includes(MENTION_HISTORY_LOSS)).toBe(says);
      expect(navigate).toHaveBeenCalledOnce();
    },
  );

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
