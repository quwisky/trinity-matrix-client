import { TestBed } from '@angular/core/testing';
import type { MatrixClient } from 'matrix-js-sdk';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { UserDirectoryDiscoveryService } from './user-directory-discovery.service';

describe('UserDirectoryDiscoveryService', () => {
  const searchUserDirectory = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        UserDirectoryDiscoveryService,
        MockProvider(MatrixClientService, { isInitialized: true }),
      ],
    });
    const matrix = TestBed.inject(MatrixClientService);
    ngMocks.stubMember(matrix, 'instance', {
      searchUserDirectory,
    } as unknown as MatrixClient);
  });

  it('maps a bounded homeserver directory response with safe fallbacks', async () => {
    searchUserDirectory.mockResolvedValue({
      limited: true,
      results: [
        {
          user_id: '@bob:hs',
          display_name: 'Bob',
          avatar_url: 'mxc://hs/b',
        },
        { user_id: '@eve:hs' },
      ],
    });

    await expect(
      firstValueFrom(
        TestBed.inject(UserDirectoryDiscoveryService).search('  b  ', 12),
      ),
    ).resolves.toEqual({
      limited: true,
      users: [
        { userId: '@bob:hs', displayName: 'Bob', avatarMxc: 'mxc://hs/b' },
        { userId: '@eve:hs', displayName: '@eve:hs', avatarMxc: null },
      ],
    });
    expect(searchUserDirectory).toHaveBeenCalledWith({ term: 'b', limit: 12 });
  });

  it('short-circuits an empty term', async () => {
    await expect(
      firstValueFrom(
        TestBed.inject(UserDirectoryDiscoveryService).search('  '),
      ),
    ).resolves.toEqual({ users: [], limited: false });
    expect(searchUserDirectory).not.toHaveBeenCalled();
  });
});
