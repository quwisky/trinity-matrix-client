import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceApplicationSurfaceService,
  WorkspaceNavigationService,
} from '@trinity/application/workspace';
import { TrnAlertService } from '@trinity/components/overlay';
import { ROOM_KEYS_AT_RISK } from '@trinity/data-access/accounts';
import { NewDeviceSignInPresenter } from './new-device-sign-in.presenter';

const REPLACES =
  'Signing in again starts a new session for @me:hs and deletes its old session’s keys from this device.';

describe('NewDeviceSignInPresenter', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        MockProvider(TrnAlertService),
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
});
