import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import { MatrixError } from '@trinity/util/matrix';
import { MockProvider } from 'ng-mocks';
import { NEVER, concat, defer, finalize, of } from 'rxjs';
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
  const projection = (connect: () => void, disconnect: () => void) => () =>
    defer(() => {
      connect();
      return concat(of(void 0), NEVER);
    }).pipe(finalize(disconnect));

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
          runProjection: projection(permissionsConnect, permissionsDisconnect),
        }),
        MockProvider(RoomMembersService, {
          runProjection: projection(membersConnect, membersDisconnect),
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

  it('cleans up a partial attachment without masking an adapter defect', () => {
    const defect = new Error('broken member adapter');
    membersConnect.mockImplementationOnce(() => {
      throw defect;
    });
    const error = vi.fn();

    TestBed.inject(RoomAdministrationLifetime)
      .run(demand.asReadonly())
      .subscribe({ error });

    expect(error).toHaveBeenCalledWith(defect);
    expect(membersDisconnect).toHaveBeenCalledOnce();
    expect(permissionsDisconnect).toHaveBeenCalledOnce();
  });

  it('classifies a transient Matrix projection failure without leaking details', () => {
    membersConnect.mockImplementationOnce(() => {
      throw new MatrixError(
        { errcode: 'M_UNKNOWN', error: 'private server response' },
        503,
      );
    });
    const error = vi.fn();

    TestBed.inject(RoomAdministrationLifetime)
      .run(demand.asReadonly())
      .subscribe({ error });

    expect(error).toHaveBeenCalledWith(
      expect.any(RoomAdministrationLifetimeError),
    );
    expect(error.mock.calls[0]?.[0].message).not.toContain('private');
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
