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

const MAX_PACKS = 100;
const MAX_IMAGES_PER_PACK = 500;
const MAX_IMAGES = 1000;
const MAX_LABEL_LENGTH = 256;

export type ImagePackUsage = 'emoticon' | 'sticker';

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
        .sort(),
    );
    for (const stateKey of [...stableKeys].sort()) {
      sources.push({ roomId: currentRoomId, stateKey });
    }
    for (const event of [
      ...currentState.getStateEvents(LEGACY_IMAGE_PACK_EVENT_TYPE),
    ].sort((a, b) =>
      (a.getStateKey() ?? '').localeCompare(b.getStateKey() ?? ''),
    )) {
      const stateKey = event.getStateKey() ?? '';
      if (!stableKeys.has(stateKey)) {
        sources.push({ roomId: currentRoomId, stateKey });
      }
    }
  }

  const seen = new Set<string>();
  const packs: ImagePack[] = [];
  let totalImages = 0;
  for (const source of sources) {
    if (packs.length >= MAX_PACKS || totalImages >= MAX_IMAGES) break;
    const id = `${source.roomId}\u0000${source.stateKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const sourceRoom = client.getRoom?.(source.roomId);
    const event = packEvent(client, source.roomId, source.stateKey);
    const pack = event
      ? parsePack(
          event,
          source.roomId,
          source.stateKey,
          boundedText(sourceRoom?.name),
        )
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
        isRecord(stateKeys[stateKey]) ||
        (legacy && stateKeys[stateKey] === true)
      ) {
        sources.push({
          roomId,
          stateKey,
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
  roomId: string,
  stateKey: string,
  roomName: string | null,
): ImagePack | null {
  const content: unknown = event.getContent();
  if (!isRecord(content) || !isRecord(content['images'])) return null;
  const packMeta = isRecord(content['pack']) ? content['pack'] : {};
  const usage = parseUsage(packMeta['usage']);
  if (usage.length === 0) return null;
  const id = `${roomId}:${stateKey}`;
  const name =
    boundedText(packMeta['display_name']) ?? roomName ?? 'Image pack';
  const images: ImagePackImage[] = [];
  for (const shortcode of Object.keys(content['images']).sort()) {
    if (images.length >= MAX_IMAGES_PER_PACK) break;
    const raw = content['images'][shortcode];
    if (!isRecord(raw) || !validMxc(raw['url'])) continue;
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
    roomId,
    stateKey,
    name,
    attribution: boundedText(packMeta['attribution']),
    images,
  };
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
