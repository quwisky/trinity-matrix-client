import type {
  AccountDataSnapshot,
  PackRoomSnapshot,
} from './expression-engine';
import {
  IMAGE_PACK_EVENT_TYPE,
  TRINITY_IMAGE_PACK_ENABLED_USAGE,
  LEGACY_TRINITY_IMAGE_PACK_ENABLED_USAGE,
  isSafeImagePackStateKey,
  isValidMxcUri,
  type ImagePackUsage,
  LEGACY_IMAGE_PACK_EVENT_TYPE,
} from './image-pack.service';
import {
  type ImagePackSelectionSnapshot,
  selectedPackRooms,
} from './image-pack-selection.store';

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
  readonly enabledUsage: readonly ImagePackUsage[];
  readonly eventType: 'stable' | 'legacy' | null;
  readonly status: ManagedImagePackStatus;
}

export interface ImagePackDiscovery {
  readonly roomId: string;
  readonly roomName: string | null;
  readonly packs: readonly ManagedImagePack[];
}

export interface ImagePackUsageSource extends ImagePackSource {
  readonly usage: readonly ImagePackUsage[];
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
  data: AccountDataSnapshot,
  rooms: readonly PackRoomSnapshot[],
  selection: ImagePackSelectionSnapshot | null = null,
): readonly ManagedImagePack[] {
  const { content, legacy } = selectedPackRooms(data, selection);
  const byId = new Map(rooms.map((room) => [room.roomId, room]));
  return accountPackSources(content, legacy)
    .slice(0, MAX_PACKS)
    .map((source) => {
      const room = byId.get(source.roomId);
      const roomName = boundedText(room?.name);
      if (!room?.joined) return unavailablePack(source, roomName);
      const find = (type: string) =>
        room.packEvents.find(
          (event) => event.type === type && event.state_key === source.stateKey,
        );
      const stable = find(IMAGE_PACK_EVENT_TYPE);
      const event = stable ?? find(LEGACY_IMAGE_PACK_EVENT_TYPE);
      if (!event) return missingPack(source, roomName);
      return inspectPack(
        source,
        roomName,
        stable ? 'stable' : 'legacy',
        event.content,
        source.enabledUsage,
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
    if (!isSafeImagePackStateKey(event.state_key)) continue;
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
        null,
      );
    });
}

export function mutateSelectionContent(
  content: unknown,
  source: ImagePackSource,
  install: boolean,
  migratingLegacy: boolean,
): Record<string, unknown> {
  const base = !migratingLegacy && isRecord(content) ? { ...content } : {};
  const rooms = normalizedRooms(content, migratingLegacy);
  const room = copyDictionary(rooms[source.roomId]);
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
  legacy = false,
): boolean {
  if (!isRecord(content) || !isRecord(content['rooms'])) return false;
  const room = content['rooms'][source.roomId];
  if (!isRecord(room)) return false;
  if (!Object.hasOwn(room, source.stateKey)) return false;
  const reference = room[source.stateKey];
  return isRecord(reference) || (legacy && reference === true);
}

export function mutateSelectionEnabledUsage(
  content: unknown,
  source: ImagePackUsageSource,
  enabled: readonly ImagePackUsage[],
  migratingLegacy = false,
): Record<string, unknown> {
  const base = !migratingLegacy && isRecord(content) ? { ...content } : {};
  const rooms = normalizedRooms(content, migratingLegacy);
  const room = copyDictionary(rooms[source.roomId]);
  if (!Object.hasOwn(room, source.stateKey)) return { ...base, rooms };
  const current = room[source.stateKey];
  if (!isRecord(current)) return { ...base, rooms };
  const reference = { ...current };
  delete reference[LEGACY_TRINITY_IMAGE_PACK_ENABLED_USAGE];
  const normalized = canonicalUsage(enabled).filter((usage) =>
    source.usage.includes(usage),
  );
  const allSupported = canonicalUsage(source.usage);
  if (sameUsage(normalized, allSupported)) {
    delete reference[TRINITY_IMAGE_PACK_ENABLED_USAGE];
  } else {
    reference[TRINITY_IMAGE_PACK_ENABLED_USAGE] = normalized;
  }
  room[source.stateKey] = reference;
  rooms[source.roomId] = room;
  return { ...base, rooms };
}

function inspectPack(
  source: ImagePackSource,
  roomName: string | null,
  eventType: 'stable' | 'legacy',
  content: unknown,
  configuredUsage: readonly ImagePackUsage[] | null,
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
  const enabledUsage =
    configuredUsage === null
      ? usage
      : usage.filter((item) => configuredUsage.includes(item));
  const images = Object.values(content['images']).slice(0, MAX_IMAGES_PER_PACK);
  const imageCount = images.filter(
    (image) => isRecord(image) && isValidMxcUri(image['url']),
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
    enabledUsage,
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
    enabledUsage: [],
    status,
  };
}

interface AccountPackSource extends ImagePackSource {
  readonly enabledUsage: readonly ImagePackUsage[] | null;
}

function accountPackSources(
  content: unknown,
  legacy: boolean,
): AccountPackSource[] {
  if (!isRecord(content) || !isRecord(content['rooms'])) return [];
  const sources: AccountPackSource[] = [];
  for (const roomId of Object.keys(content['rooms']).sort()) {
    const stateKeys = content['rooms'][roomId];
    if (!isRecord(stateKeys)) continue;
    for (const stateKey of Object.keys(stateKeys).sort()) {
      const value = stateKeys[stateKey];
      if (isRecord(value) || (legacy && value === true)) {
        sources.push({
          roomId,
          stateKey,
          enabledUsage: isRecord(value) ? configuredUsage(value) : null,
        });
      }
    }
  }
  return sources;
}

function configuredUsage(
  reference: Record<string, unknown>,
): readonly ImagePackUsage[] | null {
  const value =
    reference[TRINITY_IMAGE_PACK_ENABLED_USAGE] ??
    reference[LEGACY_TRINITY_IMAGE_PACK_ENABLED_USAGE];
  return Array.isArray(value) && value.every(isImagePackUsage)
    ? canonicalUsage(value)
    : null;
}

function isImagePackUsage(value: unknown): value is ImagePackUsage {
  return value === 'emoticon' || value === 'sticker';
}

function canonicalUsage(value: readonly unknown[]): ImagePackUsage[] {
  const usage: ImagePackUsage[] = [];
  if (value.includes('emoticon')) usage.push('emoticon');
  if (value.includes('sticker')) usage.push('sticker');
  return usage;
}

function sameUsage(
  left: readonly ImagePackUsage[],
  right: readonly ImagePackUsage[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function normalizedRooms(
  content: unknown,
  legacy: boolean,
): Record<string, Record<string, unknown>> {
  if (!isRecord(content) || !isRecord(content['rooms'])) return {};
  const rooms = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const [roomId, stateKeys] of Object.entries(content['rooms'])) {
    if (!isRecord(stateKeys)) continue;
    const next = Object.create(null) as Record<string, unknown>;
    for (const [stateKey, value] of Object.entries(stateKeys)) {
      if (isRecord(value)) next[stateKey] = { ...value };
      else if (legacy && value === true) next[stateKey] = {};
    }
    if (Object.keys(next).length > 0) rooms[roomId] = next;
  }
  return rooms;
}

function copyDictionary(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const copy = Object.create(null) as Record<string, unknown>;
  if (!value) return copy;
  for (const [key, entry] of Object.entries(value)) copy[key] = entry;
  return copy;
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
