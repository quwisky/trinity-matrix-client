import {
  effect,
  Injectable,
  type Signal,
  type WritableSignal,
  inject,
  signal,
} from '@angular/core';
import {
  ClientEvent,
  RoomEvent,
  type MatrixClient,
  type MatrixEvent,
  RoomStateEvent,
} from 'matrix-js-sdk';
import {
  MatrixClientService,
  projectFromClient,
} from '@trinity/data-access/matrix-client';
import { liveRoomState } from '@trinity/util/matrix';
import { ImagePackSelectionStore } from './image-pack-selection.store';

export const IMAGE_PACK_EVENT_TYPE = 'm.room.image_pack';
export const LEGACY_IMAGE_PACK_EVENT_TYPE = 'im.ponies.room_emotes';
export const IMAGE_PACK_ROOMS_EVENT_TYPE = 'm.image_pack.rooms';
export const LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE = 'im.ponies.emote_rooms';
export const TRINITY_IMAGE_PACK_ENABLED_USAGE = 'eu.qwky.trinity.enabled_usage';

const MAX_PACKS = 100;
const MAX_IMAGES_PER_PACK = 500;
const MAX_IMAGES = 1000;
const MAX_LABEL_LENGTH = 256;
const MAX_STATE_KEY_BYTES = 255;
const SERVER_NAME_PATTERN =
  /^(?:(?:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|(?:\[[\dA-Fa-f:.]{2,45}])|(?:[A-Za-z\d\-.]{1,255}))(?::\d{1,5})?$/;
const MEDIA_ID_PATTERN = /^[\w-]+$/;

export type ImagePackUsage = 'emoticon' | 'sticker';
export type ImagePackScope = 'account' | 'room';

export interface ImagePackScopeByUsage {
  readonly emoticon: ImagePackScope | null;
  readonly sticker: ImagePackScope | null;
}

export interface ImagePackImage {
  readonly shortcode: string;
  readonly url: string;
  readonly body: string;
  readonly mimetype: string | null;
  readonly width: number | null;
  readonly height: number | null;
  /** Original MSC2545 ImageInfo, retained for an exact m.sticker send. */
  readonly info: Readonly<Record<string, unknown>>;
  readonly usage: readonly ImagePackUsage[];
  readonly packId: string;
  readonly packName: string;
}

export interface ImagePack {
  readonly id: string;
  readonly roomId: string;
  readonly stateKey: string;
  readonly name: string;
  readonly attribution: string | null;
  readonly scope: ImagePackScopeByUsage;
  readonly images: readonly ImagePackImage[];
}

interface WatchedRoom {
  readonly packs: WritableSignal<readonly ImagePack[]>;
  consumers: number;
}

/** Projects the MSC2545 packs available to a room from account data and room state. */
@Injectable({ providedIn: 'root' })
export class ImagePackService {
  private readonly matrix = inject(MatrixClientService);
  private readonly selections = inject(ImagePackSelectionStore);
  private readonly watched = new Map<string, WatchedRoom>();

  private readonly onStateEvent = (event: MatrixEvent): void => {
    if (
      event.getType() === IMAGE_PACK_EVENT_TYPE ||
      event.getType() === LEGACY_IMAGE_PACK_EVENT_TYPE
    ) {
      this.projection.schedule();
    }
  };

  private readonly onAccountData = (event: MatrixEvent): void => {
    if (event.getType() === IMAGE_PACK_ROOMS_EVENT_TYPE) {
      const client = this.projection.client();
      if (client) {
        this.selections.clear(client);
      }
      this.projection.schedule();
    } else if (event.getType() === LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE) {
      this.projection.schedule();
    }
  };

  private readonly projection = projectFromClient({
    id: 'media.image-packs',
    matrix: this.matrix,
    bind: (client) => {
      client.on?.(RoomStateEvent.Events, this.onStateEvent);
      client.on?.(RoomEvent.MyMembership, this.projection.schedule);
      client.on?.(ClientEvent.AccountData, this.onAccountData);
    },
    unbind: (client) => {
      client.off?.(RoomStateEvent.Events, this.onStateEvent);
      client.off?.(RoomEvent.MyMembership, this.projection.schedule);
      client.off?.(ClientEvent.AccountData, this.onAccountData);
    },
    rebuild: (client) => {
      for (const [roomId, watched] of this.watched) {
        watched.packs.set(
          readImagePacks(client, roomId, this.selections.get(client)),
        );
      }
    },
    reset: () => {
      for (const watched of this.watched.values()) {
        watched.packs.set([]);
      }
    },
  });

  constructor() {
    effect(() => {
      this.selections.changed();
      if (this.projection.isConnected()) this.projection.schedule();
    });
  }

  packsFor(roomId: string): Signal<readonly ImagePack[]> {
    return this.watchedRoom(roomId).packs.asReadonly();
  }

  connect(roomId: string): void {
    this.watchedRoom(roomId).consumers += 1;
    this.projection.connect();
  }

  disconnect(roomId: string): void {
    const watched = this.watched.get(roomId);
    if (!watched) return;
    watched.consumers = Math.max(0, watched.consumers - 1);
    if (watched.consumers > 0) return;
    watched.packs.set([]);
    this.watched.delete(roomId);
    if (this.watched.size === 0) this.projection.disconnect();
  }

  private watchedRoom(roomId: string): WatchedRoom {
    let watched = this.watched.get(roomId);
    if (!watched) {
      watched = {
        packs: signal(this.readPacks(roomId), {
          equal: samePacks,
        }),
        consumers: 0,
      };
      this.watched.set(roomId, watched);
    }
    return watched;
  }

  private readClient(): MatrixClient | null {
    return (
      this.projection.client() ??
      (this.matrix.isInitialized ? this.matrix.instance : null)
    );
  }

  private readPacks(roomId: string): readonly ImagePack[] {
    const client = this.readClient();
    return readImagePacks(
      client,
      roomId,
      client ? this.selections.get(client) : null,
    );
  }
}

export function readImagePacks(
  client: MatrixClient | null,
  currentRoomId: string,
  selection: {
    readonly present: boolean;
    readonly content: unknown;
  } | null = null,
): readonly ImagePack[] {
  if (!client) return [];
  const sources = selectedPackSources(client, selection);
  const currentRoom = client.getRoom?.(currentRoomId);
  const currentState = currentRoom ? liveRoomState(currentRoom) : undefined;
  if (currentState) {
    const stableKeys = new Set(
      currentState
        .getStateEvents(IMAGE_PACK_EVENT_TYPE)
        .map((event) => event.getStateKey() ?? '')
        .filter(isSafeImagePackStateKey)
        .sort(),
    );
    for (const stateKey of [...stableKeys].sort()) {
      addRoomSource(sources, currentRoomId, stateKey);
    }
    for (const event of [
      ...currentState.getStateEvents(LEGACY_IMAGE_PACK_EVENT_TYPE),
    ].sort((a, b) =>
      (a.getStateKey() ?? '').localeCompare(b.getStateKey() ?? ''),
    )) {
      const stateKey = event.getStateKey() ?? '';
      if (isSafeImagePackStateKey(stateKey) && !stableKeys.has(stateKey)) {
        addRoomSource(sources, currentRoomId, stateKey);
      }
    }
  }

  const packs: ImagePack[] = [];
  let totalImages = 0;
  for (const source of sources) {
    if (packs.length >= MAX_PACKS || totalImages >= MAX_IMAGES) break;
    const sourceRoom = client.getRoom?.(source.roomId);
    const event = packEvent(client, source.roomId, source.stateKey);
    const pack = event
      ? parsePack(event, source, boundedText(sourceRoom?.name))
      : null;
    if (!pack) continue;
    const available = MAX_IMAGES - totalImages;
    const bounded =
      pack.images.length > available
        ? { ...pack, images: pack.images.slice(0, available) }
        : pack;
    packs.push(bounded);
    totalImages += bounded.images.length;
  }
  return packs;
}

interface PackSource {
  roomId: string;
  stateKey: string;
  /** Undefined means the source is not account-installed; null means all usages. */
  accountUsage: readonly ImagePackUsage[] | null | undefined;
  roomScoped: boolean;
}

function selectedPackSources(
  client: MatrixClient,
  selection: { readonly present: boolean; readonly content: unknown } | null,
): PackSource[] {
  // matrix-js-sdk's account-data map is intentionally closed over spec events;
  // MSC2545's stable and legacy custom keys are therefore accessed through a
  // narrow string-keyed view until the SDK includes them in AccountDataEvents.
  const getAccountData = client.getAccountData
    ? (client.getAccountData.bind(client) as (
        type: string,
      ) => MatrixEvent | undefined)
    : () => undefined;
  const stableEvent = getAccountData(IMAGE_PACK_ROOMS_EVENT_TYPE);
  const stablePresent = selection?.present ?? stableEvent !== undefined;
  const selected = accountPackRoomsContent(
    stablePresent
      ? selection
        ? selection.content
        : stableEvent?.getContent()
      : getAccountData(LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE)?.getContent(),
    !stablePresent,
  );
  return selected.sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
}

function accountPackRoomsContent(
  content: unknown,
  legacy: boolean,
): PackSource[] {
  if (!isRecord(content) || !isRecord(content['rooms'])) return [];
  const sources: PackSource[] = [];
  for (const roomId of Object.keys(content['rooms']).sort()) {
    const stateKeys = content['rooms'][roomId];
    if (!isRecord(stateKeys)) continue;
    for (const stateKey of Object.keys(stateKeys).sort()) {
      // MSC2545 requires an object. Only the experimental legacy event accepted
      // the earlier boolean representation.
      if (
        isSafeImagePackStateKey(stateKey) &&
        (isRecord(stateKeys[stateKey]) ||
          (legacy && stateKeys[stateKey] === true))
      ) {
        sources.push({
          roomId,
          stateKey,
          accountUsage: isRecord(stateKeys[stateKey])
            ? enabledUsage(stateKeys[stateKey])
            : null,
          roomScoped: false,
        });
      }
    }
  }
  return sources;
}

function packEvent(
  client: MatrixClient,
  roomId: string,
  stateKey: string,
): MatrixEvent | null {
  const room = client.getRoom?.(roomId);
  if (room?.getMyMembership() !== 'join') return null;
  const state = room ? liveRoomState(room) : undefined;
  if (!state) return null;
  const stable = state.getStateEvents(IMAGE_PACK_EVENT_TYPE, stateKey);
  const legacy = state.getStateEvents(LEGACY_IMAGE_PACK_EVENT_TYPE, stateKey);
  // Stable state wins regardless of whether the source was selected through
  // stable or legacy account data. The legacy event is strictly a fallback.
  return (stable ?? legacy) as MatrixEvent | null;
}

function parsePack(
  event: MatrixEvent,
  source: PackSource,
  roomName: string | null,
): ImagePack | null {
  const content: unknown = event.getContent();
  if (!isRecord(content) || !isRecord(content['images'])) return null;
  const packMeta = isRecord(content['pack']) ? content['pack'] : {};
  const publisherUsage = parseUsage(packMeta['usage']);
  if (publisherUsage.length === 0) return null;
  const scope = scopeByUsage(source, publisherUsage);
  const usage = publisherUsage.filter((item) => scope[item] !== null);
  if (usage.length === 0) return null;
  const id = sourceKey(source);
  const name =
    boundedText(packMeta['display_name']) ?? roomName ?? 'Image pack';
  const images: ImagePackImage[] = [];
  for (const shortcode of Object.keys(content['images']).sort()) {
    if (images.length >= MAX_IMAGES_PER_PACK) break;
    const raw = content['images'][shortcode];
    if (!isRecord(raw) || !isValidMxcUri(raw['url'])) continue;
    const info = isRecord(raw['info']) ? raw['info'] : {};
    images.push({
      shortcode: shortcode.slice(0, MAX_LABEL_LENGTH),
      url: raw['url'],
      body: typeof raw['body'] === 'string' ? raw['body'] : shortcode,
      mimetype: boundedText(info['mimetype']),
      width: positiveNumber(info['w']),
      height: positiveNumber(info['h']),
      info: { ...info },
      usage,
      packId: id,
      packName: name,
    });
  }
  if (images.length === 0) return null;
  return {
    id,
    roomId: source.roomId,
    stateKey: source.stateKey,
    name,
    attribution: boundedText(packMeta['attribution']),
    scope,
    images,
  };
}

function addRoomSource(
  sources: PackSource[],
  roomId: string,
  stateKey: string,
): void {
  const existing = sources.find(
    (source) => source.roomId === roomId && source.stateKey === stateKey,
  );
  if (existing) {
    existing.roomScoped = true;
  } else {
    sources.push({
      roomId,
      stateKey,
      accountUsage: undefined,
      roomScoped: true,
    });
  }
}

function scopeByUsage(
  source: PackSource,
  publisherUsage: readonly ImagePackUsage[],
): ImagePackScopeByUsage {
  const accountSelected = source.accountUsage !== undefined;
  const accountUsage = source.accountUsage ?? publisherUsage;
  const scopeFor = (usage: ImagePackUsage): ImagePackScope | null => {
    if (!publisherUsage.includes(usage)) return null;
    if (accountSelected && accountUsage.includes(usage)) return 'account';
    return source.roomScoped ? 'room' : null;
  };
  return {
    emoticon: scopeFor('emoticon'),
    sticker: scopeFor('sticker'),
  };
}

function enabledUsage(value: unknown): readonly ImagePackUsage[] | null {
  if (!isRecord(value)) return null;
  const configured = value[TRINITY_IMAGE_PACK_ENABLED_USAGE];
  if (
    configured === undefined ||
    !Array.isArray(configured) ||
    !configured.every(isImagePackUsage)
  ) {
    return null;
  }
  const usage: ImagePackUsage[] = [];
  if (configured.includes('emoticon')) usage.push('emoticon');
  if (configured.includes('sticker')) usage.push('sticker');
  return usage;
}

function isImagePackUsage(value: unknown): value is ImagePackUsage {
  return value === 'emoticon' || value === 'sticker';
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

/** Matches matrix-js-sdk's server-name and media-ID validation. */
export function isValidMxcUri(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('mxc://')) return false;
  const [serverName, mediaId, ...rest] = value.slice(6).split('/');
  return (
    rest.length === 0 &&
    SERVER_NAME_PATTERN.test(serverName) &&
    MEDIA_ID_PATTERN.test(mediaId)
  );
}

/** Bounds new state-key selections without changing their identity. */
export function isSafeImagePackStateKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    new TextEncoder().encode(value).length <= MAX_STATE_KEY_BYTES
  );
}

function boundedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_LABEL_LENGTH) : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function sourceKey(source: Pick<PackSource, 'roomId' | 'stateKey'>): string {
  return `${source.roomId}\u0000${source.stateKey}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function samePacks(a: readonly ImagePack[], b: readonly ImagePack[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
