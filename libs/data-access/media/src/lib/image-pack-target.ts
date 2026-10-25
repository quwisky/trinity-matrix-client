import {
  ClientEvent,
  MatrixError,
  Method,
  RoomStateEvent,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk';
import { liveRoomState } from '@trinity/util/matrix';
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

export interface PackTarget {
  readonly id: string;
  read(client: MatrixClient): PackContent;
  /** The server's copy, read past the SDK store, which a write does not update until sync echoes it. */
  readServer(client: MatrixClient): Promise<PackContent>;
  write(client: MatrixClient, next: PackContent): Promise<void>;
  watch(client: MatrixClient, onChange: () => void): () => void;
  canWrite(client: MatrixClient): boolean;
  /** The `display_name` written when the pack has none. */
  defaultName(client: MatrixClient): string;
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

// The SDK's account-data typing is closed over spec events, so the custom
// MSC2545 keys go through a narrow string-keyed view.
type AccountDataView = {
  getAccountData(type: string): MatrixEvent | undefined;
  setAccountDataRaw(
    type: string,
    content: Record<string, unknown>,
  ): Promise<unknown>;
};

type StateView = {
  sendStateEvent(
    roomId: string,
    type: string,
    content: Record<string, unknown>,
    stateKey: string,
  ): Promise<unknown>;
};

/** The user's own pack, in account data. */
export class AccountPackTarget implements PackTarget {
  readonly id = 'account';

  read(client: MatrixClient): PackContent {
    const view = client as unknown as AccountDataView;
    const content: unknown = (
      view.getAccountData(PERSONAL_IMAGE_PACK_EVENT_TYPE) ??
      view.getAccountData(LEGACY_PERSONAL_IMAGE_PACK_EVENT_TYPE)
    )?.getContent();
    return toContent(content);
  }

  async readServer(client: MatrixClient): Promise<PackContent> {
    const userId = client.getUserId();
    if (!userId) throw new Error('No signed-in user to read the pack for.');
    return firstFound(
      [PERSONAL_IMAGE_PACK_EVENT_TYPE, LEGACY_PERSONAL_IMAGE_PACK_EVENT_TYPE],
      (type) =>
        client.http.authedRequest<unknown>(
          Method.Get,
          `/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(type)}`,
        ),
    );
  }

  async write(client: MatrixClient, next: PackContent): Promise<void> {
    // Raw write, as the management service does: the SDK's setAccountData
    // deep-compares and throws on null-prototype maps.
    await (client as unknown as AccountDataView).setAccountDataRaw(
      PERSONAL_IMAGE_PACK_EVENT_TYPE,
      { pack: next.pack, images: next.images },
    );
  }

  watch(client: MatrixClient, onChange: () => void): () => void {
    const listener = (event: MatrixEvent): void => {
      const type = event.getType();
      if (
        type === PERSONAL_IMAGE_PACK_EVENT_TYPE ||
        type === LEGACY_PERSONAL_IMAGE_PACK_EVENT_TYPE
      ) {
        onChange();
      }
    };
    client.on(ClientEvent.AccountData, listener);
    return () => client.off(ClientEvent.AccountData, listener);
  }

  canWrite(client: MatrixClient): boolean {
    return !!client.getUserId();
  }

  defaultName(): string {
    return PERSONAL_IMAGE_PACK_NAME;
  }
}

/** A room's own pack: state key `""`. The legacy type is read until the first write replaces it. */
export class RoomPackTarget implements PackTarget {
  readonly id: string;

  constructor(readonly roomId: string) {
    this.id = `room:${roomId}`;
  }

  read(client: MatrixClient): PackContent {
    const room = client.getRoom(this.roomId);
    const state = room ? liveRoomState(room) : undefined;
    return toContent(
      (
        state?.getStateEvents(IMAGE_PACK_EVENT_TYPE, '') ??
        state?.getStateEvents(LEGACY_IMAGE_PACK_EVENT_TYPE, '')
      )?.getContent(),
    );
  }

  readServer(client: MatrixClient): Promise<PackContent> {
    return firstFound(
      [IMAGE_PACK_EVENT_TYPE, LEGACY_IMAGE_PACK_EVENT_TYPE],
      (type) => client.getStateEvent(this.roomId, type, ''),
    );
  }

  async write(client: MatrixClient, next: PackContent): Promise<void> {
    // No compare-and-set: another admin's write between readServer and here is overwritten.
    await (client as unknown as StateView).sendStateEvent(
      this.roomId,
      IMAGE_PACK_EVENT_TYPE,
      { pack: next.pack, images: next.images },
      '',
    );
  }

  watch(client: MatrixClient, onChange: () => void): () => void {
    const listener = (event: MatrixEvent): void => {
      const type = event.getType();
      if (
        event.getRoomId() === this.roomId &&
        event.getStateKey() === '' &&
        (type === IMAGE_PACK_EVENT_TYPE ||
          type === LEGACY_IMAGE_PACK_EVENT_TYPE)
      ) {
        onChange();
      }
    };
    client.on(RoomStateEvent.Events, listener);
    return () => client.off(RoomStateEvent.Events, listener);
  }

  canWrite(client: MatrixClient): boolean {
    const userId = client.getUserId();
    const room = client.getRoom(this.roomId);
    const state = room ? liveRoomState(room) : undefined;
    return (
      !!userId && !!state?.maySendStateEvent(IMAGE_PACK_EVENT_TYPE, userId)
    );
  }

  defaultName(client: MatrixClient): string {
    return client.getRoom(this.roomId)?.name?.trim() || 'Room emoji';
  }
}

/** The first of `types` the server has, or an empty pack. */
async function firstFound(
  types: readonly string[],
  fetch: (type: string) => Promise<unknown>,
): Promise<PackContent> {
  for (const type of types) {
    try {
      return toContent(await fetch(type));
    } catch (error) {
      if (!(error instanceof MatrixError && error.errcode === 'M_NOT_FOUND')) {
        throw error;
      }
    }
  }
  return { pack: {}, images: {} };
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
