import {
  effect,
  Injectable,
  type Signal,
  type WritableSignal,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import {
  projectActiveAccount,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import type {
  AccountDataSnapshot,
  PackRoomSnapshot,
} from './expression-engine';
import { EXPRESSION_ENGINE } from './expression-engine.token';
import { packEntries } from './image-pack-target';
import {
  ImagePackSelectionStore,
  type ImagePackSelectionSnapshot,
  type PackSources,
  packSources,
  selectedPackRooms,
} from './image-pack-selection.store';
import {
  IMAGE_PACK_EVENT_TYPE,
  IMAGE_PACK_ROOMS_EVENT_TYPE,
  LEGACY_IMAGE_PACK_EVENT_TYPE,
  LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE,
  LEGACY_PERSONAL_IMAGE_PACK_EVENT_TYPE,
  LEGACY_TRINITY_IMAGE_PACK_ENABLED_USAGE,
  PERSONAL_IMAGE_PACK_EVENT_TYPE,
  PERSONAL_IMAGE_PACK_ID,
  PERSONAL_IMAGE_PACK_NAME,
  TRINITY_IMAGE_PACK_ENABLED_USAGE,
  isImagePackUsage,
  isValidMxcUri,
  parseUsage,
  type ImagePackUsage,
} from './image-pack.model';

export * from './image-pack.model';

const MAX_PACKS = 100;
const MAX_IMAGES_PER_PACK = 500;
const MAX_IMAGES = 1000;
const MAX_LABEL_LENGTH = 256;
const MAX_STATE_KEY_BYTES = 255;

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

const ACCOUNT_DATA_TYPES = [
  IMAGE_PACK_ROOMS_EVENT_TYPE,
  LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE,
  PERSONAL_IMAGE_PACK_EVENT_TYPE,
  LEGACY_PERSONAL_IMAGE_PACK_EVENT_TYPE,
];

/** Projects the MSC2545 packs available to a room from account data and room state. */
@Injectable({ providedIn: 'root' })
export class ImagePackService {
  private readonly engine = inject(EXPRESSION_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly selections = inject(ImagePackSelectionStore);
  private readonly watched = new Map<string, WatchedRoom>();
  /** Re-reads the sources for a new watched room or a confirmed selection. */
  private readonly refresh = new BehaviorSubject<void>(undefined);
  private latest: {
    readonly accountId: string;
    readonly sources: PackSources;
  } | null = null;

  private readonly projection = projectActiveAccount<PackSources>({
    id: 'media.image-packs',
    subscribe: (accountId) =>
      packSources(
        this.engine,
        this.selections,
        accountId,
        ACCOUNT_DATA_TYPES,
        this.refresh,
        () => [...this.watched.keys()],
      ),
    rebuild: (sources, accountId) => {
      this.latest = { accountId, sources };
      for (const [roomId, watched] of this.watched) {
        watched.packs.set(this.readPacks(roomId));
      }
    },
    reset: () => {
      this.latest = null;
      for (const watched of this.watched.values()) {
        watched.packs.set([]);
      }
    },
  });

  constructor() {
    effect(() => {
      const accountId = this.session.activeAccountId();
      if (accountId) this.selections.get(accountId);
      untracked(() => this.refresh.next());
    });
  }

  packsFor(roomId: string): Signal<readonly ImagePack[]> {
    return this.watchedRoom(roomId).packs.asReadonly();
  }

  /**
   * Hold `roomId`'s projection. Callable from an effect: it reads the account selection
   * untracked, so a selection change cannot re-run the caller's effect. That re-run would
   * disconnect and recreate the room's entry, stranding a consumer still reading the old
   * entry's signal.
   */
  connect(roomId: string): void {
    untracked(() => {
      this.watchedRoom(roomId).consumers += 1;
      this.projection.connect();
      this.refresh.next();
    });
  }

  disconnect(roomId: string): void {
    untracked(() => {
      const watched = this.watched.get(roomId);
      if (!watched) return;
      watched.consumers = Math.max(0, watched.consumers - 1);
      if (watched.consumers > 0) return;
      watched.packs.set([]);
      this.watched.delete(roomId);
      if (this.watched.size === 0) this.projection.disconnect();
    });
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

  /** From the last published sources, and only while their account is still the active one. */
  private readPacks(roomId: string): readonly ImagePack[] {
    return untracked(() => {
      const latest = this.latest;
      if (!latest || latest.accountId !== this.session.activeAccountId()) {
        return [];
      }
      return readImagePacks(
        latest.sources.data,
        latest.sources.rooms,
        roomId,
        this.selections.get(latest.accountId),
      );
    });
  }
}

export function readImagePacks(
  data: AccountDataSnapshot,
  rooms: readonly PackRoomSnapshot[],
  currentRoomId: string,
  selection: ImagePackSelectionSnapshot | null = null,
): readonly ImagePack[] {
  const joined = new Map(
    rooms.filter((room) => room.joined).map((room) => [room.roomId, room]),
  );
  const sources = selectedPackSources(data, selection);
  const currentRoom = joined.get(currentRoomId);
  if (currentRoom) {
    const stableKeys = new Set(
      currentRoom.packEvents
        .filter((event) => event.type === IMAGE_PACK_EVENT_TYPE)
        .map((event) => event.state_key)
        .filter(isSafeImagePackStateKey)
        .sort(),
    );
    for (const stateKey of [...stableKeys].sort()) {
      addRoomSource(sources, currentRoomId, stateKey);
    }
    for (const event of currentRoom.packEvents
      .filter((event) => event.type === LEGACY_IMAGE_PACK_EVENT_TYPE)
      .sort((a, b) => a.state_key.localeCompare(b.state_key))) {
      const stateKey = event.state_key;
      if (isSafeImagePackStateKey(stateKey) && !stableKeys.has(stateKey)) {
        addRoomSource(sources, currentRoomId, stateKey);
      }
    }
  }

  const personal = personalPack(data);
  const packs: ImagePack[] = personal ? [personal] : [];
  let totalImages = personal?.images.length ?? 0;
  for (const source of sources) {
    if (packs.length >= MAX_PACKS || totalImages >= MAX_IMAGES) break;
    const sourceRoom = joined.get(source.roomId);
    const content = sourceRoom
      ? packContent(sourceRoom, source.stateKey)
      : null;
    const pack =
      content === null
        ? null
        : parsePack(content, source, boundedText(sourceRoom?.name));
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

function personalPack(data: AccountDataSnapshot): ImagePack | null {
  const id = PERSONAL_IMAGE_PACK_ID;
  const name = PERSONAL_IMAGE_PACK_NAME;
  const content =
    data[PERSONAL_IMAGE_PACK_EVENT_TYPE] ??
    data[LEGACY_PERSONAL_IMAGE_PACK_EVENT_TYPE];
  const images: ImagePackImage[] = packEntries({
    pack: {},
    images:
      isRecord(content) && isRecord(content['images']) ? content['images'] : {},
  })
    .slice(0, MAX_IMAGES_PER_PACK)
    .map((entry) => {
      const info = entry.info ?? {};
      return {
        shortcode: entry.shortcode.slice(0, MAX_LABEL_LENGTH),
        url: entry.url,
        body: entry.body ?? entry.shortcode,
        mimetype: boundedText(info['mimetype']),
        width: positiveNumber(info['w']),
        height: positiveNumber(info['h']),
        info: { ...info },
        usage: entry.usage,
        packId: id,
        packName: name,
      };
    });
  if (images.length === 0) return null;
  const scopeFor = (usage: ImagePackUsage): ImagePackScope | null =>
    images.some((image) => image.usage.includes(usage)) ? 'account' : null;
  return {
    id,
    roomId: '',
    stateKey: '',
    name,
    attribution: null,
    scope: { emoticon: scopeFor('emoticon'), sticker: scopeFor('sticker') },
    images,
  };
}

interface PackSource {
  roomId: string;
  stateKey: string;
  /** Undefined means the source is not account-installed; null means all usages. */
  accountUsage: readonly ImagePackUsage[] | null | undefined;
  roomScoped: boolean;
}

function selectedPackSources(
  data: AccountDataSnapshot,
  selection: ImagePackSelectionSnapshot | null,
): PackSource[] {
  const { content, legacy } = selectedPackRooms(data, selection);
  const selected = accountPackRoomsContent(content, legacy);
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

function packContent(room: PackRoomSnapshot, stateKey: string): unknown {
  const find = (type: string) =>
    room.packEvents.find(
      (event) => event.type === type && event.state_key === stateKey,
    );
  // Stable state wins regardless of whether the source was selected through
  // stable or legacy account data. The legacy event is strictly a fallback.
  const event =
    find(IMAGE_PACK_EVENT_TYPE) ?? find(LEGACY_IMAGE_PACK_EVENT_TYPE);
  return event ? event.content : null;
}

function parsePack(
  content: unknown,
  source: PackSource,
  roomName: string | null,
): ImagePack | null {
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
  const configured =
    value[TRINITY_IMAGE_PACK_ENABLED_USAGE] ??
    value[LEGACY_TRINITY_IMAGE_PACK_ENABLED_USAGE];
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
