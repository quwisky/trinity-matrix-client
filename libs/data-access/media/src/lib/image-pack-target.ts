import {
  ClientEvent,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk';
import {
  LEGACY_PERSONAL_IMAGE_PACK_EVENT_TYPE,
  PERSONAL_IMAGE_PACK_EVENT_TYPE,
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
  write(client: MatrixClient, next: PackContent): Promise<void>;
  watch(client: MatrixClient, onChange: () => void): () => void;
  canWrite(client: MatrixClient): boolean;
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

/** The user's own pack, in account data. */
export class AccountPackTarget implements PackTarget {
  readonly id = 'account';

  read(client: MatrixClient): PackContent {
    const view = client as unknown as AccountDataView;
    const content: unknown = (
      view.getAccountData(PERSONAL_IMAGE_PACK_EVENT_TYPE) ??
      view.getAccountData(LEGACY_PERSONAL_IMAGE_PACK_EVENT_TYPE)
    )?.getContent();
    const record = isRecord(content) ? content : {};
    return {
      pack: isRecord(record['pack']) ? record['pack'] : {},
      images: isRecord(record['images']) ? record['images'] : {},
    };
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
