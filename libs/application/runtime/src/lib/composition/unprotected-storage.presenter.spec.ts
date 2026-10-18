import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, lastValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceApplicationSurfaceService } from '@trinity/application/workspace';
import { TrnAlertService } from '@trinity/components/overlay';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import {
  AppLockService,
  type AppLockStatus,
} from '@trinity/data-access/app-lock';
import {
  SecureStorageService,
  type UnprotectedStorageAcknowledgement,
} from '@trinity/platform-native';
import {
  UnprotectedStorageConsentPresenter,
  UnprotectedStorageNotice,
} from './unprotected-storage.presenter';

describe('unprotected storage', () => {
  let unprotected: boolean;
  let acknowledged: UnprotectedStorageAcknowledgement | null;

  beforeEach(() => {
    unprotected = true;
    acknowledged = null;
    TestBed.configureTestingModule({
      providers: [
        MockProvider(TrnAlertService, {
          confirm$: vi.fn(() => of(false)),
        }),
        MockProvider(AppLockService, {
          status: signal<AppLockStatus>('off').asReadonly(),
          whenUnlocked: () => of(void 0),
        }),
        MockProvider(AccountRuntimeService, {
          hasActiveAccount: signal(true).asReadonly(),
        }),
        MockProvider(SecureStorageService, {
          storesUnprotectedSecrets: vi.fn(async () => unprotected),
          unprotectedStorageAcknowledged: vi.fn(async () => acknowledged),
          acknowledgeUnprotectedStorage: vi.fn(async (value) => {
            acknowledged = value;
          }),
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

  const consent = () => TestBed.inject(UnprotectedStorageConsentPresenter);
  const notice = () => TestBed.inject(UnprotectedStorageNotice);
  const alert = () => TestBed.inject(TrnAlertService);

  it.each([true, false])(
    'asks before storing a sign-in unprotected, and passes the answer on (%s)',
    async (answer) => {
      vi.mocked(alert().confirm$).mockReturnValue(of(answer));

      await expect(firstValueFrom(consent().confirm())).resolves.toBe(answer);
      expect(alert().confirm$).toHaveBeenCalledWith(
        expect.objectContaining({
          header: 'Store this account without a keyring?',
          confirmText: 'Store unprotected',
        }),
      );
    },
  );

  it('tells an account stored unprotected before this version once, and opens Security settings', async () => {
    vi.mocked(alert().confirm$).mockReturnValue(of(true));

    await lastValueFrom(notice().runPendingNotice(), {
      defaultValue: undefined,
    });

    expect(acknowledged).toBe('notified');
    expect(alert().confirm$).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmText: 'Security settings',
        cancelText: 'Close',
      }),
    );
    expect(
      TestBed.inject(WorkspaceApplicationSurfaceService).open,
    ).toHaveBeenCalledWith({
      surface: { kind: 'settings', section: 'security' },
    });
  });

  it.each([
    ['no secret is stored unprotected', () => (unprotected = false)],
    ['the person agreed at sign-in', () => (acknowledged = 'consented')],
    ['the person was already told', () => (acknowledged = 'notified')],
  ])('shows no notice when %s', async (_case, arrange) => {
    arrange();

    await lastValueFrom(notice().runPendingNotice(), {
      defaultValue: undefined,
    });

    expect(alert().confirm$).not.toHaveBeenCalled();
  });
});
