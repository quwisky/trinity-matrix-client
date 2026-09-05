import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  ProjectionRuntime,
  type ProjectionObservation,
} from '@trinity/runtime/projection';
import { MockProvider } from 'ng-mocks';
import {
  BehaviorSubject,
  Observable,
  type Subscriber,
  firstValueFrom,
} from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomActionPermissionsService } from './room-action-permissions.service';
import type {
  RoomAdministrationHealth,
  RoomAdministrationLifetimeEvent,
} from './room-administration-health.models';
import { RoomAdministrationLifetime } from './room-administration-lifetime';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';
import { RoomMembersService } from './room-members.service';

describe('RoomAdministrationLifetime', () => {
  const activeAccountId = signal<string | null>('@a:example.org');
  const roomId = signal<string | null>('!one:example.org');
  const demand = signal(true);
  const permissionsState = new BehaviorSubject<ProjectionObservation>({
    condition: 'available',
    generation: 1,
  });
  const membersState = new BehaviorSubject<ProjectionObservation>({
    condition: 'available',
    generation: 1,
  });
  const permissionsConnect = vi.fn();
  const permissionsDisconnect = vi.fn();
  const membersConnect = vi.fn();
  const membersDisconnect = vi.fn();
  const permissionsRetry = vi.fn();
  const membersRetry = vi.fn();
  let permissionsOwner: Subscriber<void> | null;
  let _membersOwner: Subscriber<void> | null;

  beforeEach(() => {
    activeAccountId.set('@a:example.org');
    roomId.set('!one:example.org');
    demand.set(true);
    permissionsState.next({ condition: 'available', generation: 1 });
    membersState.next({ condition: 'available', generation: 1 });
    permissionsOwner = null;
    _membersOwner = null;
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        RoomAdministrationLifetime,
        RoomAdministrationProjectionState,
        MockProvider(MatrixClientService, {
          activeUserId: activeAccountId.asReadonly(),
        }),
        MockProvider(RoomActionPermissionsService, {
          runProjection: () =>
            ownedProjection(
              permissionsConnect,
              permissionsDisconnect,
              (owner) => (permissionsOwner = owner),
            ),
          retryProjection: permissionsRetry,
        }),
        MockProvider(RoomMembersService, {
          runProjection: () =>
            ownedProjection(
              membersConnect,
              membersDisconnect,
              (owner) => (_membersOwner = owner),
            ),
          retryProjection: membersRetry,
        }),
        MockProvider(ProjectionRuntime, {
          observe: (id: string) =>
            id === 'room-administration.action-permissions'
              ? permissionsState
              : membersState,
        }),
      ],
    });
  });

  it('is cold, publishes three available operations, and releases both owners once', () => {
    const events: RoomAdministrationLifetimeEvent[] = [];
    const source = TestBed.inject(RoomAdministrationLifetime).run(
      demand.asReadonly(),
      roomId.asReadonly(),
    );
    expect(permissionsConnect).not.toHaveBeenCalled();

    const lifetime = source.subscribe((event) => events.push(event));

    expect(permissionsConnect).toHaveBeenCalledOnce();
    expect(membersConnect).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.kind === 'prepared')).toHaveLength(1);
    expect(latest(events, 'permissions')).toMatchObject({
      condition: 'available',
      ownership: 'retained',
    });
    expect(latest(events, 'members').condition).toBe('available');
    expect(latest(events, 'bans').condition).toBe('available');

    lifetime.unsubscribe();
    lifetime.unsubscribe();
    expect(permissionsDisconnect).toHaveBeenCalledOnce();
    expect(membersDisconnect).toHaveBeenCalledOnce();
  });

  it.each([
    ['no Account', null, '!one:example.org', true],
    ['no Room', '@a:example.org', null, true],
    ['no route demand', '@a:example.org', '!one:example.org', false],
  ])('treats %s as expected dormancy', (_label, account, room, required) => {
    activeAccountId.set(account);
    roomId.set(room);
    demand.set(required);
    const events: RoomAdministrationLifetimeEvent[] = [];
    const lifetime = run(events);

    expect(permissionsConnect).not.toHaveBeenCalled();
    expect(latest(events, 'permissions')).toMatchObject({
      demanded: false,
      condition: 'not-applicable',
      code: 'room-administration-not-demanded',
    });
    lifetime.unsubscribe();
  });

  it('distinguishes initial unavailable membership from a retained stale snapshot', () => {
    membersState.next({ condition: 'failed', generation: 1 });
    const initialEvents: RoomAdministrationLifetimeEvent[] = [];
    const initial = run(initialEvents);
    const presentation = TestBed.inject(RoomAdministrationProjectionState);
    expect(presentation.availability('members', roomId())).toBe('unavailable');
    expect(latest(initialEvents, 'members')).toMatchObject({
      condition: 'degraded',
      ownership: 'retained',
    });
    initial.unsubscribe();

    membersState.next({ condition: 'available', generation: 2 });
    const events: RoomAdministrationLifetimeEvent[] = [];
    const lifetime = run(events);
    membersState.next({ condition: 'failed', generation: 3 });

    expect(presentation.availability('members', roomId())).toBe('stale');
    expect(presentation.availability('bans', roomId())).toBe('stale');
    expect(presentation.availability('permissions', roomId())).toBe('coherent');
    lifetime.unsubscribe();
  });

  it('repairs only a retained failed projection and completes on authoritative success', async () => {
    const events: RoomAdministrationLifetimeEvent[] = [];
    const service = TestBed.inject(RoomAdministrationLifetime);
    const lifetime = run(events);
    membersState.next({ condition: 'failed', generation: 2 });
    const failed = latest(events, 'members');

    const recovery = firstValueFrom(
      service.recover('members', failed.context, failed.generation),
    );
    expect(membersRetry).toHaveBeenCalledOnce();
    expect(permissionsRetry).not.toHaveBeenCalled();
    expect(membersConnect).toHaveBeenCalledOnce();

    membersState.next({ condition: 'available', generation: 3 });
    await expect(recovery).resolves.toEqual({ kind: 'success' });
    expect(latest(events, 'members').condition).toBe('available');
    lifetime.unsubscribe();
  });

  it('restores both owners after release without duplicating retained listeners', async () => {
    const events: RoomAdministrationLifetimeEvent[] = [];
    const service = TestBed.inject(RoomAdministrationLifetime);
    const lifetime = run(events);
    permissionsOwner?.complete();
    const released = latest(events, 'permissions');
    expect(released).toMatchObject({
      condition: 'degraded',
      ownership: 'released',
      code: 'room-administration-ownership-released',
    });
    expect(permissionsDisconnect).toHaveBeenCalledOnce();
    expect(membersDisconnect).toHaveBeenCalledOnce();

    const recovery = firstValueFrom(
      service.recover('permissions', released.context, released.generation),
    );
    await expect(recovery).resolves.toEqual({ kind: 'success' });
    expect(permissionsConnect).toHaveBeenCalledTimes(2);
    expect(membersConnect).toHaveBeenCalledTimes(2);
    expect(permissionsRetry).not.toHaveBeenCalled();
    lifetime.unsubscribe();
    expect(permissionsDisconnect).toHaveBeenCalledTimes(2);
    expect(membersDisconnect).toHaveBeenCalledTimes(2);
  });

  it('does not label reset data stale after leaving and re-entering a Room', () => {
    const events: RoomAdministrationLifetimeEvent[] = [];
    const lifetime = run(events);
    const presentation = TestBed.inject(RoomAdministrationProjectionState);
    expect(presentation.availability('members', roomId())).toBe('coherent');

    roomId.set('!two:example.org');
    TestBed.tick();
    membersState.next({ condition: 'failed', generation: 2 });
    roomId.set('!one:example.org');
    TestBed.tick();

    expect(presentation.availability('members', roomId())).toBe('unavailable');
    expect(presentation.availability('bans', roomId())).toBe('unavailable');
    expect(latest(events, 'members')).toMatchObject({
      condition: 'degraded',
      ownership: 'retained',
    });
    lifetime.unsubscribe();
  });

  it('retires exact Room health and rejects recovery after a Room or Account switch', async () => {
    membersState.next({ condition: 'failed', generation: 2 });
    const events: RoomAdministrationLifetimeEvent[] = [];
    const service = TestBed.inject(RoomAdministrationLifetime);
    const lifetime = run(events);
    const oldRoom = latest(events, 'members');

    roomId.set('!two:example.org');
    TestBed.tick();
    await expect(
      firstValueFrom(
        service.recover('members', oldRoom.context, oldRoom.generation),
      ),
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(latest(events, 'members').context).not.toBe(oldRoom.context);

    const secondRoom = latest(events, 'members');
    activeAccountId.set('@b:example.org');
    TestBed.tick();
    await expect(
      firstValueFrom(
        service.recover('members', secondRoom.context, secondRoom.generation),
      ),
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(latest(events, 'members').context).not.toBe(secondRoom.context);
    lifetime.unsubscribe();
  });

  it('bounds preparation and later accepts a successful retained reconciliation', () => {
    vi.useFakeTimers();
    membersState.next({ condition: 'reconciling', generation: 2 });
    const events: RoomAdministrationLifetimeEvent[] = [];
    const lifetime = run(events);

    vi.advanceTimersByTime(10_000);
    expect(latest(events, 'members')).toMatchObject({
      condition: 'degraded',
      code: 'room-administration-preparation-timeout',
    });
    expect(events.filter((event) => event.kind === 'prepared')).toHaveLength(1);

    membersState.next({ condition: 'available', generation: 3 });
    expect(latest(events, 'members').condition).toBe('available');
    lifetime.unsubscribe();
    vi.useRealTimers();
  });

  function run(events: RoomAdministrationLifetimeEvent[]) {
    return TestBed.inject(RoomAdministrationLifetime)
      .run(demand.asReadonly(), roomId.asReadonly())
      .subscribe((event) => events.push(event));
  }
});

function ownedProjection(
  connect: () => void,
  disconnect: () => void,
  owner: (subscriber: Subscriber<void>) => void,
): Observable<void> {
  return new Observable((subscriber) => {
    connect();
    owner(subscriber);
    subscriber.next();
    return disconnect;
  });
}

function latest(
  events: readonly RoomAdministrationLifetimeEvent[],
  operation: RoomAdministrationHealth['operation'],
): RoomAdministrationHealth {
  const event = events
    .filter(
      (candidate) =>
        candidate.kind === 'health' && candidate.fact.operation === operation,
    )
    .at(-1);
  if (!event || event.kind !== 'health')
    throw new Error('Missing health fact.');
  return event.fact;
}
