import { Method, type MatrixClient } from 'matrix-js-sdk';
import { Observable, catchError, forkJoin, from, of, switchMap } from 'rxjs';
import { serverAdvertises } from './server-support';

// MSC2666: the stable endpoint has no `/user` segment; the unstable one does.
const STABLE_PATH = '/_matrix/client/v1/mutual_rooms';
const UNSTABLE_PATH =
  '/_matrix/client/unstable/uk.half-shot.msc2666/user/mutual_rooms';
const MAX_PAGES = 10;

interface MutualRoomsPage {
  readonly joined?: unknown;
  readonly next_batch?: unknown;
}

/**
 * The rooms `client`'s account and `userId` have both joined, as the homeserver reports them
 * (MSC2666). Null when the server does not advertise the endpoint or the request fails, so the
 * caller falls back to its local view. Cold and finite; at most {@link MAX_PAGES} pages.
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
      return path
        ? from(fetchAll(client, path, userId)).pipe(catchError(() => of(null)))
        : of(null);
    }),
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
