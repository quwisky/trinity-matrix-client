import { Injectable, inject } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  describeMatrixRequestFailure,
  initialOf,
  liveRoomState,
  type MatrixLinkTarget,
} from '@trinity/util/matrix';
import {
  EventType,
  type MatrixClient,
  type Room,
  type RoomSummary as SdkRoomSummary,
} from 'matrix-js-sdk';
import { Observable, defer, from, map, of, throwError } from 'rxjs';

export type RoomLinkMembership =
  'join' | 'invite' | 'knock' | 'ban' | 'leave' | 'unknown';

export type RoomLinkJoinRule =
  'public' | 'knock' | 'restricted' | 'invite' | 'private' | 'unknown';

export type RoomLinkAction = 'open' | 'accept' | 'join' | 'knock' | 'none';

/** Information safe to project into the room-link preview UI. */
export interface RoomLinkPreview {
  readonly roomId: string;
  readonly requestedAddress: string | null;
  readonly canonicalAddress: string | null;
  readonly name: string;
  readonly initial: string;
  readonly topic: string | null;
  readonly avatarMxc: string | null;
  readonly memberCount: number | null;
  readonly encrypted: boolean | null;
  readonly joinRule: RoomLinkJoinRule;
  readonly membership: RoomLinkMembership;
  readonly action: RoomLinkAction;
  readonly isSpace: boolean;
  readonly via: readonly string[];
}

/** Error state shown by a failed room preview. */
export interface RoomLinkPreviewFailure {
  readonly title: string;
  readonly message: string;
  readonly retryable: boolean;
}

function membershipOf(value: unknown): RoomLinkMembership {
  return value === 'join' ||
    value === 'invite' ||
    value === 'knock' ||
    value === 'ban' ||
    value === 'leave'
    ? value
    : 'unknown';
}

function joinRuleOf(value: unknown): RoomLinkJoinRule {
  return value === 'public' ||
    value === 'knock' ||
    value === 'restricted' ||
    value === 'invite' ||
    value === 'private'
    ? value
    : 'unknown';
}

/** Exhaustive action mapping: never offer a membership write that cannot be justified. */
export function roomLinkAction(
  membership: RoomLinkMembership,
  joinRule: RoomLinkJoinRule,
): RoomLinkAction {
  if (membership === 'join') return 'open';
  if (membership === 'invite') return 'accept';
  if (membership !== 'leave' && membership !== 'unknown') return 'none';
  if (joinRule === 'public') return 'join';
  if (joinRule === 'knock') return 'knock';
  return 'none';
}

/** Map request failures to room-specific, privacy-safe copy. */
export function describeRoomLinkPreviewFailure(
  error: unknown,
): RoomLinkPreviewFailure {
  const failure = describeMatrixRequestFailure(
    error,
    'This room could not be previewed. Try again.',
  );
  if (failure.diagnostic.httpStatus === 404) {
    return {
      title: 'Room not found',
      message: 'This room address is unknown or no longer exists.',
      retryable: false,
    };
  }
  if (failure.kind === 'permission') {
    return {
      title: 'Room unavailable',
      message: 'This room does not allow its information to be previewed.',
      retryable: false,
    };
  }
  if (failure.kind === 'network' || failure.kind === 'timeout') {
    return {
      title: 'Could not connect',
      message: failure.message,
      retryable: true,
    };
  }
  if (failure.kind === 'server' || failure.kind === 'rate-limit') {
    return {
      title: 'Homeserver unavailable',
      message: failure.message,
      retryable: true,
    };
  }
  return {
    title: 'Could not preview room',
    message: failure.message,
    retryable: true,
  };
}

/**
 * Resolves room links into preview data and performs the explicit membership actions.
 * Every network action is cold. Synced joined/invited/knocked/banned rooms are projected
 * locally first so a homeserver without the unstable summary endpoint cannot regress links
 * to rooms the client already knows.
 */
@Injectable({ providedIn: 'root' })
export class RoomLinkService {
  private readonly matrix = inject(MatrixClientService);

  preview(
    target: Extract<MatrixLinkTarget, { kind: 'room' }>,
  ): Observable<RoomLinkPreview> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      const client = this.matrix.instance;
      const local = this.localRoom(client, target.roomIdOrAlias);
      const localMembership = membershipOf(local?.getMyMembership());
      if (
        local &&
        (localMembership === 'join' ||
          localMembership === 'invite' ||
          localMembership === 'knock' ||
          localMembership === 'ban')
      ) {
        return of(this.fromLocal(local, target, localMembership));
      }

      return from(
        client.getRoomSummary(target.roomIdOrAlias, [...(target.via ?? [])]),
      ).pipe(
        map((summary) =>
          this.fromRemote(summary, target, local, localMembership),
        ),
      );
    });
  }

  /** Join only after the preview's explicit Join action is pressed. Cold. */
  join(preview: RoomLinkPreview): Observable<string> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(
        this.matrix.instance.joinRoom(
          preview.roomId,
          preview.via.length > 0 ? { viaServers: [...preview.via] } : undefined,
        ),
      ).pipe(map((room) => room.roomId));
    });
  }

  /** Request access only after the preview's explicit knock action is pressed. Cold. */
  knock(preview: RoomLinkPreview): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(
        this.matrix.instance.knockRoom(
          preview.roomId,
          preview.via.length > 0 ? { viaServers: [...preview.via] } : undefined,
        ),
      ).pipe(map(() => void 0));
    });
  }

  private localRoom(client: MatrixClient, roomIdOrAlias: string): Room | null {
    if (roomIdOrAlias.startsWith('!')) {
      return client.getRoom(roomIdOrAlias);
    }
    return (
      client
        .getRooms()
        .find(
          (room) =>
            room.getCanonicalAlias() === roomIdOrAlias ||
            room.getAltAliases().includes(roomIdOrAlias),
        ) ?? null
    );
  }

  private fromLocal(
    room: Room,
    target: Extract<MatrixLinkTarget, { kind: 'room' }>,
    membership: RoomLinkMembership,
  ): RoomLinkPreview {
    const state = liveRoomState(room);
    const topic = state
      ?.getStateEvents(EventType.RoomTopic, '')
      ?.getContent()?.['topic'];
    const joinRule = joinRuleOf(
      state?.getStateEvents(EventType.RoomJoinRules, '')?.getContent()?.[
        'join_rule'
      ],
    );
    return this.build({
      roomId: room.roomId,
      target,
      canonicalAddress: room.getCanonicalAlias(),
      name: room.name || room.getCanonicalAlias() || room.roomId,
      topic: typeof topic === 'string' && topic ? topic : null,
      avatarMxc: room.getMxcAvatarUrl(),
      memberCount: room.getJoinedMemberCount(),
      encrypted: room.hasEncryptionStateEvent(),
      joinRule,
      membership,
      isSpace: room.isSpaceRoom(),
    });
  }

  private fromRemote(
    summary: SdkRoomSummary,
    target: Extract<MatrixLinkTarget, { kind: 'room' }>,
    local: Room | null,
    localMembership: RoomLinkMembership,
  ): RoomLinkPreview {
    // Synapse returns canonical_alias even though matrix-js-sdk's unstable summary type
    // omits it. Read it defensively; an alias used to reach the room is not necessarily
    // canonical and remains `requestedAddress` instead.
    const raw = summary as SdkRoomSummary & Record<string, unknown>;
    const canonical =
      typeof raw['canonical_alias'] === 'string'
        ? raw['canonical_alias']
        : (local?.getCanonicalAlias() ?? null);
    const membership =
      localMembership !== 'unknown'
        ? localMembership
        : membershipOf(raw['membership']);
    const joinRule = joinRuleOf(raw['join_rule']);
    const encryption = raw['im.nheko.summary.encryption'];
    return this.build({
      roomId: summary.room_id,
      target,
      canonicalAddress: canonical,
      name: summary.name || canonical || summary.room_id,
      topic: summary.topic || null,
      avatarMxc: summary.avatar_url ?? null,
      memberCount: Number.isFinite(summary.num_joined_members)
        ? summary.num_joined_members
        : null,
      encrypted:
        typeof encryption === 'string'
          ? true
          : local
            ? local.hasEncryptionStateEvent()
            : null,
      joinRule,
      membership,
      isSpace: summary.room_type === 'm.space',
    });
  }

  private build(values: {
    roomId: string;
    target: Extract<MatrixLinkTarget, { kind: 'room' }>;
    canonicalAddress: string | null;
    name: string;
    topic: string | null;
    avatarMxc: string | null;
    memberCount: number | null;
    encrypted: boolean | null;
    joinRule: RoomLinkJoinRule;
    membership: RoomLinkMembership;
    isSpace: boolean;
  }): RoomLinkPreview {
    return {
      roomId: values.roomId,
      requestedAddress: values.target.roomIdOrAlias.startsWith('#')
        ? values.target.roomIdOrAlias
        : null,
      canonicalAddress: values.canonicalAddress,
      name: values.name,
      initial: initialOf(values.name),
      topic: values.topic,
      avatarMxc: values.avatarMxc,
      memberCount: values.memberCount,
      encrypted: values.encrypted,
      joinRule: values.joinRule,
      membership: values.membership,
      action: roomLinkAction(values.membership, values.joinRule),
      isSpace: values.isSpace,
      via: values.target.via ?? [],
    };
  }
}
