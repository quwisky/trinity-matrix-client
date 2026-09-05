import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomActionPermissionsService } from './room-action-permissions.service';
import {
  RoomAdministrationLifetime,
  RoomAdministrationLifetimeError,
} from './room-administration-lifetime';
import { RoomMembersService } from './room-members.service';

describe('RoomAdministrationLifetime', () => {
  const activeAccountId = signal<string | null>('@a:example.org');
  const demand = signal(true);
  const permissionsConnect = vi.fn();
  const permissionsDisconnect = vi.fn();
  const membersConnect = vi.fn();
  const membersDisconnect = vi.fn();

  beforeEach(() => {
    activeAccountId.set('@a:example.org');
    demand.set(true);
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        RoomAdministrationLifetime,
        MockProvider(MatrixClientService, {
          activeUserId: activeAccountId.asReadonly(),
        }),
        MockProvider(RoomActionPermissionsService, {
          connect: permissionsConnect,
          disconnect: permissionsDisconnect,
        }),
        MockProvider(RoomMembersService, {
          connect: membersConnect,
          disconnect: membersDisconnect,
        }),
        MockProvider(ProjectionRuntime, {
          waitFor: () => of(readiness()),
        }),
      ],
    });
  });

  it('retains permissions and authoritative members as one cold lifetime', () => {
    const source = TestBed.inject(RoomAdministrationLifetime).run(
      demand.asReadonly(),
    );
    const prepared = vi.fn();

    expect(permissionsConnect).not.toHaveBeenCalled();
    expect(membersConnect).not.toHaveBeenCalled();

    const lifetime = source.subscribe(prepared);
    expect(prepared).toHaveBeenCalledWith(undefined);
    expect(permissionsConnect).toHaveBeenCalledOnce();
    expect(membersConnect).toHaveBeenCalledOnce();

    lifetime.unsubscribe();
    expect(membersDisconnect).toHaveBeenCalledOnce();
    expect(permissionsDisconnect).toHaveBeenCalledOnce();
  });

  it('follows Application Runtime demand without a page lifetime owner', () => {
    demand.set(false);
    const lifetime = TestBed.inject(RoomAdministrationLifetime)
      .run(demand.asReadonly())
      .subscribe();

    expect(permissionsConnect).not.toHaveBeenCalled();
    expect(membersConnect).not.toHaveBeenCalled();

    demand.set(true);
    TestBed.tick();
    expect(permissionsConnect).toHaveBeenCalledOnce();
    expect(membersConnect).toHaveBeenCalledOnce();

    demand.set(false);
    TestBed.tick();
    expect(membersDisconnect).toHaveBeenCalledOnce();
    expect(permissionsDisconnect).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('cleans up a partial attachment and exposes only a typed lifetime error', () => {
    membersConnect.mockImplementationOnce(() => {
      throw new Error('private Matrix failure');
    });
    const error = vi.fn();

    TestBed.inject(RoomAdministrationLifetime)
      .run(demand.asReadonly())
      .subscribe({ error });

    expect(error).toHaveBeenCalledWith(
      expect.any(RoomAdministrationLifetimeError),
    );
    expect(error.mock.calls[0]?.[0].message).not.toContain(
      'private Matrix failure',
    );
    expect(membersDisconnect).toHaveBeenCalledOnce();
    expect(permissionsDisconnect).toHaveBeenCalledOnce();
  });

  it('reacquires both projections when an Account appears after an empty set', () => {
    activeAccountId.set(null);
    const lifetime = TestBed.inject(RoomAdministrationLifetime)
      .run(demand.asReadonly())
      .subscribe();

    expect(permissionsConnect).not.toHaveBeenCalled();
    expect(membersConnect).not.toHaveBeenCalled();

    activeAccountId.set('@b:example.org');
    TestBed.tick();
    expect(permissionsConnect).toHaveBeenCalledOnce();
    expect(membersConnect).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });
});

function readiness() {
  return {
    scope: { kind: 'active-account' } as const,
    durationMs: 0,
    projectionCount: 2,
    listenerCount: 3,
    retainedBytes: 0,
    acknowledgements: [],
  };
}
