import {
  Method,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
  type MatrixEvent,
  type RoomMember,
  type RoomState,
} from 'matrix-js-sdk';
import {
  Observable,
  catchError,
  combineLatest,
  debounceTime,
  distinctUntilChanged,
  forkJoin,
  from,
  map,
  of,
  share,
  startWith,
  switchMap,
  timeout,
} from 'rxjs';
import { serverAdvertises } from '@trinity/data-access/matrix-client';
import { plainEqual } from '@trinity/util/matrix';

// MSC2666: the stable endpoint has no `/user` segment; the unstable one does.
const STABLE_PATH = '/_matrix/client/v1/mutual_rooms';
const UNSTABLE_PATH =
  '/_matrix/client/unstable/uk.half-shot.msc2666/user/mutual_rooms';
const MAX_PAGES = 10;
const ANSWER_TIMEOUT_MS = 10_000;
const REFETCH_DELAY_MS = 1000;

interface MutualRoomsPage {
  readonly joined?: unknown;
  readonly next_batch?: unknown;
}

/**
 * The rooms `client`'s account and `userId` have both joined, as the homeserver reports them
 * (MSC2666). Null when the server does not advertise the endpoint or the request fails, so the
 * caller falls back to its local view; so does no answer within {@link ANSWER_TIMEOUT_MS}. Cold and
 * finite; at most {@link MAX_PAGES} pages.
 */
export function mutualRoomIds(
  client: MatrixClient,
  userId: string,
): Observable<ReadonlySet<string> | null> {
  return forkJoin([
    serverAdvertises(client, {
      version: 'v1.19',
      unstableFeature: 'uk.half-shot.msc2666.query_mutual_rooms.stable',
    }),
    serverAdvertises(client, {
      unstableFeature: 'uk.half-shot.msc2666.query_mutual_rooms',
    }),
  ]).pipe(
    switchMap(([stable, unstable]) => {
      const path = stable ? STABLE_PATH : unstable ? UNSTABLE_PATH : null;
      return path ? from(fetchAll(client, path, userId)) : of(null);
    }),
    timeout(ANSWER_TIMEOUT_MS),
    catchError(() => of(null)),
  );
}

async function fetchAll(
  client: MatrixClient,
  path: string,
  userId: string,
): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  let from: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await client.http.authedRequest<MutualRoomsPage>(
      Method.Get,
      path,
      from === undefined ? { user_id: userId } : { user_id: userId, from },
      undefined,
      { prefix: '' },
    );
    if (Array.isArray(response.joined)) {
      for (const id of response.joined) if (typeof id === 'string') ids.add(id);
    }
    if (typeof response.next_batch !== 'string') break;
    from = response.next_batch;
  }
  return ids;
}

/** A member event for `userId`, or the account's own membership changing in any room. */
function membershipChanges(
  client: MatrixClient,
  userId: string,
): Observable<void> {
  return new Observable<void>((subscriber) => {
    const onMember = (
      _event: MatrixEvent,
      _state: RoomState,
      member: RoomMember,
    ): void => {
      if (member.userId === userId) subscriber.next();
    };
    const onMyMembership = (): void => subscriber.next();
    client.on(RoomStateEvent.Members, onMember);
    client.on(RoomEvent.MyMembership, onMyMembership);
    return () => {
      client.off(RoomStateEvent.Members, onMember);
      client.off(RoomEvent.MyMembership, onMyMembership);
    };
  });
}

/**
 * The `RoomListEngine.roomsInCommon` set for `client`'s account. The server is asked again
 * {@link REFETCH_DELAY_MS} after the last membership change, keeping its previous answer meanwhile.
 */
export function roomsInCommonOf(
  client: MatrixClient,
  userId: string,
): Observable<readonly string[]> {
  const changes = membershipChanges(client, userId).pipe(share());
  const answers = changes.pipe(
    debounceTime(REFETCH_DELAY_MS),
    startWith(undefined),
    switchMap(() => mutualRoomIds(client, userId)),
  );
  return combineLatest([answers, changes.pipe(startWith(undefined))]).pipe(
    map(([server]) =>
      client
        .getRooms()
        .filter((room) => {
          if (room.getMyMembership() !== 'join') return false;
          // Lazy-loaded rosters leave most members unknown; those rooms defer to the server.
          const membership = room.getMember(userId)?.membership;
          return membership
            ? membership === 'join'
            : !!server?.has(room.roomId);
        })
        .map((room) => room.roomId),
    ),
    distinctUntilChanged<readonly string[]>(plainEqual),
  );
}
