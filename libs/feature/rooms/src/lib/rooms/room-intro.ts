import type { TimelineLoadState } from '@trinity/data-access/timeline';

/** What the empty-room Invite prompt depends on, read from the open room. */
export interface RoomIntroState {
  readonly hasRoom: boolean;
  readonly direct: boolean;
  readonly canInvite: boolean;
  readonly loadState: TimelineLoadState;
  /** Joined members with current authority; null while only stale or no data is known. */
  readonly joinedMembers: number | null;
  readonly messages: readonly { readonly systemCategory?: string | null }[];
}

/**
 * A room you are alone in, with nothing said yet, gets an Invite prompt. Anything said,
 * anyone else joining, or losing the right to invite hides it.
 * Not gated on `canLoadOlder`: the backward token is non-null even in a brand-new room (Synapse
 * always sends prev_batch), so it cannot tell "start of history" from "more above".
 */
export function showRoomIntro(state: RoomIntroState): boolean {
  const settled =
    state.loadState.kind === 'ready' || state.loadState.kind === 'empty';
  return (
    state.hasRoom &&
    !state.direct &&
    state.canInvite &&
    settled &&
    state.joinedMembers === 1 &&
    state.messages.every((message) => message.systemCategory != null)
  );
}
