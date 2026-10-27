import { EventType, type MatrixClient, type Room } from 'matrix-js-sdk';
import { ClientPrefix, Method } from 'matrix-js-sdk/lib/http-api';
import {
  isRoomEncrypted,
  liveRoomState,
  normalizeViaServers,
} from '@trinity/util/matrix';
import type {
  RoomLinkJoinRule,
  RoomLinkMembership,
  RoomLinkPreviewData,
} from '../discovery-engine';

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

function localRoom(client: MatrixClient, roomIdOrAlias: string): Room | null {
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

async function roomSummary(
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

function fromLocal(
  room: Room,
  membership: RoomLinkMembership,
  encrypted: boolean,
  via: readonly string[],
): RoomLinkPreviewData {
  const state = liveRoomState(room);
  const topic = state?.getStateEvents(EventType.RoomTopic, '')?.getContent()?.[
    'topic'
  ];
  return {
    roomId: room.roomId,
    canonicalAddress: room.getCanonicalAlias(),
    name: room.name || room.getCanonicalAlias() || room.roomId,
    topic: typeof topic === 'string' && topic ? topic : null,
    avatarMxc: room.getMxcAvatarUrl(),
    memberCount: room.getJoinedMemberCount(),
    encrypted,
    joinRule: joinRuleOf(
      state?.getStateEvents(EventType.RoomJoinRules, '')?.getContent()?.[
        'join_rule'
      ],
    ),
    membership,
    isSpace: room.isSpaceRoom(),
    via: [...via],
    restrictedEligible: false,
  };
}

function fromRemote(
  client: MatrixClient,
  raw: Record<string, unknown>,
  requested: string,
  via: readonly string[],
  local: Room | null,
  localMembership: RoomLinkMembership,
): RoomLinkPreviewData {
  const canonical =
    typeof raw['canonical_alias'] === 'string'
      ? raw['canonical_alias']
      : (local?.getCanonicalAlias() ?? null);
  const allowedRoomIds = Array.isArray(raw['allowed_room_ids'])
    ? raw['allowed_room_ids'].filter(
        (value): value is string =>
          typeof value === 'string' && value.startsWith('!'),
      )
    : [];
  const encryption = raw['encryption'] ?? raw['im.nheko.summary.encryption'];
  const roomId =
    typeof raw['room_id'] === 'string' ? raw['room_id'] : requested;
  const name = typeof raw['name'] === 'string' ? raw['name'] : null;
  const memberCount = raw['num_joined_members'];
  return {
    roomId,
    canonicalAddress: canonical,
    name: name || canonical || roomId,
    topic: typeof raw['topic'] === 'string' ? raw['topic'] : null,
    avatarMxc: typeof raw['avatar_url'] === 'string' ? raw['avatar_url'] : null,
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
    // Per the stable endpoint, an omitted join_rule means public.
    joinRule:
      raw['join_rule'] === undefined ? 'public' : joinRuleOf(raw['join_rule']),
    membership:
      localMembership !== 'unknown'
        ? localMembership
        : membershipOf(raw['membership']),
    isSpace: raw['room_type'] === 'm.space',
    via: [...via],
    restrictedEligible: allowedRoomIds.some(
      (id) => membershipOf(client.getRoom(id)?.getMyMembership()) === 'join',
    ),
  };
}

/**
 * Synced joined/invited/knocked/banned rooms are projected locally first so a homeserver
 * without the summary endpoint cannot regress links to rooms the client already knows.
 */
export async function previewRoomLink(
  client: MatrixClient,
  roomIdOrAlias: string,
  via: readonly string[],
): Promise<RoomLinkPreviewData> {
  const local = localRoom(client, roomIdOrAlias);
  const localMembership = membershipOf(local?.getMyMembership());
  if (local && localMembership !== 'leave' && localMembership !== 'unknown') {
    const encrypted =
      localMembership === 'join'
        ? await isRoomEncrypted(local, client.getCrypto())
        : local.hasEncryptionStateEvent();
    return fromLocal(local, localMembership, encrypted, via);
  }

  let roomId = roomIdOrAlias;
  let servers = normalizeViaServers(via);
  if (roomIdOrAlias.startsWith('#')) {
    const directory = await client.getRoomIdForAlias(roomIdOrAlias);
    roomId = directory.room_id;
    servers = normalizeViaServers([...servers, ...directory.servers]);
  }
  const summary = await roomSummary(client, roomId, servers);
  return fromRemote(
    client,
    summary,
    roomIdOrAlias,
    servers,
    local,
    localMembership,
  );
}
