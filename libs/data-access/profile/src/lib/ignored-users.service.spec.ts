import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { IgnoredUsersService } from './ignored-users.service';

function setup(ignored: string[] = []) {
  const setIgnoredUsers = vi.fn().mockResolvedValue({});
  const instance = {
    getIgnoredUsers: () => ignored,
    setIgnoredUsers,
    isUserIgnored: (id: string) => ignored.includes(id),
  };
  TestBed.configureTestingModule({
    providers: [
      IgnoredUsersService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: instance as never,
      }),
    ],
  });
  return { svc: TestBed.inject(IgnoredUsersService), setIgnoredUsers };
}

describe('IgnoredUsersService', () => {
  it('isIgnored reflects the current ignore list', () => {
    const { svc } = setup(['@bob:hs']);
    expect(svc.isIgnored('@bob:hs')).toBe(true);
    expect(svc.isIgnored('@eve:hs')).toBe(false);
  });

  it('ignore is cold and appends the user to the list on subscribe', async () => {
    const { svc, setIgnoredUsers } = setup(['@existing:hs']);

    const action = svc.ignore('@bob:hs');
    expect(setIgnoredUsers).not.toHaveBeenCalled(); // cold

    await firstValueFrom(action);
    expect(setIgnoredUsers).toHaveBeenCalledWith(['@existing:hs', '@bob:hs']);
  });

  it('ignore does not duplicate an already-ignored user', async () => {
    const { svc, setIgnoredUsers } = setup(['@bob:hs']);

    await firstValueFrom(svc.ignore('@bob:hs'));

    expect(setIgnoredUsers).toHaveBeenCalledWith(['@bob:hs']);
  });

  it('unignore removes the user from the list', async () => {
    const { svc, setIgnoredUsers } = setup(['@bob:hs', '@eve:hs']);

    await firstValueFrom(svc.unignore('@bob:hs'));

    expect(setIgnoredUsers).toHaveBeenCalledWith(['@eve:hs']);
  });
});
