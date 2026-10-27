import { Injectable, inject } from '@angular/core';
import { AutoDiscovery, RoomType } from 'matrix-js-sdk';
import type { MatrixClient } from 'matrix-js-sdk';
import { Observable, catchError, defer, from, map, of } from 'rxjs';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import {
  type EngineResult,
  NOT_SIGNED_IN,
  describeMatrixRequestFailure,
  engineFail,
  engineOk,
} from '@trinity/util/matrix';
import type {
  DiscoveryEngine,
  PublicRoomsPage,
  PublicRoomsQuery,
  UserDirectoryPage,
} from '../discovery-engine';

// The SDK's own 5 s abort is hard-coded and its fetch failures look like a definitive "no
// homeserver". Only the first (cold) request is slow, so it gets 8 s and the retries 5 s each,
// with 0.5 s and 1 s backoff: at most 8 + 0.5 + 5 + 1 + 5 = 19.5 s per request, 39 s for
// well-known + versions.
const ATTEMPT_TIMEOUTS_MS = [8_000, 5_000, 5_000];
const RETRY_DELAYS_MS = [500, 1_000];
const RETRIED_PATH =
  /\/(\.well-known\/matrix\/client|_matrix\/client\/versions)$/;

/**
 * `fetch` for the SDK's discovery requests. Only a thrown failure (timeout, network error, or a
 * body that stalls) of the well-known and versions requests is retried; any HTTP response, including
 * 404/500, is a definitive answer. Other requests (the ignored identity server) pass straight through.
 */
async function fetchWithRetry(
  resource: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const url = resource instanceof Request ? resource.url : String(resource);
  if (!RETRIED_PATH.test(new URL(url).pathname)) {
    return fetch(resource, init);
  }
  for (let attempt = 0; ; attempt++) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), ATTEMPT_TIMEOUTS_MS[attempt]);
    try {
      // Replaces the SDK's signal: it is already aborted by the time a retry would reuse it.
      // A caller-supplied `init.signal` is dropped on purpose (the SDK only passes its own 5 s
      // timeoutSignal today); chain it here if a future SDK passes a real cancel signal.
      const res = await fetch(resource, { ...init, signal: abort.signal });
      // Read the body inside the attempt so a stall after the headers is also timed out and retried.
      const body = await res.arrayBuffer();
      return new Response(body.byteLength ? body : null, res);
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAYS_MS[attempt]),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

@Injectable({ providedIn: 'root' })
export class JsSdkDiscoveryEngine implements DiscoveryEngine {
  private readonly clients = inject(JS_SDK_CLIENTS);

  constructor() {
    AutoDiscovery.setFetchFn(fetchWithRetry);
  }

  discover(
    domain: string,
  ): Observable<
    EngineResult<{ readonly domain: string; readonly baseUrl: string }>
  > {
    return defer(() => from(AutoDiscovery.findClientConfig(domain))).pipe(
      map((config) => {
        const homeserver = config['m.homeserver'];
        if (
          homeserver.state === AutoDiscovery.FAIL_PROMPT ||
          homeserver.state === AutoDiscovery.FAIL_ERROR
        ) {
          return engineFail({
            kind: 'unexpected',
            message:
              typeof homeserver.error === 'string'
                ? homeserver.error
                : `Could not discover a homeserver for "${domain}".`,
            diagnostic: { kind: 'unexpected' },
          });
        }
        const baseUrl = (homeserver.base_url ?? `https://${domain}`).replace(
          /\/$/,
          '',
        );
        return engineOk({ domain, baseUrl });
      }),
      catchError((err: unknown) =>
        of(engineFail(describeMatrixRequestFailure(err))),
      ),
    );
  }

  searchPublicRooms(
    accountId: string,
    query: PublicRoomsQuery,
  ): Observable<EngineResult<PublicRoomsPage>> {
    return this.request(accountId, async (client) => {
      const term = query.term?.trim();
      const filter = {
        ...(term ? { generic_search_term: term } : {}),
        ...(query.spaces ? { room_types: [RoomType.Space] } : {}),
      };
      const res = await client.publicRooms({
        limit: query.limit,
        ...(query.since ? { since: query.since } : {}),
        ...(Object.keys(filter).length ? { filter } : {}),
      });
      return {
        rooms: (res.chunk ?? []).map((chunk) => ({
          roomId: chunk.room_id,
          name: chunk.name || chunk.canonical_alias || chunk.room_id,
          topic: chunk.topic || null,
          alias: chunk.canonical_alias ?? null,
          avatarMxc: chunk.avatar_url ?? null,
          memberCount: chunk.num_joined_members ?? 0,
          isSpace: chunk.room_type === 'm.space',
        })),
        nextBatch: res.next_batch ?? null,
        total: res.total_room_count_estimate ?? null,
      };
    });
  }

  joinRoom(
    accountId: string,
    roomIdOrAlias: string,
  ): Observable<EngineResult<{ readonly roomId: string }>> {
    return this.request(accountId, async (client) => {
      const room = await client.joinRoom(roomIdOrAlias);
      return { roomId: room.roomId };
    });
  }

  searchUserDirectory(
    accountId: string,
    term: string,
    limit: number,
  ): Observable<EngineResult<UserDirectoryPage>> {
    return this.request(accountId, async (client) => {
      const response = await client.searchUserDirectory({ term, limit });
      return {
        users: response.results.map((user) => ({
          userId: user.user_id,
          displayName: user.display_name || user.user_id,
          avatarMxc: user.avatar_url ?? null,
        })),
        limited: response.limited === true,
      };
    });
  }

  // The client is looked up on subscribe, not when built: a client read earlier is stale
  // after an OIDC rotation.
  private request<T>(
    accountId: string,
    run: (client: MatrixClient) => Promise<T>,
  ): Observable<EngineResult<T>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) {
        return of(engineFail(NOT_SIGNED_IN));
      }
      return from(run(client)).pipe(
        map((value) => engineOk(value)),
        catchError((err: unknown) =>
          of(engineFail(describeMatrixRequestFailure(err))),
        ),
      );
    });
  }
}
