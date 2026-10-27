import {
  EventType,
  RoomType,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { liveRoomState } from '@trinity/util/matrix';
import { compareOrder, isValidOrder } from '../space-child-order';
import type { HierarchyEntry, SpaceChildLink } from '../room-list-engine';

const HIERARCHY_LIMIT = 100;

function linkOf(
  childId: string,
  content: Record<string, unknown>,
): SpaceChildLink {
  const via = content['via'];
  return {
    childId,
    via: Array.isArray(via)
      ? via.filter((server): server is string => typeof server === 'string')
      : [],
    suggested: content['suggested'] === true,
    order: typeof content['order'] === 'string' ? content['order'] : '',
  };
}

/**
 * The child links a space's state declares, ordered the way the spec sorts them.
 */
export function readChildLinks(space: Room | null): SpaceChildLink[] {
  const state = space ? liveRoomState(space) : null;
  if (!state) return [];
  return (
    state
      .getStateEvents(EventType.SpaceChild)
      .map((event) => {
        const link = linkOf(event.getStateKey() ?? '', event.getContent());
        // An order the spec rejects must be treated as no order at all, or this client
        // sorts by a key every other client ignores.
        return isValidOrder(link.order) ? link : { ...link, order: '' };
      })
      // An empty `via` is the spec's tombstone for a removed child, not a live link.
      .filter((link) => link.childId && link.via.length > 0)
      .sort(
        (a, b) =>
          compareOrder(a.order, b.order) || (a.childId < b.childId ? -1 : 1),
      )
  );
}

/** The `m.space.child` content for a link, or the empty content that removes it. */
export function childContent(
  link: Omit<SpaceChildLink, 'childId'> | null,
): Record<string, unknown> {
  if (!link) return {};
  return {
    via: [...link.via],
    ...(link.suggested ? { suggested: true } : {}),
    ...(link.order ? { order: link.order } : {}),
  };
}

/**
 * A space's direct children (`maxDepth: 1`, `suggestedOnly: false`) across `next_batch`
 * pages, the space itself included. A single page would drop the overflow of a space with
 * more than {@link HIERARCHY_LIMIT} children; a repeated token would loop forever.
 */
export async function fetchHierarchy(
  client: MatrixClient,
  spaceId: string,
  maxPages: number | null,
): Promise<HierarchyEntry[]> {
  const entries: HierarchyEntry[] = [];
  const seenTokens = new Set<string>();
  let fromToken: string | undefined;
  for (let page = 0; maxPages === null || page < maxPages; page++) {
    const response = await client.getRoomHierarchy(
      spaceId,
      HIERARCHY_LIMIT,
      1,
      false,
      fromToken,
    );
    for (const room of response.rooms) {
      entries.push({
        roomId: room.room_id,
        name: room.name || null,
        canonicalAlias: room.canonical_alias || null,
        topic: room.topic || null,
        avatarMxc: room.avatar_url ?? null,
        joinedMemberCount: room.num_joined_members ?? 0,
        joinRule: room.join_rule ? String(room.join_rule) : null,
        isSpace: room.room_type === RoomType.Space,
        childrenState: (room.children_state ?? [])
          .filter((event) => event.state_key)
          .map((event) =>
            linkOf(event.state_key, event.content as Record<string, unknown>),
          ),
      });
    }
    if (!response.next_batch) break;
    if (seenTokens.has(response.next_batch)) {
      throw new Error('The Space hierarchy returned a repeated page token.');
    }
    seenTokens.add(response.next_batch);
    fromToken = response.next_batch;
  }
  return entries;
}

/**
 * Our homeserver name from the user id (`@user:server.tld` → `server.tld`), for the `via` of
 * links to a room we just created. Empty when there is no server part; the homeserver still
 * accepts the link, just without routing help.
 */
export function serverNameOf(userId: string | null): string {
  const colon = userId?.indexOf(':') ?? -1;
  return colon >= 0 ? (userId as string).slice(colon + 1) : '';
}
