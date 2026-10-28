import {
  InjectionToken,
  Injectable,
  type Signal,
  type Type,
  computed,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  Observable,
  defer,
  distinctUntilChanged,
  firstValueFrom,
  from,
  map,
} from 'rxjs';
import {
  projectActiveAccount,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import {
  EngineRequestError,
  SHORTCODE_CHARACTERS,
  plainEqual,
} from '@trinity/util/matrix';
import type { AccountDataSnapshot } from './expression-engine';
import { EXPRESSION_ENGINE } from './expression-engine.token';
import {
  MAX_PERSONAL_IMAGES,
  isValidMxcUri,
  type ImagePackUsage,
} from './image-pack.model';
import { ImagePackImageError, prepareImagePackImage } from './image-pack-image';
import {
  AccountPackTarget,
  RoomPackTarget,
  packEntries,
  type PackEntry,
  type PackTarget,
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

/**
 * Lazily loads the pack grid, which lives in feature-settings, for room settings. Its inputs are
 * `ref: PackRef` and `encrypted: boolean`, whether a room ref's room is encrypted.
 */
export const IMAGE_PACK_EDITOR = new InjectionToken<
  () => Observable<Type<unknown>>
>('IMAGE_PACK_EDITOR');

export type ImagePackEditErrorCode =
  | 'invalid-shortcode'
  | 'shortcode-taken'
  | 'pack-full'
  | 'invalid-usage'
  | 'too-large-for-server'
  | 'not-signed-in'
  | 'not-allowed';

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

/** Which pack an edit applies to: the Active Account's own, or a room's on an exact account. */
export type PackRef =
  | { readonly kind: 'personal' }
  | {
      readonly kind: 'room';
      readonly accountId: string;
      readonly roomId: string;
    };

const PERSONAL: PackRef = { kind: 'personal' };

interface Pack {
  readonly accountId: string;
  readonly target: PackTarget<unknown>;
}

interface Upload {
  readonly accountId: string;
  readonly sticker: boolean;
  readonly url: string;
  readonly info: Record<string, unknown>;
}

/** Edits the Active Account's personal MSC2545 pack, or a room's own pack. Writes are queued per account. */
@Injectable({ providedIn: 'root' })
export class ImagePackEditorService {
  private readonly engine = inject(EXPRESSION_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly media = inject(MediaService);
  private readonly target = new AccountPackTarget();
  private readonly queues = new Map<string, Promise<unknown>>();
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

  private readonly projection = projectActiveAccount<AccountDataSnapshot>({
    id: 'media.image-pack-editor',
    subscribe: (accountId) => this.target.snapshot(this.engine, accountId),
    rebuild: (snapshot) =>
      this.personalState.set(packEntries(this.target.read(snapshot))),
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
    ref: PackRef = PERSONAL,
  ): Observable<PackEntry> {
    return defer(() =>
      from(this.addEntry(this.resolve(ref), input, shortcode, usage)),
    );
  }

  /** A room pack's valid entries, now and on every change. Cold. */
  entries$(
    ref: Extract<PackRef, { kind: 'room' }>,
  ): Observable<readonly PackEntry[]> {
    return defer(() => {
      const { accountId, target } = this.resolve(ref);
      return target.snapshot(this.engine, accountId).pipe(
        map((snapshot) => packEntries(target.read(snapshot))),
        distinctUntilChanged<readonly PackEntry[]>(plainEqual),
      );
    });
  }

  /** Move an entry to a free shortcode, keeping its place in the pack. Cold. */
  rename(from_: string, to: string, ref: PackRef = PERSONAL): Observable<void> {
    return this.edit(ref, (images) => {
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
    ref: PackRef = PERSONAL,
  ): Observable<void> {
    return this.edit(ref, (images) => {
      assertUsage(usage);
      const raw = images[shortcode];
      if (!isRecord(raw)) return null;
      return { ...images, [shortcode]: { ...raw, usage: [...usage] } };
    });
  }

  /** Cold. */
  remove(shortcode: string, ref: PackRef = PERSONAL): Observable<void> {
    return this.edit(ref, (images) => {
      if (!Object.hasOwn(images, shortcode)) return null;
      const { [shortcode]: _removed, ...rest } = images;
      return rest;
    });
  }

  private edit(
    ref: PackRef,
    change: (images: Images) => Images | null,
  ): Observable<void> {
    return defer(() => from(this.enqueue(this.resolve(ref), change)));
  }

  private resolve(ref: PackRef): Pack {
    if (ref.kind === 'personal') {
      const accountId = untracked(this.session.activeAccountId);
      if (!accountId) throw new ImagePackEditError('not-signed-in');
      return { accountId, target: this.target };
    }
    if (!untracked(() => this.session.status(ref.accountId))) {
      throw new ImagePackEditError('not-signed-in');
    }
    return {
      accountId: ref.accountId,
      target: new RoomPackTarget(ref.roomId),
    };
  }

  private async addEntry(
    pack: Pack,
    input: AddInput,
    shortcode: string,
    usage: readonly ImagePackUsage[],
  ): Promise<PackEntry> {
    assertShortcode(shortcode);
    assertUsage(usage);
    // Fails early before an upload; the queued step checks again against the server copy.
    const local = await firstValueFrom(
      pack.target.snapshot(this.engine, pack.accountId),
    );
    assertRoomFor(pack.target.read(local).images, shortcode);
    if (input.kind === 'existing' && !isValidMxcUri(input.url)) {
      throw new ImagePackImageError('unsupported-type');
    }
    const media =
      input.kind === 'file'
        ? await this.upload(pack.accountId, input.file, usage).catch(
            (error: unknown) => {
              throw notSignedIn(error);
            },
          )
        : input;
    const entry: PackEntry = {
      shortcode,
      url: media.url,
      ...(input.kind === 'existing' && input.body && { body: input.body }),
      ...(media.info && { info: media.info }),
      usage: [...usage],
    };
    const { shortcode: _key, ...raw } = entry;
    await this.enqueue(pack, (images) => {
      assertRoomFor(images, shortcode);
      return { ...images, [shortcode]: raw };
    });
    if (input.kind === 'file') this.uploads.delete(input.file);
    return entry;
  }

  private async upload(
    accountId: string,
    file: File,
    usage: readonly ImagePackUsage[],
  ): Promise<Upload> {
    const sticker = usage.includes('sticker');
    const cached = this.uploads.get(file);
    if (cached?.accountId === accountId && cached.sticker === sticker) {
      return cached;
    }
    const prepared = await prepareImagePackImage(file, usage);
    const limit = await firstValueFrom(this.media.uploadLimit(accountId));
    if (limit !== null && prepared.size > limit) {
      throw new ImagePackEditError(
        'too-large-for-server',
        Math.max(1, Math.round(limit / MEGABYTE)),
      );
    }
    const uploaded = await firstValueFrom(
      this.media.uploadMedia(prepared, false, undefined, undefined, accountId),
    );
    if (!uploaded.mxc) throw new Error('Unencrypted upload returned no mxc.');
    const result = {
      accountId,
      sticker,
      url: uploaded.mxc,
      info: { ...uploaded.info },
    };
    this.uploads.set(file, result);
    return result;
  }

  /** Each step reads the server copy once the steps before it have written. */
  private enqueue(
    pack: Pack,
    change: (images: Images) => Images | null,
  ): Promise<void> {
    const { accountId } = pack;
    const previous = this.queues.get(accountId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.applyChange(pack, change));
    this.queues.set(accountId, operation);
    const cleanup = (): void => {
      if (this.queues.get(accountId) === operation) {
        this.queues.delete(accountId);
      }
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  private async applyChange(
    { accountId, target }: Pack,
    change: (images: Images) => Images | null,
  ): Promise<void> {
    // Neither account data nor room state has compare-and-set: a write from elsewhere that
    // lands between this read and the write below is overwritten. Reading just before narrows
    // the window.
    const content = await target
      .readServer(this.engine, accountId)
      .catch((error: unknown) => {
        throw notSignedIn(error);
      });
    const images = change(content.images);
    if (!images) return;
    const pack =
      typeof content.pack['display_name'] === 'string'
        ? content.pack
        : {
            ...content.pack,
            display_name: target.defaultName(
              await firstValueFrom(target.snapshot(this.engine, accountId)),
            ),
          };
    const next = { pack, images };
    try {
      await target.write(this.engine, accountId, next);
    } catch (error) {
      if (!(error instanceof EngineRequestError)) throw error;
      // A room pack is one state event, which servers cap at 64 KiB.
      if (error.failure.code === 'too-large') {
        throw new ImagePackEditError('pack-full');
      }
      if (error.failure.kind === 'permission') {
        throw new ImagePackEditError('not-allowed');
      }
      throw notSignedIn(error);
    }
    // Shown at once, ahead of the sync echo, unless another account has become active.
    if (
      target === this.target &&
      this.projection.accountId() === accountId &&
      untracked(this.session.activeAccountId) === accountId
    ) {
      this.personalState.set(packEntries(next));
    }
  }
}

/** `not-signed-in` for an account without a running client, else `error` itself. */
function notSignedIn(error: unknown): unknown {
  return error instanceof EngineRequestError &&
    error.failure.code === 'account-not-live'
    ? new ImagePackEditError('not-signed-in')
    : error;
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
