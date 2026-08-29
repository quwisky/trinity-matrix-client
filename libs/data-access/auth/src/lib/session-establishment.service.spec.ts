import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountRuntimeService,
  type AuthenticatedAccountGrant,
} from '@trinity/data-access/accounts';
import { AvatarService, MediaService } from '@trinity/data-access/media';
import { PushService } from '@trinity/data-access/notifications';
import { SessionEstablishmentService } from './session-establishment.service';

const response = {
  user_id: '@new:hs',
  device_id: 'DEVICE',
  access_token: 'access-secret',
};

describe('SessionEstablishmentService', () => {
  let service: SessionEstablishmentService;
  let accounts: AccountRuntimeService;
  let avatars: AvatarService;
  let media: MediaService;
  let push: PushService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        SessionEstablishmentService,
        MockProvider(AccountRuntimeService, {
          establishAuthenticatedAccount: vi.fn(() =>
            of({
              kind: 'ready' as const,
              accountId: '@new:hs',
              placement: 'active' as const,
            }),
          ),
        }),
        MockProvider(AvatarService, { releaseAll: vi.fn() }),
        MockProvider(MediaService, { releaseAll: vi.fn() }),
        MockProvider(PushService, {
          unregister: vi.fn(() => of(undefined)),
          register: vi.fn(() => of(undefined)),
        }),
      ],
    });
    service = TestBed.inject(SessionEstablishmentService);
    accounts = TestBed.inject(AccountRuntimeService);
    avatars = TestBed.inject(AvatarService);
    media = TestBed.inject(MediaService);
    push = TestBed.inject(PushService);
  });

  it('hands registration to Account Runtime as an opaque new-account grant', async () => {
    await expect(
      firstValueFrom(service.establishNew('https://hs', response, 'replace')),
    ).resolves.toMatchObject({ kind: 'ready' });

    const [grant, intent] = vi.mocked(accounts.establishAuthenticatedAccount)
      .mock.calls[0] as [AuthenticatedAccountGrant, unknown];
    expect(intent).toEqual({
      placement: 'active',
      liveAccounts: 'replace',
      accountRecord: 'new',
    });
    expect(Object.keys(grant)).toEqual([]);
    expect(JSON.stringify(grant)).toBe('{}');
    expect(String(grant)).not.toContain(response.access_token);
    expect(avatars.releaseAll).toHaveBeenCalledOnce();
    expect(media.releaseAll).toHaveBeenCalledOnce();
    expect(push.unregister).toHaveBeenCalledOnce();
  });

  it('keeps live accounts and registers push after additive establishment', async () => {
    await firstValueFrom(service.establish('https://hs', response, 'add'));

    expect(accounts.establishAuthenticatedAccount).toHaveBeenCalledWith(
      expect.anything(),
      {
        placement: 'active',
        liveAccounts: 'keep',
        accountRecord: 'upsert',
      },
    );
    expect(avatars.releaseAll).not.toHaveBeenCalled();
    expect(media.releaseAll).not.toHaveBeenCalled();
    expect(push.unregister).not.toHaveBeenCalled();
    expect(push.register).toHaveBeenCalledOnce();
  });

  it('preserves an expected runtime outcome without running additive push setup', async () => {
    vi.mocked(accounts.establishAuthenticatedAccount).mockReturnValue(
      of({
        kind: 'failed',
        failure: 'account-already-stored',
        accountId: '@new:hs',
        placement: 'active',
      }),
    );

    await expect(
      firstValueFrom(service.establishNew('https://hs', response, 'add')),
    ).resolves.toMatchObject({
      failure: 'account-already-stored',
    });
    expect(push.register).not.toHaveBeenCalled();
  });

  it('preserves unexpected runtime defects on the observable error channel', async () => {
    const defect = new Error('adapter invariant failed');
    vi.mocked(accounts.establishAuthenticatedAccount).mockReturnValue(
      throwError(() => defect),
    );

    await expect(
      firstValueFrom(service.establish('https://hs', response, 'add')),
    ).rejects.toBe(defect);
  });

  it('does not issue a grant or mutate compatibility state before subscription', () => {
    service.establish('https://hs', response, 'replace');

    expect(accounts.establishAuthenticatedAccount).not.toHaveBeenCalled();
    expect(avatars.releaseAll).not.toHaveBeenCalled();
    expect(media.releaseAll).not.toHaveBeenCalled();
    expect(push.unregister).not.toHaveBeenCalled();
  });
});
