import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import {
  type MockInstance,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { FakeDiscoveryEngine } from '../contract/fake-discovery-engine';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { DISCOVERY_ENGINE } from './discovery-engine';
import { UserDirectoryDiscoveryService } from './user-directory-discovery.service';

describe('UserDirectoryDiscoveryService', () => {
  const activeUserId = signal<string | null>('@me:hs');
  let engine: FakeDiscoveryEngine;
  let search: MockInstance<FakeDiscoveryEngine['searchUserDirectory']>;

  beforeEach(() => {
    activeUserId.set('@me:hs');
    engine = new FakeDiscoveryEngine();
    engine.accounts.add('@me:hs');
    engine.users.push(
      { userId: '@bob:hs', displayName: 'Bob', avatarMxc: 'mxc://hs/b' },
      { userId: '@eve:hs', displayName: '@eve:hs', avatarMxc: null },
    );
    search = vi.spyOn(engine, 'searchUserDirectory');
    TestBed.configureTestingModule({
      providers: [
        UserDirectoryDiscoveryService,
        { provide: DISCOVERY_ENGINE, useValue: engine },
        MockProvider(MatrixClientService, { activeUserId }),
      ],
    });
  });

  const run = (term: string, limit?: number) =>
    firstValueFrom(
      TestBed.inject(UserDirectoryDiscoveryService).search(term, limit),
    );

  it('searches the active account with a trimmed term and the limit', async () => {
    await expect(run('  hs  ', 1)).resolves.toEqual({
      limited: true,
      users: [
        { userId: '@bob:hs', displayName: 'Bob', avatarMxc: 'mxc://hs/b' },
      ],
    });
    expect(search).toHaveBeenCalledWith('@me:hs', 'hs', 1);
  });

  it('defaults the limit to 30', async () => {
    await run('b');

    expect(search).toHaveBeenCalledWith('@me:hs', 'b', 30);
  });

  it('short-circuits an empty term', async () => {
    await expect(run('  ')).resolves.toEqual({ users: [], limited: false });
    expect(search).not.toHaveBeenCalled();
  });

  it('errors with "Not signed in." when no account is active', async () => {
    activeUserId.set(null);

    await expect(run('b')).rejects.toThrow('Not signed in.');
    expect(search).not.toHaveBeenCalled();
  });
});
