import {
  BehaviorSubject,
  type Observable,
  Subject,
  defer,
  distinctUntilChanged,
  filter,
  map,
  merge,
  of,
  startWith,
} from 'rxjs';
import {
  type EngineFailure,
  type EngineFailureCode,
  type EngineResult,
  type VectorDiff,
  applyVectorDiffs,
  engineFail,
  engineOk,
  plainEqual,
} from '@trinity/util/matrix';
import type {
  CreateRoomRequest,
  HierarchyEntry,
  InviteBlocking,
  RoomInfo,
  RoomListEngine,
  SpaceChildLink,
  TypingMember,
} from '../lib/room-list-engine';
import { compareOrder, isValidOrder } from '../lib/space-child-order';

type FailNextCode = Exclude<
  EngineFailureCode,
  'discovery-failed' | 'account-start-failed' | 'recovery-refused'
>;
type PerAccount<T> = Readonly<Record<string, Readonly<Record<string, T>>>>;

function failure(code: FailNextCode): EngineFailure {
  // Cast: assigning a union-typed code is checked only up to 25 union members.
  return {
    kind: 'unexpected',
    code,
    diagnostic: { kind: 'unexpected' },
  } as EngineFailure;
}

const REQUEST_FAILED = failure('request-failed');

/** A joined, unnamed-looking room with every count at zero; `patch` overrides any field. */
export function fakeRoom(
  roomId: string,
  patch: Partial<RoomInfo> = {},
): RoomInfo {
  return {
    roomId,
    membership: 'join',
    isSpace: false,
    displayName: roomId,
    avatarMxc: null,
    topic: '',
    joinedMemberCount: 1,
    directUserId: null,
    encryption: 'unencrypted',
    historyVisibility: 'shared',
    notificationCount: 0,
    highlightCount: 0,
    markedUnread: false,
    recencyStamp: 0,
    latestMessage: null,
    favourite: false,
    lowPriority: false,
    inviter: null,
    ...patch,
  };
}

/** In-memory room lists for `alice` (live) and `bob` (driven through `asBob`), emitting synchronously. */
export class FakeRoomListEngine implements RoomListEngine {
  private readonly lists = new Map<string, readonly RoomInfo[]>();
  private readonly changes$ = new Subject<{
    readonly accountId: string;
    readonly diffs: readonly VectorDiff<RoomInfo>[];
  }>();
  private readonly typing$ = new BehaviorSubject<
    PerAccount<readonly TypingMember[]>
  >({});
  private readonly direct$ = new BehaviorSubject<PerAccount<readonly string[]>>(
    {},
  );
  private readonly inviteBlocks$ = new BehaviorSubject<
    Readonly<Record<string, boolean>>
  >({});
  private readonly roomNames = new Map<string, string>();
  private readonly aliases = new Map<string, string>();
  private readonly userNames = new Map<string, string>();
  private readonly spaces = new Set<string>();
  /** Child links by space, then by child: shared server state, as are the parents. */
  private readonly links = new Map<string, Map<string, SpaceChildLink>>();
  private readonly parents = new Map<string, readonly string[]>();
  private readonly linksChanged$ = new Subject<string>();
  /** Who else is joined to each room, for `roomsInCommon`; each account's own list decides for it. */
  private readonly joined = new Map<string, ReadonlySet<string>>();
  private readonly joinedChanged$ = new Subject<void>();
  private nextRoom = 0;
  private nextFailure: FailNextCode | null = null;

  readonly serverName = 'example.org';
  readonly alice = `@alice:${this.serverName}`;
  readonly bob = `@bob:${this.serverName}`;
  /** Whether the fake server advertises MSC4380 invite blocking; read on subscribe and write. */
  serverBlocksInvites = true;

  /** Acts on the fake's state as `bob` would on a server. */
  readonly asBob = {
    createRoom: async (name: string): Promise<string> =>
      this.newRoom(name, this.bob),
    createPublicRoom: async (
      name: string,
      localpart: string,
    ): Promise<{ readonly roomId: string; readonly alias: string }> => {
      const roomId = this.newRoom(name, this.bob);
      return { roomId, alias: this.publishAlias(roomId, localpart) };
    },
    join: async (roomId: string): Promise<void> =>
      this.setJoined(roomId, this.bob, true),
    invite: async (
      roomId: string,
      userId: string,
      options: { readonly isDirect?: boolean } = {},
    ): Promise<void> => {
      this.deliverInvite(this.bob, roomId, userId, options.isDirect ?? false);
    },
    sendTyping: async (roomId: string): Promise<void> => {
      for (const [accountId, rooms] of this.lists) {
        if (!rooms.some((r) => r.roomId === roomId)) continue;
        const others = (this.typing$.value[accountId]?.[roomId] ?? []).filter(
          (m) => m.userId !== this.bob,
        );
        this.setTyping(accountId, roomId, [
          ...others,
          { userId: this.bob, displayName: this.displayName(this.bob) },
        ]);
      }
    },
    sendMessage: async (roomId: string, body: string): Promise<void> => {
      for (const accountId of this.lists.keys()) {
        const index = this.indexOf(accountId, roomId);
        const room = this.lists.get(accountId)?.[index];
        if (!room) continue;
        this.apply(accountId, [
          {
            op: 'set',
            index,
            value: {
              ...room,
              notificationCount: room.notificationCount + 1,
              recencyStamp: room.recencyStamp + 1,
              latestMessage: { text: body, mark: null },
            },
          },
        ]);
      }
    },
  };

  constructor() {
    this.userNames.set(this.alice, 'Alice');
    this.userNames.set(this.bob, 'Bob');
    this.lists.set(this.alice, []);
  }

  /** Makes `accountId` live with exactly `rooms`. */
  seed(accountId: string, rooms: readonly RoomInfo[]): void {
    if (!this.userNames.has(accountId))
      this.userNames.set(accountId, accountId);
    for (const room of rooms) {
      this.roomNames.set(room.roomId, room.displayName);
      if (room.isSpace) this.spaces.add(room.roomId);
    }
    this.lists.set(accountId, rooms);
    this.changes$.next({ accountId, diffs: [{ op: 'reset', values: rooms }] });
  }

  setTyping(
    accountId: string,
    roomId: string,
    members: readonly TypingMember[],
  ): void {
    const current = this.typing$.value;
    this.typing$.next({
      ...current,
      [accountId]: { ...current[accountId], [roomId]: members },
    });
  }

  failNext(code: FailNextCode): void {
    this.nextFailure = code;
  }

  publishAlias(roomId: string, localpart: string): string {
    const alias = `#${localpart}:${this.serverName}`;
    this.aliases.set(alias, roomId);
    return alias;
  }

  /** Whether `userId` is joined to `roomId` on the server, as `roomsInCommon` reads it. */
  setJoined(roomId: string, userId: string, joined: boolean): void {
    const members = new Set(this.joined.get(roomId));
    if (joined) members.add(userId);
    else members.delete(userId);
    this.joined.set(roomId, members);
    this.joinedChanged$.next();
  }

  /** The spaces `setSpaceParent` or a create with a parent recorded for the room. */
  spaceParents(roomId: string): readonly string[] {
    return this.parents.get(roomId) ?? [];
  }

  /** Alice accepts an invite: the row becomes joined. */
  acceptInvite(roomId: string): void {
    const index = this.indexOf(this.alice, roomId);
    const room = this.lists.get(this.alice)?.[index];
    if (room?.membership !== 'invite') return;
    this.apply(this.alice, [
      {
        op: 'set',
        index,
        value: { ...room, membership: 'join', inviter: null },
      },
    ]);
  }

  rooms(accountId: string): Observable<readonly VectorDiff<RoomInfo>[]> {
    return defer(() =>
      this.changes$.pipe(
        filter((change) => change.accountId === accountId),
        map((change) => change.diffs),
        startWith([
          { op: 'reset', values: this.lists.get(accountId) ?? [] },
        ] satisfies VectorDiff<RoomInfo>[]),
      ),
    );
  }

  typing(
    accountId: string,
  ): Observable<Readonly<Record<string, readonly TypingMember[]>>> {
    return this.typing$.pipe(
      map((all) => all[accountId] ?? {}),
      distinctUntilChanged<Readonly<Record<string, readonly TypingMember[]>>>(
        plainEqual,
      ),
    );
  }

  directMap(
    accountId: string,
  ): Observable<Readonly<Record<string, readonly string[]>>> {
    return this.direct$.pipe(
      map((all) => all[accountId] ?? {}),
      distinctUntilChanged<Readonly<Record<string, readonly string[]>>>(
        plainEqual,
      ),
    );
  }

  setTag(
    accountId: string,
    roomId: string,
    tag: 'favourite' | 'lowPriority',
    on: boolean,
  ): Observable<EngineResult<null>> {
    return this.patchCommand(accountId, roomId, { [tag]: on });
  }

  setMarkedUnread(
    accountId: string,
    roomId: string,
    unread: boolean,
  ): Observable<EngineResult<null>> {
    return this.patchCommand(accountId, roomId, {
      markedUnread: unread,
    });
  }

  markRead(
    accountId: string,
    roomId: string,
    _receipts: 'public' | 'private',
  ): Observable<EngineResult<null>> {
    return this.patchCommand(accountId, roomId, {
      notificationCount: 0,
      highlightCount: 0,
      markedUnread: false,
    });
  }

  leave(accountId: string, roomId: string): Observable<EngineResult<null>> {
    return this.run(accountId, () => {
      const index = this.indexOf(accountId, roomId);
      if (index < 0) return engineFail(REQUEST_FAILED);
      this.apply(accountId, [{ op: 'remove', index }]);
      return engineOk(null);
    });
  }

  createRoom(
    accountId: string,
    request: CreateRoomRequest,
  ): Observable<EngineResult<{ readonly roomId: string }>> {
    return this.run(accountId, () => {
      const roomId = this.newRoom(request.name, accountId);
      if (request.kind === 'space') this.spaces.add(roomId);
      this.apply(accountId, [
        {
          op: 'pushBack',
          value: fakeRoom(roomId, {
            displayName: request.name,
            topic: request.topic ?? '',
            isSpace: request.kind === 'space',
          }),
        },
      ]);
      if (request.parentSpaceId) {
        const via = [this.serverName];
        this.writeLink(request.parentSpaceId, roomId, {
          via,
          suggested: true,
          order: '',
        });
        this.addParent(roomId, request.parentSpaceId);
      }
      return engineOk({ roomId });
    });
  }

  createDirectMessage(
    accountId: string,
    userId: string,
  ): Observable<EngineResult<{ readonly roomId: string }>> {
    return this.run(accountId, () => {
      if (!this.userNames.has(userId)) return engineFail(REQUEST_FAILED);
      const joined = this.lists
        .get(accountId)
        ?.find((r) => r.directUserId === userId && r.membership === 'join');
      if (joined) return engineOk({ roomId: joined.roomId });
      const name = this.displayName(userId);
      const roomId = this.newRoom(name, accountId);
      this.apply(accountId, [
        {
          op: 'pushBack',
          value: fakeRoom(roomId, { displayName: name, directUserId: userId }),
        },
      ]);
      const current = this.direct$.value;
      const own = current[accountId] ?? {};
      this.direct$.next({
        ...current,
        [accountId]: { ...own, [userId]: [...(own[userId] ?? []), roomId] },
      });
      this.deliverInvite(accountId, roomId, userId, true);
      return engineOk({ roomId });
    });
  }

  resolveAlias(
    accountId: string,
    alias: string,
  ): Observable<EngineResult<{ readonly roomId: string }>> {
    return this.run(accountId, () => {
      const roomId = this.aliases.get(alias);
      return roomId ? engineOk({ roomId }) : engineFail(REQUEST_FAILED);
    });
  }

  invite(
    accountId: string,
    roomId: string,
    userId: string,
  ): Observable<EngineResult<null>> {
    return this.run(accountId, () => {
      if (this.indexOf(accountId, roomId) < 0 || !this.userNames.has(userId)) {
        return engineFail(REQUEST_FAILED);
      }
      this.deliverInvite(accountId, roomId, userId, false);
      return engineOk(null);
    });
  }

  join(
    accountId: string,
    roomIdOrAlias: string,
    _via: readonly string[],
  ): Observable<EngineResult<{ readonly roomId: string }>> {
    return this.run(accountId, () => {
      const roomId = this.aliases.get(roomIdOrAlias) ?? roomIdOrAlias;
      if (!this.roomNames.has(roomId)) return engineFail(REQUEST_FAILED);
      const index = this.indexOf(accountId, roomId);
      const room = this.lists.get(accountId)?.[index];
      if (!room) {
        this.apply(accountId, [
          {
            op: 'pushBack',
            value: fakeRoom(roomId, {
              displayName: this.roomNames.get(roomId),
              isSpace: this.spaces.has(roomId),
            }),
          },
        ]);
      } else if (room.membership !== 'join') {
        this.apply(accountId, [
          {
            op: 'set',
            index,
            value: { ...room, membership: 'join', inviter: null },
          },
        ]);
      }
      return engineOk({ roomId });
    });
  }

  spaceChildLinks(
    accountId: string,
    spaceId: string,
  ): Observable<readonly SpaceChildLink[]> {
    return defer(() =>
      merge(
        this.linksChanged$.pipe(filter((changed) => changed === spaceId)),
        // The space can be listed for the account after the subscription opened.
        this.changes$.pipe(filter((change) => change.accountId === accountId)),
      ).pipe(
        startWith(null),
        map(() =>
          this.lists.get(accountId)?.some((r) => r.roomId === spaceId)
            ? this.liveLinks(spaceId)
            : [],
        ),
        distinctUntilChanged<readonly SpaceChildLink[]>(plainEqual),
      ),
    );
  }

  spaceHierarchy(
    accountId: string,
    spaceId: string,
    _options: { readonly maxPages: number | null },
  ): Observable<EngineResult<readonly HierarchyEntry[]>> {
    return this.run(accountId, () => {
      if (!this.spaces.has(spaceId)) return engineFail(REQUEST_FAILED);
      const children = [...(this.links.get(spaceId)?.values() ?? [])];
      return engineOk([
        this.hierarchyEntry(spaceId, children),
        ...this.liveLinks(spaceId).map((link) =>
          this.hierarchyEntry(link.childId, []),
        ),
      ]);
    });
  }

  setSpaceChild(
    accountId: string,
    spaceId: string,
    childId: string,
    link: Omit<SpaceChildLink, 'childId'> | null,
  ): Observable<EngineResult<null>> {
    return this.run(accountId, () => {
      if (!this.spaces.has(spaceId)) return engineFail(REQUEST_FAILED);
      this.writeLink(spaceId, childId, link);
      return engineOk(null);
    });
  }

  setSpaceParent(
    accountId: string,
    childId: string,
    spaceId: string,
    _via: readonly string[],
  ): Observable<EngineResult<null>> {
    return this.run(accountId, () => {
      if (!this.roomNames.has(childId)) return engineFail(REQUEST_FAILED);
      this.addParent(childId, spaceId);
      return engineOk(null);
    });
  }

  inviteBlocking(accountId: string): Observable<InviteBlocking> {
    return defer(() => {
      const supported = this.serverBlocksInvites && this.lists.has(accountId);
      return this.inviteBlocks$.pipe(
        map((all) => ({
          supported,
          blocked: supported && (all[accountId] ?? false),
        })),
        distinctUntilChanged<InviteBlocking>(plainEqual),
      );
    });
  }

  setInviteBlocking(
    accountId: string,
    blocked: boolean,
  ): Observable<EngineResult<null>> {
    return this.run(accountId, () => {
      if (!this.serverBlocksInvites) return engineFail(REQUEST_FAILED);
      this.inviteBlocks$.next({
        ...this.inviteBlocks$.value,
        [accountId]: blocked,
      });
      return engineOk(null);
    });
  }

  roomsInCommon(
    accountId: string,
    userId: string,
  ): Observable<readonly string[]> {
    return merge(
      this.joinedChanged$,
      this.changes$.pipe(filter((change) => change.accountId === accountId)),
    ).pipe(
      startWith(null),
      map(() =>
        (this.lists.get(accountId) ?? [])
          .filter(
            (r) =>
              r.membership === 'join' &&
              (this.joined.get(r.roomId)?.has(userId) ?? false),
          )
          .map((r) => r.roomId),
      ),
      distinctUntilChanged<readonly string[]>(plainEqual),
    );
  }

  /** A cold command: scripted failure first, then the live-account check, then `action`. */
  private run<T>(
    accountId: string,
    action: () => EngineResult<T>,
  ): Observable<EngineResult<T>> {
    return defer(() => {
      const scripted = this.nextFailure;
      this.nextFailure = null;
      if (scripted) return of(engineFail(failure(scripted)));
      if (!this.lists.has(accountId)) {
        return of(engineFail(failure('account-not-live')));
      }
      return of(action());
    });
  }

  private patchCommand(
    accountId: string,
    roomId: string,
    patch: Partial<RoomInfo>,
  ): Observable<EngineResult<null>> {
    return this.run(accountId, () => {
      const index = this.indexOf(accountId, roomId);
      const room = this.lists.get(accountId)?.[index];
      if (!room) return engineFail(REQUEST_FAILED);
      this.apply(accountId, [
        { op: 'set', index, value: { ...room, ...patch } },
      ]);
      return engineOk(null);
    });
  }

  /** The links `spaceChildLinks` lists: none with an empty `via`, in spec order. */
  private liveLinks(spaceId: string): readonly SpaceChildLink[] {
    return [...(this.links.get(spaceId)?.values() ?? [])]
      .filter((link) => link.via.length > 0)
      .map((link) => (isValidOrder(link.order) ? link : { ...link, order: '' }))
      .sort(
        (a, b) =>
          compareOrder(a.order, b.order) || (a.childId < b.childId ? -1 : 1),
      );
  }

  private writeLink(
    spaceId: string,
    childId: string,
    link: Omit<SpaceChildLink, 'childId'> | null,
  ): void {
    const links = this.links.get(spaceId) ?? new Map();
    // The empty content Matrix uses for a removed child.
    links.set(childId, {
      childId,
      via: [],
      suggested: false,
      order: '',
      ...link,
    });
    this.links.set(spaceId, links);
    this.linksChanged$.next(spaceId);
  }

  private addParent(childId: string, spaceId: string): void {
    const parents = this.spaceParents(childId).filter((id) => id !== spaceId);
    this.parents.set(childId, [...parents, spaceId]);
  }

  private hierarchyEntry(
    roomId: string,
    childrenState: readonly SpaceChildLink[],
  ): HierarchyEntry {
    return {
      roomId,
      name: this.roomNames.get(roomId) ?? null,
      canonicalAlias: null,
      topic: null,
      avatarMxc: null,
      joinedMemberCount: 1,
      joinRule: 'invite',
      isSpace: this.spaces.has(roomId),
      childrenState,
    };
  }

  private indexOf(accountId: string, roomId: string): number {
    return (
      this.lists.get(accountId)?.findIndex((r) => r.roomId === roomId) ?? -1
    );
  }

  private apply(
    accountId: string,
    diffs: readonly VectorDiff<RoomInfo>[],
  ): void {
    this.lists.set(
      accountId,
      applyVectorDiffs(this.lists.get(accountId) ?? [], diffs),
    );
    this.changes$.next({ accountId, diffs });
  }

  private newRoom(name: string, creator: string): string {
    this.nextRoom += 1;
    const roomId = `!fake-${this.nextRoom}:${this.serverName}`;
    this.roomNames.set(roomId, name);
    this.joined.set(roomId, new Set([creator]));
    return roomId;
  }

  private deliverInvite(
    from: string,
    roomId: string,
    to: string,
    isDirect: boolean,
  ): void {
    if (!this.lists.has(to) || this.indexOf(to, roomId) >= 0) return;
    this.apply(to, [
      {
        op: 'pushBack',
        value: fakeRoom(roomId, {
          membership: 'invite',
          displayName: this.roomNames.get(roomId) ?? roomId,
          inviter: {
            userId: from,
            displayName: this.displayName(from),
            isDirect,
          },
        }),
      },
    ]);
  }

  private displayName(userId: string): string {
    return this.userNames.get(userId) ?? userId;
  }
}
