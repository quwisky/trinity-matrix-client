import { pendingInviteOf, type PendingInvite } from './invites.service';
import { type RoomSummary } from './room-library.service';
import type { RoomInfo, SpaceChildLink } from './room-list-engine';
import {
  compareRoomSummaries,
  initialOf,
  roomSummaryOf,
} from './room-projection';
import { joinedChildIds } from './space-link-feeds';
import { type SpaceSummary } from './spaces.service';

/** One selected, live Account generation and its room list. */
export interface AccountSource {
  readonly accountId: string;
  readonly generation: number;
  readonly rows: readonly RoomInfo[];
}

/** Project and merge selected Accounts' joined, non-Space Rooms. */
export function projectSelectedRooms(
  sources: readonly AccountSource[],
  activeAccountId: string | null,
): readonly RoomSummary[] {
  const byRoomId = new Map<string, RoomSummary>();

  for (const { accountId, rows } of sources) {
    for (const info of rows) {
      if (info.isSpace || info.membership !== 'join') continue;

      const summary = roomSummaryOf(accountId, info);
      const existing = byRoomId.get(info.roomId);
      if (!existing) {
        byRoomId.set(info.roomId, summary);
        continue;
      }

      // The row opens as, and shows the encryption view of, the active Account, else the first source.
      const winner =
        accountId === activeAccountId && existing.accountId !== activeAccountId
          ? summary
          : existing;
      byRoomId.set(info.roomId, {
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
  /** Each source's joined space children, in source order. */
  readonly childRoomIdsByAccount: readonly (readonly [
    string,
    readonly string[],
  ])[];
}

/** Project selected Spaces, retaining both merged and per-Account child ownership. */
export function projectSelectedSpaces(
  sources: readonly AccountSource[],
  activeAccountId: string | null,
  linksOf: (
    source: AccountSource,
    spaceId: string,
  ) => readonly SpaceChildLink[],
): SelectedSpacesProjection {
  const bySpaceId = new Map<string, SpaceSummary>();
  const childrenBySpace = new Map<string, string[]>();
  const childRoomIdsByAccount: (readonly [string, readonly string[]])[] = [];

  for (const source of sources) {
    const { accountId, rows } = source;
    const joined = new Map(
      rows.filter((r) => r.membership === 'join').map((r) => [r.roomId, r]),
    );
    const accountChildIds = new Set<string>();
    for (const space of joined.values()) {
      if (!space.isSpace) continue;

      const mergedChildren = childrenBySpace.get(space.roomId) ?? [];
      for (const childId of joinedChildIds(
        linksOf(source, space.roomId),
        joined,
      )) {
        accountChildIds.add(childId);
        if (!mergedChildren.includes(childId)) mergedChildren.push(childId);
      }
      childrenBySpace.set(space.roomId, mergedChildren);

      const existing = bySpaceId.get(space.roomId);
      if (
        existing &&
        !(
          accountId === activeAccountId &&
          existing.accountId !== activeAccountId
        )
      ) {
        continue;
      }
      bySpaceId.set(space.roomId, {
        id: space.roomId,
        accountId,
        name: space.displayName,
        initial: initialOf(space.displayName),
        avatarMxc: space.avatarMxc,
        childRoomIds: [],
      });
    }
    childRoomIdsByAccount.push([accountId, [...accountChildIds]]);
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
  return sources
    .flatMap(({ accountId, rows }) =>
      rows
        .filter((info) => info.membership === 'invite')
        .map((info) => pendingInviteOf(accountId, info)),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}
