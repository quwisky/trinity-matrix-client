import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { Observable, Subject, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityService } from '@trinity/data-access/identity';
import {
  RoomLibrarySearchService,
  type RoomLibrarySearchResult,
} from '@trinity/data-access/room-library';
import {
  UserDirectoryDiscoveryService,
  type UserDirectoryPage,
} from '@trinity/data-access/discovery';
import {
  GlobalSearchService,
  type SwitcherResult,
} from './global-search.service';

const LOCAL = {
  kind: 'room',
  id: '!room:hs',
  title: 'Room',
  avatarMxc: null,
  initial: 'R',
  score: 100,
  accountId: '@me:hs',
} as const satisfies RoomLibrarySearchResult & SwitcherResult;

describe('GlobalSearchService', () => {
  const localSearch = vi.fn(() => [LOCAL]);
  const peopleSearch = vi.fn<(term: string) => Observable<UserDirectoryPage>>(
    () => of({ users: [], limited: false }),
  );

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        GlobalSearchService,
        MockProvider(RoomLibrarySearchService, { search: localSearch }),
        MockProvider(UserDirectoryDiscoveryService, { search: peopleSearch }),
        MockProvider(IdentityService, {
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
        }),
      ],
    });
  });

  function create(activeOnly = false) {
    const query = signal('');
    const session = TestBed.inject(GlobalSearchService).createSession(
      query,
      signal(activeOnly).asReadonly(),
      TestBed.inject(Injector),
    );
    return { query, session };
  }

  it('keeps local results live and scopes them before ranking', () => {
    const { query, session } = create(true);

    expect(session.results()).toEqual([LOCAL]);
    query.set('room');
    expect(session.results()).toEqual([LOCAL]);
    expect(localSearch).toHaveBeenLastCalledWith('room', undefined, '@me:hs');
  });

  it('debounces remote people and exposes typed group pagination', async () => {
    peopleSearch.mockReturnValue(
      of({
        limited: true,
        users: [{ userId: '@bob:hs', displayName: 'Bob', avatarMxc: null }],
      }),
    );
    const { query, session } = create();

    query.set('bob');
    TestBed.flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 280));

    expect(peopleSearch).toHaveBeenCalledWith('bob');
    expect(session.groups()[1]).toMatchObject({
      kind: 'people',
      status: 'ready',
      limited: true,
    });
    expect(session.results().map((result) => result.id)).toEqual([
      '!room:hs',
      '@bob:hs',
    ]);
  });

  it('cancels a stale remote lookup and reports only the current safe failure', async () => {
    const first = new Subject<UserDirectoryPage>();
    peopleSearch
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(
        new Observable((subscriber) =>
          subscriber.error(new Error('secret server detail')),
        ),
      );
    const { query, session } = create();

    query.set('first');
    TestBed.flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 280));
    query.set('second');
    TestBed.flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 280));
    first.next({ users: [], limited: false });

    expect(session.failure()).toEqual({
      source: 'people',
      message: 'People search is temporarily unavailable.',
      retryable: true,
    });
    expect(session.failure()?.message).not.toContain('secret');
  });

  it('maps every row to a fully qualified Workspace search intent', () => {
    const service = TestBed.inject(GlobalSearchService);

    expect(service.destinationFor(LOCAL)).toEqual({
      kind: 'conversation',
      accountId: '@me:hs',
      roomId: '!room:hs',
    });
    expect(
      service.destinationFor({
        kind: 'user',
        id: '@bob:hs',
        title: 'Bob',
        avatarMxc: null,
        initial: 'B',
        score: 0,
        accountId: '@me:hs',
      }),
    ).toEqual({
      kind: 'person',
      accountId: '@me:hs',
      userId: '@bob:hs',
    });
  });
});
