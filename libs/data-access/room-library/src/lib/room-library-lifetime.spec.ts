import { TestBed } from '@angular/core/testing';
import {
  ProjectionRuntime,
  type ProjectionReadiness,
} from '@trinity/runtime/projection';
import { MockProvider } from 'ng-mocks';
import { NEVER, Subject, concat, defer, finalize, of } from 'rxjs';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { InvitesService } from './invites.service';
import { RoomLibraryLifetime } from './room-library-lifetime';
import { RoomLibraryService } from './room-library.service';
import { SelectedRoomLibraryService } from './selected-room-library.service';
import { SpaceChildrenService } from './space-children.service';
import { SpacesService } from './spaces.service';

const readiness = (projectionCount = 4): ProjectionReadiness => ({
  scope: { kind: 'active-account' },
  durationMs: 0,
  projectionCount,
  listenerCount: 0,
  retainedBytes: 0,
  acknowledgements: [],
});

describe('RoomLibraryLifetime', () => {
  let barrier: Subject<ProjectionReadiness>;
  let waitFor: Mock<ProjectionRuntime['waitFor']>;
  let connects: Mock<() => void>[];
  let disconnects: Mock<() => void>[];
  let lifetime: RoomLibraryLifetime;

  beforeEach(() => {
    barrier = new Subject<ProjectionReadiness>();
    waitFor = vi.fn<ProjectionRuntime['waitFor']>(() => barrier);
    connects = Array.from({ length: 5 }, () => vi.fn());
    disconnects = Array.from({ length: 5 }, () => vi.fn());
    const projection = (index: number) => () =>
      defer(() => {
        connects[index]();
        return concat(of(void 0), NEVER);
      }).pipe(finalize(disconnects[index]));
    TestBed.configureTestingModule({
      providers: [
        RoomLibraryLifetime,
        MockProvider(ProjectionRuntime, { waitFor }),
        MockProvider(RoomLibraryService, {
          runProjection: projection(0),
        }),
        MockProvider(SpacesService, {
          runProjection: projection(1),
        }),
        MockProvider(InvitesService, {
          runProjection: projection(2),
        }),
        MockProvider(SpaceChildrenService, {
          runProjection: projection(3),
        }),
        MockProvider(SelectedRoomLibraryService, {
          runProjection: projection(4),
        }),
      ],
    });
    lifetime = TestBed.inject(RoomLibraryLifetime);
  });

  it('is cold, prepares the active scope, and stays owned until unsubscribe', () => {
    const events: unknown[] = [];
    const source = lifetime.run();

    expect(connects.every((connect) => connect.mock.calls.length === 0)).toBe(
      true,
    );
    const subscription = source.subscribe((event) => events.push(event));

    expect(connects.every((connect) => connect.mock.calls.length === 1)).toBe(
      true,
    );
    expect(waitFor).toHaveBeenCalledWith({ kind: 'active-account' });
    expect(events).toEqual([]);

    barrier.next(readiness());
    barrier.complete();

    expect(events).toEqual([{ kind: 'prepared' }]);
    expect(subscription.closed).toBe(false);

    subscription.unsubscribe();
    expect(
      disconnects.every((disconnect) => disconnect.mock.calls.length === 1),
    ).toBe(true);
  });

  it('accepts an empty Account scope as prepared', () => {
    const events: unknown[] = [];
    const subscription = lifetime
      .run()
      .subscribe((event) => events.push(event));

    barrier.next(readiness(0));
    barrier.complete();

    expect(events).toEqual([{ kind: 'prepared' }]);
    subscription.unsubscribe();
  });

  it('emits a typed block and releases every projection on preparation failure', () => {
    const events: unknown[] = [];
    const completed = vi.fn();
    const subscription = lifetime.run().subscribe({
      next: (event) => events.push(event),
      complete: completed,
    });

    barrier.error(new Error('reconciliation failed'));

    expect(events).toEqual([
      {
        kind: 'blocked',
        diagnostic: { code: 'room-library-projection-preparation-failed' },
      },
    ]);
    expect(completed).toHaveBeenCalledOnce();
    expect(subscription.closed).toBe(true);
    expect(
      disconnects.every((disconnect) => disconnect.mock.calls.length === 1),
    ).toBe(true);
  });

  it('starts each runtime generation with one fresh projection lifetime', () => {
    waitFor.mockReturnValue(of(readiness()));

    const first = lifetime.run().subscribe();
    first.unsubscribe();
    const second = lifetime.run().subscribe();
    second.unsubscribe();

    expect(connects.every((connect) => connect.mock.calls.length === 2)).toBe(
      true,
    );
    expect(
      disconnects.every((disconnect) => disconnect.mock.calls.length === 2),
    ).toBe(true);
  });
});
