import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import { liveRoomState } from '@trinity/util/matrix';
import {
  IMAGE_PACK_EVENT_TYPE,
  IMAGE_PACK_ROOMS_EVENT_TYPE,
  type ImagePackUsage,
  LEGACY_IMAGE_PACK_EVENT_TYPE,
  LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE,
} from './image-pack.service';

const MAX_SOURCE_LENGTH = 1024;
const MAX_PACKS = 100;
const MAX_IMAGES_PER_PACK = 500;
const MAX_LABEL_LENGTH = 256;

export type ManagedImagePackStatus =
  'available' | 'unavailable' | 'missing' | 'malformed' | 'empty';

export interface ImagePackSource {
  readonly roomId: string;
  readonly stateKey: string;
}

export interface ManagedImagePack extends ImagePackSource {
  readonly id: string;
  readonly name: string;
  readonly roomName: string | null;
  readonly attribution: string | null;
  readonly imageCount: number;
  readonly usage: readonly ImagePackUsage[];
  readonly eventType: 'stable' | 'legacy' | null;
  readonly status: ManagedImagePackStatus;
}

export interface ImagePackDiscovery {
  readonly roomId: string;
  readonly roomName: string | null;
  readonly packs: readonly ManagedImagePack[];
}

export type ImagePackManagementErrorCode =
  'invalid-source' | 'not-signed-in' | 'no-packs' | 'write-conflict';

export class ImagePackManagementError extends Error {
  constructor(readonly code: ImagePackManagementErrorCode) {
    super(code);
    this.name = 'ImagePackManagementError';
  }
}

export function validateImagePackSource(source: string): string {
  const normalized = source.trim();
  const separator = normalized.indexOf(':', 1);
  if (
    normalized.length === 0 ||
    normalized.length > MAX_SOURCE_LENGTH ||
    !['!', '#'].includes(normalized[0] ?? '') ||
    separator <= 1 ||
    separator === normalized.length - 1 ||
    /\s/.test(normalized)
  ) {
    throw new ImagePackManagementError('invalid-source');
  }
  return normalized;
}

export function readManagedImagePacks(
  client: MatrixClient,
  selection: {
    readonly present: boolean;
    readonly content: unknown;
  } | null = null,
): readonly ManagedImagePack[] {
  const getAccountData = client.getAccountData
    ? (client.getAccountData.bind(client) as (
        type: string,
      ) => MatrixEvent | undefined)
    : () => undefined;
  const stableEvent = getAccountData(IMAGE_PACK_ROOMS_EVENT_TYPE);
  const stablePresent = selection?.present ?? stableEvent !== undefined;
  const content = stablePresent
    ? selection
      ? selection.content
      : stableEvent?.getContent()
    : getAccountData(LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE)?.getContent();
  const sources = accountPackSources(content, !stablePresent);
  return sources.slice(0, MAX_PACKS).map((source) => {
    const room = client.getRoom?.(source.roomId);
    const roomName = boundedText(room?.name);
    if (!room || room.getMyMembership() !== 'join') {
      return unavailablePack(source, roomName);
    }
    const state = liveRoomState(room);
    const stable = state?.getStateEvents(
      IMAGE_PACK_EVENT_TYPE,
      source.stateKey,
    ) as MatrixEvent | null;
    const legacy = state?.getStateEvents(
      LEGACY_IMAGE_PACK_EVENT_TYPE,
      source.stateKey,
    ) as MatrixEvent | null;
    const event = stable ?? legacy;
    if (!event) return missingPack(source, roomName);
    return inspectPack(
      source,
      roomName,
      stable ? 'stable' : 'legacy',
      event.getContent(),
    );
  });
}

export interface RawImagePackStateEvent {
  readonly type: string;
  readonly state_key: string;
  readonly content: unknown;
}

export function inspectStatePacks(
  roomId: string,
  roomName: string | null,
  events: readonly RawImagePackStateEvent[],
): readonly ManagedImagePack[] {
  const stable = new Map<string, RawImagePackStateEvent>();
  const legacy = new Map<string, RawImagePackStateEvent>();
  for (const event of events) {
    if (event.type === IMAGE_PACK_EVENT_TYPE)
      stable.set(event.state_key, event);
    if (event.type === LEGACY_IMAGE_PACK_EVENT_TYPE)
      legacy.set(event.state_key, event);
  }
  const keys = new Set([...stable.keys(), ...legacy.keys()]);
  return [...keys]
    .sort()
    .slice(0, MAX_PACKS)
    .map((stateKey) => {
      const stableEvent = stable.get(stateKey);
      const event = stableEvent ?? legacy.get(stateKey);
      return inspectPack(
        { roomId, stateKey },
        roomName,
        stableEvent ? 'stable' : 'legacy',
        event?.content,
      );
    });
}

export function roomNameFromState(
  events: readonly RawImagePackStateEvent[],
): string | null {
  const content = events.find(
    (event) => event.type === 'm.room.name' && event.state_key === '',
  )?.content;
  return boundedText(isRecord(content) ? content['name'] : null);
}

export function mutateSelectionContent(
  content: unknown,
  source: ImagePackSource,
  install: boolean,
  migratingLegacy: boolean,
): Record<string, unknown> {
  const base = !migratingLegacy && isRecord(content) ? { ...content } : {};
  const rooms = normalizedRooms(content, migratingLegacy);
  const room = { ...(rooms[source.roomId] ?? {}) };
  if (install) {
    if (!isRecord(room[source.stateKey])) room[source.stateKey] = {};
  } else {
    delete room[source.stateKey];
  }
  if (Object.keys(room).length > 0) rooms[source.roomId] = room;
  else delete rooms[source.roomId];
  return { ...base, rooms };
}

export function hasImagePackReference(
  content: unknown,
  source: ImagePackSource,
): boolean {
  if (!isRecord(content) || !isRecord(content['rooms'])) return false;
  const room = content['rooms'][source.roomId];
  return isRecord(room) && isRecord(room[source.stateKey]);
}

function inspectPack(
  source: ImagePackSource,
  roomName: string | null,
  eventType: 'stable' | 'legacy',
  content: unknown,
): ManagedImagePack {
  const base = {
    ...source,
    id: sourceKey(source),
    roomName,
    eventType,
  } as const;
  if (!isRecord(content) || !isRecord(content['images'])) {
    return unavailableDetails(base, roomName, 'malformed');
  }
  const meta = isRecord(content['pack']) ? content['pack'] : {};
  const usage = parseUsage(meta['usage']);
  const images = Object.values(content['images']).slice(0, MAX_IMAGES_PER_PACK);
  const imageCount = images.filter(
    (image) => isRecord(image) && validMxc(image['url']),
  ).length;
  const invalidImages = imageCount < images.length;
  const status: ManagedImagePackStatus =
    usage.length === 0 || invalidImages
      ? 'malformed'
      : imageCount === 0
        ? 'empty'
        : 'available';
  return {
    ...base,
    name: boundedText(meta['display_name']) ?? roomName ?? 'Image pack',
    attribution: boundedText(meta['attribution']),
    imageCount,
    usage,
    status,
  };
}

function unavailablePack(
  source: ImagePackSource,
  roomName: string | null,
): ManagedImagePack {
  return unavailableDetails(
    { ...source, id: sourceKey(source), roomName, eventType: null },
    roomName,
    'unavailable',
  );
}

function missingPack(
  source: ImagePackSource,
  roomName: string | null,
): ManagedImagePack {
  return unavailableDetails(
    { ...source, id: sourceKey(source), roomName, eventType: null },
    roomName,
    'missing',
  );
}

function unavailableDetails(
  base: Pick<
    ManagedImagePack,
    'id' | 'roomId' | 'stateKey' | 'roomName' | 'eventType'
  >,
  roomName: string | null,
  status: Exclude<ManagedImagePackStatus, 'available' | 'empty'>,
): ManagedImagePack {
  return {
    ...base,
    name:
      roomName ??
      (status === 'missing' ? 'Deleted image pack' : 'Unavailable image pack'),
    attribution: null,
    imageCount: 0,
    usage: [],
    status,
  };
}

function accountPackSources(
  content: unknown,
  legacy: boolean,
): ImagePackSource[] {
  if (!isRecord(content) || !isRecord(content['rooms'])) return [];
  const sources: ImagePackSource[] = [];
  for (const roomId of Object.keys(content['rooms']).sort()) {
    const stateKeys = content['rooms'][roomId];
    if (!isRecord(stateKeys)) continue;
    for (const stateKey of Object.keys(stateKeys).sort()) {
      const value = stateKeys[stateKey];
      if (isRecord(value) || (legacy && value === true)) {
        sources.push({ roomId, stateKey });
      }
    }
  }
  return sources;
}

function normalizedRooms(
  content: unknown,
  legacy: boolean,
): Record<string, Record<string, unknown>> {
  if (!isRecord(content) || !isRecord(content['rooms'])) return {};
  const rooms: Record<string, Record<string, unknown>> = {};
  for (const [roomId, stateKeys] of Object.entries(content['rooms'])) {
    if (!isRecord(stateKeys)) continue;
    const next: Record<string, unknown> = {};
    for (const [stateKey, value] of Object.entries(stateKeys)) {
      if (isRecord(value)) next[stateKey] = { ...value };
      else if (legacy && value === true) next[stateKey] = {};
    }
    if (Object.keys(next).length > 0) rooms[roomId] = next;
  }
  return rooms;
}

function parseUsage(value: unknown): readonly ImagePackUsage[] {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    return ['emoticon', 'sticker'];
  }
  if (!Array.isArray(value)) return [];
  const usage: ImagePackUsage[] = [];
  if (value.includes('emoticon')) usage.push('emoticon');
  if (value.includes('sticker')) usage.push('sticker');
  return usage;
}

function validMxc(value: unknown): value is string {
  return typeof value === 'string' && /^mxc:\/\/[^/\s]+\/[^\s]+$/.test(value);
}

function boundedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_LABEL_LENGTH) : null;
}

function sourceKey(source: ImagePackSource): string {
  return `${source.roomId}\u0000${source.stateKey}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
