import { Injectable, inject } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  describeMatrixRequestFailure,
  initialOf,
  liveRoomState,
  normalizeViaServers,
  type MatrixLinkTarget,
} from '@trinity/util/matrix';
import { EventType, type MatrixClient, type Room } from 'matrix-js-sdk';
import { ClientPrefix, Method } from 'matrix-js-sdk/lib/http-api';
import { Observable, defer, from, map, of, throwError } from 'rxjs';

export type RoomLinkMembership =
  'join' | 'invite' | 'knock' | 'ban' | 'leave' | 'unknown';

export type RoomLinkJoinRule =
  | 'public'
  | 'knock'
  | 'knock_restricted'
  | 'restricted'
  | 'invite'
  | 'private'
  | 'unknown';

export type RoomLinkAction = 'open' | 'accept' | 'join' | 'knock' | 'none';

/** Information safe to project into the room-link preview UI. */
export interface RoomLinkPreview {
  /** Account whose Matrix client resolved this preview and must perform its action. */
  readonly accountId: string;
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
    value === 'knock_restricted' ||
    value === 'restricted' ||
    value === 'invite' ||
    value === 'private'
    ? value
    : 'unknown';
}

function accountIdOf(client: MatrixClient): string {
  const accountId = client.getUserId();
  if (!accountId) throw new Error('Account unavailable.');
  return accountId;
}

/** Exhaustive action mapping: never offer a membership write that cannot be justified. */
export function roomLinkAction(
  membership: RoomLinkMembership,
  joinRule: RoomLinkJoinRule,
  restrictedEligible = false,
): RoomLinkAction {
  if (membership === 'join') return 'open';
  if (membership === 'invite') return 'accept';
  if (membership !== 'leave' && membership !== 'unknown') return 'none';
  if (
    joinRule === 'public' ||
    ((joinRule === 'restricted' || joinRule === 'knock_restricted') &&
      restrictedEligible)
  ) {
    return 'join';
  }
  if (joinRule === 'knock' || joinRule === 'knock_restricted') return 'knock';
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
        return of(this.fromLocal(client, local, target, localMembership));
      }

      return from(this.resolveRemote(client, target)).pipe(
        map(({ summary, resolvedTarget }) =>
          this.fromRemote(
            summary,
            resolvedTarget,
            local,
            localMembership,
            client,
          ),
        ),
      );
    });
  }

  /** Join only after the preview's explicit Join action is pressed. Cold. */
  join(preview: RoomLinkPreview): Observable<string> {
    return defer(() => {
      const client = this.matrix.clientFor(preview.accountId);
      if (!client) return throwError(() => new Error('Account unavailable.'));
      return from(
        client.joinRoom(
          preview.roomId,
          preview.via.length > 0 ? { viaServers: [...preview.via] } : undefined,
        ),
      ).pipe(map((room) => room.roomId));
    });
  }

  /** Request access only after the preview's explicit knock action is pressed. Cold. */
  knock(preview: RoomLinkPreview): Observable<void> {
    return defer(() => {
      const client = this.matrix.clientFor(preview.accountId);
      if (!client) return throwError(() => new Error('Account unavailable.'));
      return from(
        client.knockRoom(
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

  private async resolveRemote(
    client: MatrixClient,
    target: Extract<MatrixLinkTarget, { kind: 'room' }>,
  ): Promise<{
    summary: Record<string, unknown>;
    resolvedTarget: Extract<MatrixLinkTarget, { kind: 'room' }>;
  }> {
    let roomId = target.roomIdOrAlias;
    let via = normalizeViaServers(target.via ?? []);
    if (target.roomIdOrAlias.startsWith('#')) {
      const directory = await client.getRoomIdForAlias(target.roomIdOrAlias);
      roomId = directory.room_id;
      via = normalizeViaServers([...via, ...directory.servers]);
    }

    const resolvedTarget = {
      ...target,
      ...(via.length > 0 ? { via } : { via: undefined }),
    };
    return {
      summary: await this.roomSummary(client, roomId, via),
      resolvedTarget,
    };
  }

  private async roomSummary(
    client: MatrixClient,
    roomId: string,
    via: readonly string[],
  ): Promise<Record<string, unknown>> {
    try {
      return await client.http.authedRequest<Record<string, unknown>>(
        Method.Get,
        `/room_summary/${encodeURIComponent(roomId)}`,
        via.length > 0 ? { via: [...via] } : undefined,
        undefined,
        { prefix: ClientPrefix.V1 },
      );
    } catch (error: unknown) {
      // matrix-js-sdk currently exposes only the pre-standard MSC3266 helper.
      // Retain it for homeservers which have not implemented the stable endpoint.
      if (
        typeof error === 'object' &&
        error !== null &&
        'errcode' in error &&
        error.errcode === 'M_UNRECOGNIZED'
      ) {
        return (await client.getRoomSummary(roomId, [
          ...via,
        ])) as unknown as Record<string, unknown>;
      }
      throw error;
    }
  }

  private fromLocal(
    client: MatrixClient,
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
      accountId: accountIdOf(client),
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
    summary: Record<string, unknown>,
    target: Extract<MatrixLinkTarget, { kind: 'room' }>,
    local: Room | null,
    localMembership: RoomLinkMembership,
    client: MatrixClient,
  ): RoomLinkPreview {
    const raw = summary;
    const canonical =
      typeof raw['canonical_alias'] === 'string'
        ? raw['canonical_alias']
        : (local?.getCanonicalAlias() ?? null);
    const membership =
      localMembership !== 'unknown'
        ? localMembership
        : membershipOf(raw['membership']);
    // Per the stable endpoint, an omitted join_rule means public.
    const joinRule =
      raw['join_rule'] === undefined ? 'public' : joinRuleOf(raw['join_rule']);
    const allowedRoomIds = Array.isArray(raw['allowed_room_ids'])
      ? raw['allowed_room_ids'].filter(
          (value): value is string =>
            typeof value === 'string' && value.startsWith('!'),
        )
      : [];
    const restrictedEligible = allowedRoomIds.some(
      (roomId) =>
        membershipOf(client.getRoom(roomId)?.getMyMembership()) === 'join',
    );
    const encryption = raw['encryption'] ?? raw['im.nheko.summary.encryption'];
    const roomId =
      typeof raw['room_id'] === 'string'
        ? raw['room_id']
        : target.roomIdOrAlias;
    const name = typeof raw['name'] === 'string' ? raw['name'] : null;
    const topic = typeof raw['topic'] === 'string' ? raw['topic'] : null;
    const avatarMxc =
      typeof raw['avatar_url'] === 'string' ? raw['avatar_url'] : null;
    const memberCount = raw['num_joined_members'];
    return this.build({
      accountId: accountIdOf(client),
      roomId,
      target,
      canonicalAddress: canonical,
      name: name || canonical || roomId,
      topic,
      avatarMxc,
      memberCount:
        typeof memberCount === 'number' && Number.isFinite(memberCount)
          ? memberCount
          : null,
      encrypted:
        typeof encryption === 'string'
          ? true
          : local
            ? local.hasEncryptionStateEvent()
            : null,
      joinRule,
      membership,
      isSpace: raw['room_type'] === 'm.space',
      restrictedEligible,
    });
  }

  private build(values: {
    accountId: string;
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
    restrictedEligible?: boolean;
  }): RoomLinkPreview {
    return {
      accountId: values.accountId,
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
      action: roomLinkAction(
        values.membership,
        values.joinRule,
        values.restrictedEligible,
      ),
      isSpace: values.isSpace,
      via: values.target.via ?? [],
    };
  }
}
