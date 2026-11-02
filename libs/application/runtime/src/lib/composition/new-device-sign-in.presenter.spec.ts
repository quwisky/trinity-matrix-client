import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceApplicationSurfaceService,
  WorkspaceNavigationService,
} from '@trinity/application/workspace';
import { TrnAlertService } from '@trinity/components/overlay';
import {
  ACCOUNT_LIFECYCLE_PORT,
  MENTION_HISTORY_LOSS,
  ROOM_KEYS_AT_RISK,
  ROOM_KEYS_MAY_BE_LOST,
} from '@trinity/data-access/accounts';
import {
  AppLockService,
  type AppLockStatus,
} from '@trinity/data-access/app-lock';
import { NewDeviceSignInPresenter } from './new-device-sign-in.presenter';

const REPLACES =
  'Signing in again starts a new session for @me:hs and deletes its old session’s keys from this device.';

describe('NewDeviceSignInPresenter', () => {
  let lockStatus: ReturnType<typeof signal<AppLockStatus>>;
  let hasMentionHistory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    lockStatus = signal<AppLockStatus>('off');
    hasMentionHistory = vi.fn(() => of(false));
    TestBed.configureTestingModule({
      providers: [
        { provide: ACCOUNT_LIFECYCLE_PORT, useValue: { hasMentionHistory } },
        MockProvider(TrnAlertService),
        MockProvider(AppLockService, { status: lockStatus.asReadonly() }),
        MockProvider(WorkspaceNavigationService, {
          navigate: vi.fn(() =>
            of({ kind: 'ready' as const, change: 'committed' as const }),
          ),
        }),
        MockProvider(WorkspaceApplicationSurfaceService, {
          open: vi.fn(() =>
            of({
              kind: 'presented' as const,
              surface: { kind: 'settings' as const, section: 'security' },
            }),
          ),
        }),
      ],
    });
  });

  const presenter = () => TestBed.inject(NewDeviceSignInPresenter);

  it('with every key backed up, the question is only about the mention history', async () => {
    const alert = TestBed.inject(TrnAlertService);
    vi.mocked(alert.confirm$).mockReturnValue(of(false));

    await expect(
      firstValueFrom(
        presenter().confirm({ userId: '@me:hs', roomKeysBackedUp: true }),
      ),
    ).resolves.toBe(false);

    // The caller only asks this variant once it has read the history.
    expect(hasMentionHistory).not.toHaveBeenCalled();
    expect(alert.choose$).not.toHaveBeenCalled();
    expect(alert.confirm$).toHaveBeenCalledExactlyOnceWith({
      header: "Delete this device's mention history?",
      message: `${REPLACES}\n\n${MENTION_HISTORY_LOSS}`,
      confirmText: 'Sign in anyway',
      variant: 'danger',
    });
  });

  it('adds the mention history sentence to either question when the account has any', async () => {
    hasMentionHistory.mockReturnValue(of(true));
    const alert = TestBed.inject(TrnAlertService);
    vi.mocked(alert.choose$).mockReturnValue(of('confirm'));
    vi.mocked(alert.confirm$).mockReturnValue(of(true));

    await firstValueFrom(
      presenter().confirm({ userId: '@me:hs', roomKeysBackedUp: false }),
    );
    await firstValueFrom(
      presenter().confirm({ userId: '@me:hs', roomKeysBackedUp: null }),
    );

    // An unread count answers true here, since this path does delete and asks anyway.
    expect(hasMentionHistory).toHaveBeenCalledWith('@me:hs', true);
    expect(alert.choose$).toHaveBeenCalledWith(
      expect.objectContaining({
        message: `${REPLACES}\n\n${ROOM_KEYS_AT_RISK}\n\n${MENTION_HISTORY_LOSS}`,
      }),
    );
    expect(alert.confirm$).toHaveBeenCalledWith(
      expect.objectContaining({
        message: `${REPLACES}\n\n${ROOM_KEYS_MAY_BE_LOST}\n\n${MENTION_HISTORY_LOSS}`,
      }),
    );
  });

  it.each([
    ['confirm', true],
    ['cancel', false],
  ] as const)(
    'offers the key export while the stored session is live (%s → %s)',
    async (choice, proceed) => {
      const alert = TestBed.inject(TrnAlertService);
      vi.mocked(alert.choose$).mockReturnValue(of(choice));

      const result = await firstValueFrom(
        presenter().confirm({ userId: '@me:hs', roomKeysBackedUp: false }),
      );

      expect(result).toBe(proceed);
      expect(alert.choose$).toHaveBeenCalledWith({
        header: 'Room keys are not backed up',
        message: `${REPLACES}\n\n${ROOM_KEYS_AT_RISK}`,
        alternativeText: 'Export keys',
        confirmText: 'Sign in anyway',
        variant: 'danger',
      });
    },
  );

  it('Export keys cancels the sign-in and opens the stored account’s key export', async () => {
    const alert = TestBed.inject(TrnAlertService);
    const workspace = TestBed.inject(WorkspaceNavigationService);
    const surfaces = TestBed.inject(WorkspaceApplicationSurfaceService);
    vi.mocked(alert.choose$).mockReturnValue(of('alternative'));

    const result = await firstValueFrom(
      presenter().confirm({ userId: '@me:hs', roomKeysBackedUp: false }),
    );

    expect(result).toBe(false);
    expect(workspace.navigate).toHaveBeenCalledWith({
      kind: 'account',
      accountId: '@me:hs',
    });
    expect(surfaces.open).toHaveBeenCalledWith({
      surface: { kind: 'settings', section: 'security' },
    });
  });

  it('warns without a backup status, and without an export, when the stored session is not live', async () => {
    const alert = TestBed.inject(TrnAlertService);
    vi.mocked(alert.confirm$).mockReturnValue(of(true));

    const result = await firstValueFrom(
      presenter().confirm({ userId: '@me:hs', roomKeysBackedUp: null }),
    );

    expect(result).toBe(true);
    expect(alert.choose$).not.toHaveBeenCalled();
    expect(alert.confirm$).toHaveBeenCalledWith({
      header: 'Room keys may not be backed up',
      message: `${REPLACES}\n\nYou’ll lose access to encrypted messages on this device unless key backup holds their keys.`,
      confirmText: 'Sign in anyway',
      variant: 'danger',
    });
  });

  it('asks only once App lock is unlocked, when a sign-in completes behind the lock', async () => {
    // A sign-in callback (OIDC, SSO) can complete while the app is locked (spec §2).
    lockStatus.set('locked');
    const alert = TestBed.inject(TrnAlertService);
    vi.mocked(alert.confirm$).mockReturnValue(of(true));
    let answer: boolean | null = null;
    presenter()
      .confirm({ userId: '@me:hs', roomKeysBackedUp: null })
      .subscribe((confirmed) => (answer = confirmed));
    TestBed.tick();
    expect(alert.confirm$).not.toHaveBeenCalled();

    lockStatus.set('unlocked');
    TestBed.tick();
    expect(alert.confirm$).toHaveBeenCalledOnce();
    expect(answer).toBe(true);
  });
});
