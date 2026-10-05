import { EventType, type MatrixEvent, type RoomState } from 'matrix-js-sdk';

/** One room creator, named as the room currently knows them. */
export interface RoomCreator {
  readonly userId: string;
  /** The member's display name, or the user ID when the room has no name for them. */
  readonly displayName: string;
}

/** The room this one replaced, from `m.room.create` `predecessor`. */
export interface RoomPredecessor {
  readonly roomId: string;
  readonly eventId: string | null;
}

/**
 * A room's technical details for Room settings › Advanced, projected from current state.
 * Null and empty fields mean the state did not say — never a guess.
 */
export interface RoomAdvancedInfo {
  readonly roomId: string;
  /** `room_version`; `'1'` when the create event omits it; null when unknown. */
  readonly version: string | null;
  /** The creator plus, from version 12, `additional_creators`; empty when unknown. */
  readonly createdBy: readonly RoomCreator[];
  /** The create event's `origin_server_ts`, or null. */
  readonly createdAt: number | null;
  /** The `m.room.encryption` algorithm, or null when the room is not encrypted. */
  readonly encryption: string | null;
  /** False only when `m.federate` is false; null when the create event is missing. */
  readonly federated: boolean | null;
  readonly predecessor: RoomPredecessor | null;
  /** `replacement_room` from `m.room.tombstone`, or null. */
  readonly successor: string | null;
}

/**
 * Project a room's current state into {@link RoomAdvancedInfo}. Total: partial or malformed
 * state yields nulls, never an exception, because Room settings renders it directly.
 */
export function roomAdvancedInfo(
  roomId: string,
  state: RoomState | undefined,
): RoomAdvancedInfo {
  const encryption = text(
    state?.getStateEvents(EventType.RoomEncryption, '')?.getContent()[
      'algorithm'
    ],
  );
  const successor = text(
    state?.getStateEvents(EventType.RoomTombstone, '')?.getContent()[
      'replacement_room'
    ],
  );
  const create = state?.getStateEvents(EventType.RoomCreate, '');
  if (!create) {
    return {
      roomId,
      version: null,
      createdBy: [],
      createdAt: null,
      encryption,
      federated: null,
      predecessor: null,
      successor,
    };
  }
  const content: Record<string, unknown> = create.getContent();
  const rawVersion = content['room_version'];
  // Absent means version 1, per the spec; present but malformed is unknown, not a guess.
  const version = rawVersion === undefined ? '1' : text(rawVersion);
  const predecessor = record(content['predecessor']);
  const predecessorId = text(predecessor?.['room_id']);
  const createdAt = create.getTs();
  return {
    roomId,
    version,
    createdBy: creatorsOf(create, version, state),
    createdAt: createdAt > 0 ? createdAt : null,
    encryption,
    federated: content['m.federate'] !== false,
    predecessor: predecessorId
      ? { roomId: predecessorId, eventId: text(predecessor?.['event_id']) }
      : null,
    successor,
  };
}

/** The create event's sender (or legacy `creator`), plus v12+ `additional_creators`. */
function creatorsOf(
  create: MatrixEvent,
  version: string | null,
  state: RoomState | undefined,
): readonly RoomCreator[] {
  const content: Record<string, unknown> = create.getContent();
  const ids = [create.getSender() ?? text(content['creator'])];
  const additional = content['additional_creators'];
  // `additional_creators` only means something from room version 12 (MSC4289).
  if (version !== null && /^\d+$/.test(version) && Number(version) >= 12) {
    if (Array.isArray(additional)) ids.push(...additional.map(text));
  }
  return [...new Set(ids.filter((id): id is string => id !== null))].map(
    (userId) => ({
      userId,
      displayName: state?.getMember(userId)?.name || userId,
    }),
  );
}

/** A non-blank string, or null. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}
