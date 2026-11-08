import {
  ClientEvent,
  EventType,
  MatrixEventEvent,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomMember,
  type RoomState,
} from 'matrix-js-sdk';
import { type MatrixClientService } from '@trinity/data-access/matrix-client';
import { RoomEncryptionFlags, initialOf } from '@trinity/util/matrix';
import {
  buildInvite,
  sameInvites,
  type PendingInvite,
} from './invites.service';
import {
  buildRoomSummary,
  compareRoomSummaries,
  sdkMovedRow,
  decryptionChangesRow,
  directMapOf,
  isJoinedSpace,
  reuseUnchanged,
  sameRooms,
  spaceChildIdsOf,
} from './room-projection';
import { type RoomSummary } from './room-library.service';
import { sameIds, sameSpaces, type SpaceSummary } from './spaces.service';

export type SelectedProjectionDomain = 'rooms' | 'spaces' | 'invitations';

export const ALL_SELECTED_PROJECTION_DOMAINS: ReadonlySet<SelectedProjectionDomain> =
  new Set(['rooms', 'spaces', 'invitations']);

/**
 * One Account's last projected rows and the rooms whose rows the next projection rebuilds;
 * every other row keeps its summary, as in {@link RoomLibraryService}'s own rebuild.
 */
export class AccountRows {
  rows = new Map<string, RoomSummary>();
  readonly dirty = new Set<string>();
  /** Rebuild every row next time: something that no single room names has changed. */
  all = true;
  syncState: string | null = null;

  /** Mark a room's row, or every row when the event names no room. */
  mark(roomId: string | undefined): void {
    if (roomId) this.dirty.add(roomId);
    else this.all = true;
  }
}

interface AccountSource {
  readonly accountId: string;
  readonly client: MatrixClient;
  /** Room lock marks for this client: the room state, or else its crypto store. */
  readonly encryption?: RoomEncryptionFlags;
  readonly rows?: AccountRows;
}

type Listener = (event?: MatrixEvent, ...rest: never[]) => void;
type RoomIdOf = (args: readonly unknown[]) => string | undefined;

interface RegisteredListener {
  readonly event: string;
  readonly handler: Listener;
}

interface HeldAccountSource extends AccountSource {
  readonly encryption: RoomEncryptionFlags;
  readonly rows: AccountRows;
  readonly listeners: readonly RegisteredListener[];
}

interface EventSource {
  on(event: string, handler: Listener): void;
  off(event: string, handler: Listener): void;
}

const ALL_DOMAINS = ALL_SELECTED_PROJECTION_DOMAINS;
const ROOM_DOMAINS: ReadonlySet<SelectedProjectionDomain> = new Set(['rooms']);
const NO_DOMAINS: ReadonlySet<SelectedProjectionDomain> = new Set();

const roomAt =
  (index: number): RoomIdOf =>
  (args) =>
    (args[index] as Room | undefined)?.roomId;
const eventRoom: RoomIdOf = (args) =>
  (args[0] as MatrixEvent | undefined)?.getRoomId?.();
const roomOrEventRoom: RoomIdOf = (args) => roomAt(1)(args) ?? eventRoom(args);

/** Each event, the projections it invalidates, and the room whose row it marks. */
const EVENTS: readonly (readonly [
  string,
  ReadonlySet<SelectedProjectionDomain>,
  RoomIdOf,
])[] = [
  [ClientEvent.Room, ALL_DOMAINS, roomAt(0)],
  [RoomEvent.Name, ALL_DOMAINS, roomAt(0)],
  [RoomEvent.MyMembership, ALL_DOMAINS, roomAt(0)],
  [RoomEvent.Receipt, ROOM_DOMAINS, roomAt(1)],
  [RoomEvent.Tags, ROOM_DOMAINS, roomAt(1)],
  [RoomEvent.AccountData, ROOM_DOMAINS, roomAt(1)],
  [MatrixEventEvent.Replaced, ROOM_DOMAINS, eventRoom],
  // Rebuilt by the sync that carries them.
  [RoomEvent.Timeline, NO_DOMAINS, roomOrEventRoom],
  [RoomEvent.TimelineReset, NO_DOMAINS, roomAt(0)],
  [RoomEvent.Redaction, NO_DOMAINS, roomAt(1)],
  [RoomEvent.RedactionCancelled, NO_DOMAINS, roomAt(1)],
  [RoomEvent.LocalEchoUpdated, NO_DOMAINS, roomAt(1)],
];

/**
 * The one internal owner of selected-Account client and listener lifecycle.
 *
 * Domain projectors receive stable Account/client pairs and never attach listeners. A shared
 * SDK event is registered once per Account and invalidates only the projections it affects.
 * `ClientEvent.Sync` invalidates every domain and then flushes the coalescing window, and a
 * decrypted event invalidates the rooms only when it can change a row. Events also mark the
 * rooms whose rows the next projection rebuilds ({@link AccountRows}).
 */
export class SelectedAccountSourceRegistry {
  private readonly sources = new Map<string, HeldAccountSource>();

  constructor(
    private readonly matrix: MatrixClientService,
    private readonly invalidate: (
      domains: ReadonlySet<SelectedProjectionDomain>,
    ) => void,
    private readonly flush: () => void,
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
      .map(({ accountId, client, encryption, rows }) => ({
        accountId,
        client,
        encryption,
        rows,
      }));
  }

  /**
   * Ask an Account's crypto store about its joined rooms whose state lacks the encryption
   * event, once per room; the batch's answers invalidate the room rows once.
   */
  learnEncryption(accountId: string, roomIds: readonly string[]): void {
    const source = this.sources.get(accountId);
    if (!source) return;
    const { client, encryption, rows } = source;
    const unanswered = roomIds.filter((id) => !encryption.answered(id));
    if (unanswered.length === 0) return;
    // Any answer can change the row: the lock, or a preview held back until now.
    const rebuild = () => {
      if (this.sources.get(accountId)?.encryption === encryption) {
        for (const roomId of unanswered) rows.mark(roomId);
        this.invalidate(ROOM_DOMAINS);
      }
    };
    void encryption
      .refreshAll(client.getCrypto?.(), unanswered, rebuild)
      .then((answered) => {
        if (answered > 0) rebuild();
      });
  }

  release(): void {
    for (const source of this.sources.values()) this.detach(source);
    this.sources.clear();
  }

  private attach(accountId: string, client: MatrixClient): HeldAccountSource {
    const eventSource = client as unknown as EventSource;
    let peers: { from: unknown; ids: ReadonlySet<string> } | undefined;
    const isDmPeer = (userId: string): boolean => {
      const from = client.getAccountData?.(EventType.Direct);
      if (!peers || peers.from !== from) {
        peers = { from, ids: new Set(directMapOf(client).userByRoom.values()) };
      }
      return peers.ids.has(userId);
    };
    const rows = new AccountRows();
    const listeners: RegisteredListener[] = [
      ...EVENTS.map(([event, domains, roomIdOf]) => ({
        event,
        handler: (...args: unknown[]) => {
          rows.mark(roomIdOf(args));
          if (domains.size > 0) this.invalidate(domains);
        },
      })),
      {
        event: ClientEvent.Sync,
        handler: () => {
          this.invalidate(ALL_DOMAINS);
          this.flush();
        },
      },
      {
        event: RoomStateEvent.Events,
        handler: (event?: MatrixEvent, state?: RoomState) => {
          const type = event?.getType?.();
          // An upgrade (tombstone, or the successor's create event) can change more than one row.
          rows.mark(
            type === EventType.RoomTombstone || type === EventType.RoomCreate
              ? undefined
              : (state?.roomId ?? event?.getRoomId?.()),
          );
        },
      },
      {
        // Only a DM peer's profile is on a row (its avatar), and it is every row's to rebuild;
        // a sync carries every other change.
        event: RoomStateEvent.Members,
        handler: (
          _event?: MatrixEvent,
          state?: RoomState,
          member?: RoomMember,
        ) => {
          if (member && isDmPeer(member.userId)) {
            rows.mark(undefined);
            this.invalidate(ROOM_DOMAINS);
          } else {
            rows.mark(state?.roomId);
          }
        },
      },
      {
        event: MatrixEventEvent.Decrypted,
        handler: (event) => {
          rows.mark(event?.getRoomId?.());
          if (event && decryptionChangesRow(client, event)) {
            this.invalidate(ROOM_DOMAINS);
          }
        },
      },
    ];
    for (const { event, handler } of listeners) eventSource.on(event, handler);
    return {
      accountId,
      client,
      encryption: new RoomEncryptionFlags(),
      rows,
      listeners,
    };
  }

  private detach(source: HeldAccountSource): void {
    const eventSource = source.client as unknown as EventSource;
    for (const { event, handler } of source.listeners) {
      eventSource.off(event, handler);
    }
  }
}

/**
 * Project and merge selected Accounts' joined, non-Space Rooms. Each Account rebuilds only the
 * rows its {@link AccountRows} marked or whose counts moved, or every row when its set of rooms
 * or sync state changed. A row that describes its room as `previous` did is that same object,
 * and an unchanged list is `previous` itself.
 */
export function projectSelectedRooms(
  sources: readonly AccountSource[],
  activeAccountId: string | null,
  learnEncryption?: (accountId: string, roomIds: readonly string[]) => void,
  previous: readonly RoomSummary[] = [],
): readonly RoomSummary[] {
  const byRoomId = new Map<string, RoomSummary>();

  for (const {
    accountId,
    client,
    encryption,
    rows: cache = new AccountRows(),
  } of sources) {
    const { userByRoom } = directMapOf(client);
    const hasCryptoStore = !!client.getCrypto?.();
    const syncState = client.getSyncState?.() ?? null;
    const joined = client
      .getRooms()
      .filter(
        (room) => !room.isSpaceRoom() && room.getMyMembership() === 'join',
      );
    const all =
      cache.all ||
      syncState !== cache.syncState ||
      joined.length !== cache.rows.size ||
      joined.some((room) => !cache.rows.has(room.roomId));
    const built = new Map<string, RoomSummary>();
    const stateless: string[] = [];
    for (const room of joined) {
      if (!room.hasEncryptionStateEvent()) stateless.push(room.roomId);

      const directUserId = userByRoom.get(room.roomId);
      const kept =
        all || cache.dirty.has(room.roomId)
          ? undefined
          : cache.rows.get(room.roomId);
      const summary =
        kept && kept.directUserId === directUserId && !sdkMovedRow(room, kept)
          ? kept
          : buildRoomSummary(
              room,
              accountId,
              directUserId,
              encryption,
              hasCryptoStore,
            );
      built.set(room.roomId, summary);
      const existing = byRoomId.get(room.roomId);
      if (!existing) {
        byRoomId.set(room.roomId, summary);
        continue;
      }

      // The row opens as, and shows the encryption view of, the active Account, else the first source.
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
    cache.rows = built;
    cache.dirty.clear();
    cache.all = false;
    cache.syncState = syncState;
    if (stateless.length > 0) learnEncryption?.(accountId, stateless);
  }

  const previousById = new Map(previous.map((room) => [room.id, room]));
  const merged = [...byRoomId.values()].map((room) =>
    reuseUnchanged(previousById.get(room.id), room),
  );
  // Every row kept: `previous` is already sorted.
  if (
    merged.length === previous.length &&
    merged.every((room) => previousById.get(room.id) === room)
  ) {
    return previous;
  }
  const rooms = merged.sort(compareRoomSummaries);
  return sameRooms(previous, rooms) ? previous : rooms;
}

export interface SelectedSpacesProjection {
  readonly spaces: readonly SpaceSummary[];
  readonly childRoomIdsByAccount: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Project selected Spaces, retaining both merged and per-Account child ownership. An unchanged
 * projection is `previous` itself.
 */
export function projectSelectedSpaces(
  sources: readonly AccountSource[],
  activeAccountId: string | null,
  previous?: SelectedSpacesProjection,
): SelectedSpacesProjection {
  const bySpaceId = new Map<string, SpaceSummary>();
  const childrenBySpace = new Map<string, Set<string>>();
  const childRoomIdsByAccount = new Map<string, Set<string>>();

  for (const { accountId, client } of sources) {
    const accountChildIds = new Set<string>();
    for (const room of client.getRooms()) {
      if (!isJoinedSpace(room)) continue;

      const mergedChildren =
        childrenBySpace.get(room.roomId) ?? new Set<string>();
      for (const childId of spaceChildIdsOf(client, room)) {
        accountChildIds.add(childId);
        mergedChildren.add(childId);
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
      childRoomIds: [...(childrenBySpace.get(space.id) ?? [])],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const unchanged =
    previous &&
    sameSpaces(previous.spaces, spaces) &&
    previous.childRoomIdsByAccount.size === childRoomIdsByAccount.size &&
    [...childRoomIdsByAccount].every(([accountId, ids]) => {
      const before = previous.childRoomIdsByAccount.get(accountId);
      return !!before && sameIds(before, ids);
    });
  return unchanged ? previous : { spaces, childRoomIdsByAccount };
}

/**
 * Project every selected Account's invitations without cross-Account deduplication. An
 * unchanged list is `previous` itself.
 */
export function projectSelectedInvitations(
  sources: readonly AccountSource[],
  previous: readonly PendingInvite[] = [],
): readonly PendingInvite[] {
  const invitations: PendingInvite[] = [];
  for (const { accountId, client } of sources) {
    for (const room of client.getRooms()) {
      if (room.getMyMembership() === 'invite') {
        invitations.push(buildInvite(client, room, accountId));
      }
    }
  }
  invitations.sort((a, b) => a.name.localeCompare(b.name));
  return sameInvites(previous, invitations) ? previous : invitations;
}
