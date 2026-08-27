import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { AvatarService, MediaService } from '@trinity/data-access/media';
import { PushService } from '@trinity/data-access/notifications';
import { SessionStorageService } from '@trinity/platform-native';
import { SessionEstablishmentService } from './session-establishment.service';

const response = {
  user_id: '@new:hs',
  device_id: 'DEVICE',
  access_token: 'access',
};

describe('SessionEstablishmentService registration isolation', () => {
  let service: SessionEstablishmentService;
  let storage: SessionStorageService;
  let matrix: MatrixClientService;
  let avatars: AvatarService;
  let media: MediaService;
  let push: PushService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        SessionEstablishmentService,
        MockProvider(SessionStorageService, {
          saveNew: vi.fn(() =>
            of({
              baseUrl: 'https://hs',
              userId: '@new:hs',
              deviceId: 'DEVICE',
              accessToken: 'access',
              cryptoPrefix: 'new-prefix',
            }),
          ),
        }),
        MockProvider(MatrixClientService, {
          init: vi.fn(() => of(undefined)),
          add: vi.fn(() => of(undefined)),
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
    storage = TestBed.inject(SessionStorageService);
    matrix = TestBed.inject(MatrixClientService);
    avatars = TestBed.inject(AvatarService);
    media = TestBed.inject(MediaService);
    push = TestBed.inject(PushService);
  });

  it('does not mutate caches, push, or clients when the atomic new-account save rejects', async () => {
    vi.mocked(storage.saveNew).mockReturnValue(
      throwError(() => new Error('account already stored')),
    );

    await expect(
      firstValueFrom(service.establishNew('https://hs', response, 'replace')),
    ).rejects.toThrow(/already stored/i);

    expect(avatars.releaseAll).not.toHaveBeenCalled();
    expect(media.releaseAll).not.toHaveBeenCalled();
    expect(push.unregister).not.toHaveBeenCalled();
    expect(matrix.init).not.toHaveBeenCalled();
  });

  it('retries startup for the exact persisted response without saving it again', async () => {
    vi.mocked(matrix.init)
      .mockReturnValueOnce(throwError(() => new Error('startup failed')))
      .mockReturnValueOnce(of(undefined));

    await expect(
      firstValueFrom(service.establishNew('https://hs', response, 'replace')),
    ).rejects.toThrow(/startup failed/i);
    await expect(
      firstValueFrom(service.establishNew('https://hs', response, 'replace')),
    ).resolves.toBeUndefined();

    expect(storage.saveNew).toHaveBeenCalledOnce();
    expect(matrix.init).toHaveBeenCalledTimes(2);
  });
});
