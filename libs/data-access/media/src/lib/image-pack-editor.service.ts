import {
  InjectionToken,
  Injectable,
  type Signal,
  type Type,
  computed,
  inject,
  signal,
} from '@angular/core';
import { defer, firstValueFrom, from, type Observable } from 'rxjs';
import { type MatrixClient } from 'matrix-js-sdk';
import {
  MatrixClientService,
  projectFromClient,
} from '@trinity/data-access/matrix-client';
import { SHORTCODE_CHARACTERS } from '@trinity/util/matrix';
import {
  MAX_PERSONAL_IMAGES,
  isValidMxcUri,
  type ImagePackUsage,
} from './image-pack.model';
import { ImagePackImageError, prepareImagePackImage } from './image-pack-image';
import {
  AccountPackTarget,
  packEntries,
  type PackEntry,
} from './image-pack-target';
import { MediaService } from './media.service';

const MAX_SHORTCODE_LENGTH = 100;
/** A valid personal-pack shortcode. */
export const SHORTCODE_PATTERN = new RegExp(
  `^[${SHORTCODE_CHARACTERS}]{1,${MAX_SHORTCODE_LENGTH}}$`,
);
const MEGABYTE = 1_048_576;

export type AddInput =
  | { readonly kind: 'file'; readonly file: File }
  | {
      readonly kind: 'existing';
      readonly url: string;
      readonly info?: Record<string, unknown>;
      readonly body?: string;
    };

/**
 * Lazily loads the "Add to your emoji" dialog, which lives in feature-settings, for features
 * that cannot import it. Its inputs are `input: AddInput` and `suggestedName: string`; it
 * closes with the added `PackEntry`, or null. Every opener passes
 * `autoFocus: '[data-autofocus]'` and `dismissGuard: (d) => d?.canDismiss() ?? true`, so
 * nothing dismisses it while an add runs.
 */
export const ADD_TO_IMAGE_PACK_DIALOG = new InjectionToken<
  () => Observable<Type<unknown>>
>('ADD_TO_IMAGE_PACK_DIALOG');

export type ImagePackEditErrorCode =
  | 'invalid-shortcode'
  | 'shortcode-taken'
  | 'pack-full'
  | 'invalid-usage'
  | 'too-large-for-server'
  | 'not-signed-in';

export class ImagePackEditError extends Error {
  constructor(
    readonly code: ImagePackEditErrorCode,
    readonly limitMb?: number,
  ) {
    super(code);
    this.name = 'ImagePackEditError';
  }
}

/** A shortcode proposal from a file or image name; may still be empty. */
export function sanitizeShortcode(name: string): string {
  return name
    .replace(/\.[^.]*$/, '')
    .replace(new RegExp(`[^${SHORTCODE_CHARACTERS}]`, 'g'), '_')
    .slice(0, MAX_SHORTCODE_LENGTH);
}

type Images = Record<string, unknown>;

interface Upload {
  readonly client: MatrixClient;
  readonly sticker: boolean;
  readonly url: string;
  readonly info: Record<string, unknown>;
}

/** Edits the Active Account's personal MSC2545 pack. Writes are queued per client. */
@Injectable({ providedIn: 'root' })
export class ImagePackEditorService {
  private readonly matrix = inject(MatrixClientService);
  private readonly media = inject(MediaService);
  private readonly target = new AccountPackTarget();
  private readonly queues = new WeakMap<MatrixClient, Promise<unknown>>();
  private readonly watches = new WeakMap<MatrixClient, () => void>();
  // Kept until the write succeeds, so a retry does not upload again.
  private readonly uploads = new WeakMap<File, Upload>();
  private readonly personalState = signal<readonly PackEntry[] | null>(null);

  /** The pack's valid entries, or null without an account or before {@link run}. */
  readonly personal: Signal<readonly PackEntry[] | null> =
    this.personalState.asReadonly();

  /** Shortcode → mxc of the pack's emoticon-usage images, for sending them inline. */
  readonly emoticons: Signal<ReadonlyMap<string, string>> = computed(
    () =>
      new Map(
        (this.personal() ?? [])
          .filter((entry) => entry.usage.includes('emoticon'))
          .map((entry) => [entry.shortcode, entry.url]),
      ),
  );

  private readonly projection = projectFromClient({
    id: 'media.image-pack-editor',
    matrix: this.matrix,
    bind: (client) =>
      this.watches.set(
        client,
        this.target.watch(client, () => this.projection.schedule()),
      ),
    unbind: (client) => {
      this.watches.get(client)?.();
      this.watches.delete(client);
    },
    rebuild: (client) =>
      this.personalState.set(packEntries(this.target.read(client))),
    reset: () => this.personalState.set(null),
  });

  /** Cold lifetime: keeps {@link personal} live until the last unsubscribe. */
  run(): Observable<void> {
    return this.projection.run();
  }

  /** Upload a file (or reuse an mxc) and add it under `shortcode`. Cold. */
  add(
    input: AddInput,
    shortcode: string,
    usage: readonly ImagePackUsage[],
  ): Observable<PackEntry> {
    return defer(() =>
      from(this.addEntry(this.client(), input, shortcode, usage)),
    );
  }

  /** Move an entry to a free shortcode, keeping its place in the pack. Cold. */
  rename(from_: string, to: string): Observable<void> {
    return this.edit((images) => {
      if (from_ === to || !Object.hasOwn(images, from_)) return null;
      assertShortcode(to);
      if (Object.hasOwn(images, to)) {
        throw new ImagePackEditError('shortcode-taken');
      }
      return Object.fromEntries(
        Object.entries(images).map(([key, value]) => [
          key === from_ ? to : key,
          value,
        ]),
      );
    });
  }

  /** Cold. */
  setUsage(
    shortcode: string,
    usage: readonly ImagePackUsage[],
  ): Observable<void> {
    return this.edit((images) => {
      assertUsage(usage);
      const raw = images[shortcode];
      if (!isRecord(raw)) return null;
      return { ...images, [shortcode]: { ...raw, usage: [...usage] } };
    });
  }

  /** Cold. */
  remove(shortcode: string): Observable<void> {
    return this.edit((images) => {
      if (!Object.hasOwn(images, shortcode)) return null;
      const { [shortcode]: _removed, ...rest } = images;
      return rest;
    });
  }

  private edit(change: (images: Images) => Images | null): Observable<void> {
    return defer(() => from(this.enqueue(this.client(), change)));
  }

  private client(): MatrixClient {
    if (!this.matrix.isInitialized) {
      throw new ImagePackEditError('not-signed-in');
    }
    return this.matrix.instance;
  }

  private async addEntry(
    client: MatrixClient,
    input: AddInput,
    shortcode: string,
    usage: readonly ImagePackUsage[],
  ): Promise<PackEntry> {
    assertShortcode(shortcode);
    assertUsage(usage);
    // Fails early before an upload; the queued step checks again against the server copy.
    assertRoomFor(this.target.read(client).images, shortcode);
    if (input.kind === 'existing' && !isValidMxcUri(input.url)) {
      throw new ImagePackImageError('unsupported-type');
    }
    const media =
      input.kind === 'file'
        ? await this.upload(client, input.file, usage)
        : input;
    const entry: PackEntry = {
      shortcode,
      url: media.url,
      ...(input.kind === 'existing' && input.body && { body: input.body }),
      ...(media.info && { info: media.info }),
      usage: [...usage],
    };
    const { shortcode: _key, ...raw } = entry;
    await this.enqueue(client, (images) => {
      assertRoomFor(images, shortcode);
      return { ...images, [shortcode]: raw };
    });
    if (input.kind === 'file') this.uploads.delete(input.file);
    return entry;
  }

  private async upload(
    client: MatrixClient,
    file: File,
    usage: readonly ImagePackUsage[],
  ): Promise<Upload> {
    const sticker = usage.includes('sticker');
    const cached = this.uploads.get(file);
    if (cached?.client === client && cached.sticker === sticker) return cached;
    const prepared = await prepareImagePackImage(file, usage);
    const limit = await firstValueFrom(this.media.uploadLimit(client));
    if (limit !== null && prepared.size > limit) {
      throw new ImagePackEditError(
        'too-large-for-server',
        Math.max(1, Math.round(limit / MEGABYTE)),
      );
    }
    const uploaded = await firstValueFrom(
      this.media.uploadMedia(prepared, false, undefined, undefined, client),
    );
    if (!uploaded.mxc) throw new Error('Unencrypted upload returned no mxc.');
    const result = {
      client,
      sticker,
      url: uploaded.mxc,
      info: { ...uploaded.info },
    };
    this.uploads.set(file, result);
    return result;
  }

  /** Each step reads the server copy once the steps before it have written. */
  private enqueue(
    client: MatrixClient,
    change: (images: Images) => Images | null,
  ): Promise<void> {
    const previous = this.queues.get(client) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.applyChange(client, change));
    this.queues.set(client, operation);
    const cleanup = (): void => {
      if (this.queues.get(client) === operation) this.queues.delete(client);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  private async applyChange(
    client: MatrixClient,
    change: (images: Images) => Images | null,
  ): Promise<void> {
    // Account data has no compare-and-set: a write from another device that lands between
    // this read and the write below is overwritten. Reading just before narrows the window.
    const content = await this.target.readServer(client);
    const images = change(content.images);
    if (!images) return;
    const pack =
      typeof content.pack['display_name'] === 'string'
        ? content.pack
        : { ...content.pack, display_name: this.target.defaultName(client) };
    const next = { pack, images };
    await this.target.write(client, next);
    if (this.projection.client() === client) {
      this.personalState.set(packEntries(next));
    }
  }
}

function assertUsage(usage: readonly ImagePackUsage[]): void {
  if (usage.length === 0) throw new ImagePackEditError('invalid-usage');
}

function assertShortcode(shortcode: string): void {
  if (!SHORTCODE_PATTERN.test(shortcode)) {
    throw new ImagePackEditError('invalid-shortcode');
  }
}

function assertRoomFor(images: Images, shortcode: string): void {
  if (Object.hasOwn(images, shortcode)) {
    throw new ImagePackEditError('shortcode-taken');
  }
  if (Object.keys(images).length >= MAX_PERSONAL_IMAGES) {
    throw new ImagePackEditError('pack-full');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
