import {
  ClientEvent,
  MatrixEventEvent,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
} from 'matrix-js-sdk';
import { type MatrixClientService } from '@trinity/data-access/matrix-client';
import { buildInvite, type PendingInvite } from './invites.service';
import {
  buildRoomSummary,
  compareRoomSummaries,
  directMapOf,
  initialOf,
  spaceChildIdsOf,
} from './room-projection';
import { type RoomSummary } from './room-library.service';
import { type SpaceSummary } from './spaces.service';

export type SelectedProjectionDomain = 'rooms' | 'spaces' | 'invitations';

export const ALL_SELECTED_PROJECTION_DOMAINS: ReadonlySet<SelectedProjectionDomain> =
  new Set(['rooms', 'spaces', 'invitations']);

interface AccountSource {
  readonly accountId: string;
  readonly client: MatrixClient;
}

type Listener = () => void;

interface RegisteredListener {
  readonly event: string;
  readonly handler: Listener;
}

interface HeldAccountSource extends AccountSource {
  readonly listeners: readonly RegisteredListener[];
}

interface EventSource {
  on(event: string, handler: Listener): void;
  off(event: string, handler: Listener): void;
}

const ALL_DOMAINS = ALL_SELECTED_PROJECTION_DOMAINS;
const ROOM_DOMAINS: ReadonlySet<SelectedProjectionDomain> = new Set(['rooms']);

const EVENTS: readonly (readonly [
  string,
  ReadonlySet<SelectedProjectionDomain>,
])[] = [
  [ClientEvent.Sync, ALL_DOMAINS],
  [ClientEvent.Room, ALL_DOMAINS],
  [RoomEvent.Name, ALL_DOMAINS],
  [RoomEvent.MyMembership, ALL_DOMAINS],
  [RoomEvent.Receipt, ROOM_DOMAINS],
  [RoomEvent.Tags, ROOM_DOMAINS],
  [RoomEvent.AccountData, ROOM_DOMAINS],
  [MatrixEventEvent.Decrypted, ROOM_DOMAINS],
  [RoomStateEvent.Members, ROOM_DOMAINS],
];

/**
 * The one internal owner of selected-Account client and listener lifecycle.
 *
 * Domain projectors receive stable Account/client pairs and never attach listeners. A shared
 * SDK event is registered once per Account and invalidates only the projections it affects.
 */
export class SelectedAccountSourceRegistry {
  private readonly sources = new Map<string, HeldAccountSource>();

  constructor(
    private readonly matrix: MatrixClientService,
    private readonly invalidate: (
      domains: ReadonlySet<SelectedProjectionDomain>,
    ) => void,
  ) {}

  /** Reconcile selected, live Accounts and same-id client replacement. */
  reconcile(selectedAccountIds: ReadonlySet<string>): boolean {
    const selected =
      selectedAccountIds.size > 1 ? selectedAccountIds : new Set<string>();
    const live = new Set(this.matrix.accountIds());
    const wanted = new Set(
      [...selected].filter((accountId) => live.has(accountId)),
    );
    let changed = false;

    for (const [accountId, source] of this.sources) {
      const current = this.matrix.clientFor(accountId);
      if (!wanted.has(accountId) || current !== source.client) {
        this.detach(source);
        this.sources.delete(accountId);
        changed = true;
      }
    }

    for (const accountId of [...wanted].sort()) {
      if (this.sources.has(accountId)) continue;
      const client = this.matrix.clientFor(accountId);
      if (!client) continue;
      this.sources.set(accountId, this.attach(accountId, client));
      changed = true;
    }

    return changed;
  }

  /** Stable Account order makes duplicate fallback ownership deterministic. */
  current(): readonly AccountSource[] {
    return [...this.sources.values()]
      .sort((a, b) => a.accountId.localeCompare(b.accountId))
      .map(({ accountId, client }) => ({ accountId, client }));
  }

  release(): void {
    for (const source of this.sources.values()) this.detach(source);
    this.sources.clear();
  }

  private attach(accountId: string, client: MatrixClient): HeldAccountSource {
    const eventSource = client as unknown as EventSource;
    const listeners = EVENTS.map(([event, domains]) => {
      const handler = () => this.invalidate(domains);
      eventSource.on(event, handler);
      return { event, handler };
    });
    return { accountId, client, listeners };
  }

  private detach(source: HeldAccountSource): void {
    const eventSource = source.client as unknown as EventSource;
    for (const { event, handler } of source.listeners) {
      eventSource.off(event, handler);
    }
  }
}

/** Project and merge selected Accounts' joined, non-Space Rooms. */
export function projectSelectedRooms(
  sources: readonly AccountSource[],
  activeAccountId: string | null,
): readonly RoomSummary[] {
  const byRoomId = new Map<string, RoomSummary>();

  for (const { accountId, client } of sources) {
    const { userByRoom } = directMapOf(client);
    for (const room of client.getRooms()) {
      if (room.isSpaceRoom() || room.getMyMembership() !== 'join') continue;

      const summary = buildRoomSummary(
        room,
        accountId,
        userByRoom.get(room.roomId),
      );
      const existing = byRoomId.get(room.roomId);
      if (!existing) {
        byRoomId.set(room.roomId, summary);
        continue;
      }

      const winner =
        accountId === activeAccountId && existing.accountId !== activeAccountId
          ? summary
          : existing;
      byRoomId.set(room.roomId, {
        ...winner,
        accountIds: [...existing.accountIds, accountId],
        unreadCount: Math.max(existing.unreadCount, summary.unreadCount),
        highlightCount: Math.max(
          existing.highlightCount,
          summary.highlightCount,
        ),
        hasUnread: existing.hasUnread || summary.hasUnread,
        markedUnread: existing.markedUnread || summary.markedUnread,
        lowPriority: existing.lowPriority || summary.lowPriority,
      });
    }
  }

  return [...byRoomId.values()].sort(compareRoomSummaries);
}

export interface SelectedSpacesProjection {
  readonly spaces: readonly SpaceSummary[];
  readonly childRoomIdsByAccount: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Project selected Spaces, retaining both merged and per-Account child ownership. */
export function projectSelectedSpaces(
  sources: readonly AccountSource[],
  activeAccountId: string | null,
): SelectedSpacesProjection {
  const bySpaceId = new Map<string, SpaceSummary>();
  const childrenBySpace = new Map<string, string[]>();
  const childRoomIdsByAccount = new Map<string, Set<string>>();

  for (const { accountId, client } of sources) {
    const accountChildIds = new Set<string>();
    for (const room of client.getRooms()) {
      if (!room.isSpaceRoom() || room.getMyMembership() !== 'join') continue;

      const mergedChildren = childrenBySpace.get(room.roomId) ?? [];
      for (const childId of spaceChildIdsOf(client, room)) {
        accountChildIds.add(childId);
        if (!mergedChildren.includes(childId)) mergedChildren.push(childId);
      }
      childrenBySpace.set(room.roomId, mergedChildren);

      const existing = bySpaceId.get(room.roomId);
      if (
        existing &&
        !(
          accountId === activeAccountId &&
          existing.accountId !== activeAccountId
        )
      ) {
        continue;
      }
      const name = room.name || room.roomId;
      bySpaceId.set(room.roomId, {
        id: room.roomId,
        accountId,
        name,
        initial: initialOf(name),
        avatarMxc: room.getMxcAvatarUrl(),
        childRoomIds: [],
      });
    }
    childRoomIdsByAccount.set(accountId, accountChildIds);
  }

  const spaces = [...bySpaceId.values()]
    .map((space) => ({
      ...space,
      childRoomIds: childrenBySpace.get(space.id) ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { spaces, childRoomIdsByAccount };
}

/** Project every selected Account's invitations without cross-Account deduplication. */
export function projectSelectedInvitations(
  sources: readonly AccountSource[],
): readonly PendingInvite[] {
  const invitations: PendingInvite[] = [];
  for (const { accountId, client } of sources) {
    for (const room of client.getRooms()) {
      if (room.getMyMembership() === 'invite') {
        invitations.push(buildInvite(client, room, accountId));
      }
    }
  }
  return invitations.sort((a, b) => a.name.localeCompare(b.name));
}
