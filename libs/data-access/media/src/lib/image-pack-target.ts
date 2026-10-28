import { type Observable, firstValueFrom, map } from 'rxjs';
import { EngineRequestError, type EngineResult } from '@trinity/util/matrix';
import type {
  AccountDataSnapshot,
  ExpressionEngine,
  PackRoomSnapshot,
} from './expression-engine';
import {
  IMAGE_PACK_EVENT_TYPE,
  LEGACY_IMAGE_PACK_EVENT_TYPE,
  LEGACY_PERSONAL_IMAGE_PACK_EVENT_TYPE,
  PERSONAL_IMAGE_PACK_EVENT_TYPE,
  PERSONAL_IMAGE_PACK_NAME,
  isValidMxcUri,
  parseUsage,
  type ImagePackUsage,
} from './image-pack.model';

export interface PackEntry {
  readonly shortcode: string;
  readonly url: string;
  readonly body?: string;
  readonly info?: Readonly<Record<string, unknown>>;
  readonly usage: readonly ImagePackUsage[];
}

/** Includes unrecognised entries, kept verbatim. */
export interface PackContent {
  readonly pack: Readonly<Record<string, unknown>>;
  readonly images: Readonly<Record<string, unknown>>;
}

/** One pack on one account; engine failures reject as {@link EngineRequestError}. */
export interface PackTarget<S> {
  readonly id: string;
  /** Subscription: the local (synced) copy that `read`, `canWrite` and `defaultName` take. */
  snapshot(engine: ExpressionEngine, accountId: string): Observable<S>;
  read(snapshot: S): PackContent;
  /** The server's copy, past the local store, which a write does not update until sync echoes it. */
  readServer(engine: ExpressionEngine, accountId: string): Promise<PackContent>;
  write(
    engine: ExpressionEngine,
    accountId: string,
    next: PackContent,
  ): Promise<void>;
  canWrite(snapshot: S): boolean;
  /** The `display_name` written when the pack has none. */
  defaultName(snapshot: S): string;
}

/** Valid entries only; invalid ones stay in `content.images` for the caller to write back. */
export function packEntries(content: PackContent): readonly PackEntry[] {
  const entries: PackEntry[] = [];
  for (const [shortcode, raw] of Object.entries(content.images)) {
    if (!isRecord(raw) || !isValidMxcUri(raw['url'])) continue;
    const usage = parseUsage(raw['usage']);
    if (usage.length === 0) continue;
    entries.push({
      shortcode,
      url: raw['url'],
      ...(typeof raw['body'] === 'string' && { body: raw['body'] }),
      ...(isRecord(raw['info']) && { info: raw['info'] }),
      usage,
    });
  }
  return entries;
}

const PERSONAL_TYPES = [
  PERSONAL_IMAGE_PACK_EVENT_TYPE,
  LEGACY_PERSONAL_IMAGE_PACK_EVENT_TYPE,
];

const ROOM_TYPES = [IMAGE_PACK_EVENT_TYPE, LEGACY_IMAGE_PACK_EVENT_TYPE];

/** The user's own pack, in account data. */
export class AccountPackTarget implements PackTarget<AccountDataSnapshot> {
  readonly id = 'account';

  snapshot(
    engine: ExpressionEngine,
    accountId: string,
  ): Observable<AccountDataSnapshot> {
    return engine.accountData(accountId, PERSONAL_TYPES);
  }

  read(snapshot: AccountDataSnapshot): PackContent {
    return toContent(
      snapshot[PERSONAL_IMAGE_PACK_EVENT_TYPE] ??
        snapshot[LEGACY_PERSONAL_IMAGE_PACK_EVENT_TYPE],
    );
  }

  readServer(
    engine: ExpressionEngine,
    accountId: string,
  ): Promise<PackContent> {
    return firstFound(PERSONAL_TYPES, (type) =>
      engine.fetchAccountData(accountId, type),
    );
  }

  async write(
    engine: ExpressionEngine,
    accountId: string,
    next: PackContent,
  ): Promise<void> {
    await settled(
      engine.setAccountData(accountId, PERSONAL_IMAGE_PACK_EVENT_TYPE, {
        pack: next.pack,
        images: next.images,
      }),
    );
  }

  canWrite(): boolean {
    return true;
  }

  defaultName(): string {
    return PERSONAL_IMAGE_PACK_NAME;
  }
}

/** A room's own pack: state key `""`. The legacy type is read until the first write replaces it. */
export class RoomPackTarget implements PackTarget<PackRoomSnapshot> {
  readonly id: string;

  constructor(readonly roomId: string) {
    this.id = `room:${roomId}`;
  }

  snapshot(
    engine: ExpressionEngine,
    accountId: string,
  ): Observable<PackRoomSnapshot> {
    return engine
      .packRooms(accountId, [this.roomId])
      .pipe(map(([room]) => room));
  }

  read(room: PackRoomSnapshot): PackContent {
    const own = (type: string) =>
      room.packEvents.find(
        (event) => event.type === type && event.state_key === '',
      );
    return toContent(
      (own(IMAGE_PACK_EVENT_TYPE) ?? own(LEGACY_IMAGE_PACK_EVENT_TYPE))
        ?.content,
    );
  }

  readServer(
    engine: ExpressionEngine,
    accountId: string,
  ): Promise<PackContent> {
    return firstFound(ROOM_TYPES, (type) =>
      engine.fetchRoomState(accountId, this.roomId, type, ''),
    );
  }

  async write(
    engine: ExpressionEngine,
    accountId: string,
    next: PackContent,
  ): Promise<void> {
    // No compare-and-set: another admin's write between readServer and here is overwritten.
    await settled(
      engine.setRoomState(accountId, this.roomId, IMAGE_PACK_EVENT_TYPE, '', {
        pack: next.pack,
        images: next.images,
      }),
    );
  }

  canWrite(room: PackRoomSnapshot): boolean {
    return room.canWritePack;
  }

  defaultName(room: PackRoomSnapshot): string {
    return room.name?.trim() || 'Room emoji';
  }
}

/** The first of `types` the server has, or an empty pack. */
async function firstFound(
  types: readonly string[],
  fetch: (type: string) => Observable<EngineResult<unknown | null>>,
): Promise<PackContent> {
  for (const type of types) {
    const content = await settled(fetch(type));
    if (content !== null) return toContent(content);
  }
  return { pack: {}, images: {} };
}

async function settled<T>(command: Observable<EngineResult<T>>): Promise<T> {
  const result = await firstValueFrom(command);
  if (!result.ok) throw new EngineRequestError(result.failure);
  return result.value;
}

function toContent(content: unknown): PackContent {
  const record = isRecord(content) ? content : {};
  return {
    pack: isRecord(record['pack']) ? record['pack'] : {},
    images: isRecord(record['images']) ? record['images'] : {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
