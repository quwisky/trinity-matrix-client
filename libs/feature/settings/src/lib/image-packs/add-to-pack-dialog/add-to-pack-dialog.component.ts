import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormField,
  FormRoot,
  disabled,
  form,
  pattern,
  required,
} from '@angular/forms/signals';
import {
  TrnButton,
  TrnInput,
  TrnLabel,
  TrnRadioGroupComponent,
  type TrnRadioOption,
} from '@trinity/components/controls';
import {
  TrnDialogActions,
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  ImagePackEditError,
  ImagePackEditorService,
  ImagePackImageError,
  MediaService,
  SHORTCODE_PATTERN,
  sanitizeShortcode,
  type AddInput,
  type ImagePackUsage,
  type PackEntry,
  type PackRef,
} from '@trinity/data-access/media';
import type { Subscription } from 'rxjs';
import { packImagePayload } from '../pack-image-payload';

export type UseAs = 'emoticon' | 'sticker' | 'both';

interface Failure {
  readonly message: string;
  /** Shown under the shortcode field rather than above the actions. */
  readonly field: boolean;
  /** An upload or save failure; the service reuses an uploaded mxc on retry. */
  readonly retry: boolean;
}

export const USAGES: Record<UseAs, readonly ImagePackUsage[]> = {
  emoticon: ['emoticon'],
  sticker: ['sticker'],
  both: ['emoticon', 'sticker'],
};

export const PERSONAL_PACK: PackRef = { kind: 'personal' };

/** What a pack editor calls its pack, per kind. */
export const PACK_COPY = {
  personal: {
    title: 'Your emoji',
    empty: 'Add images to use your own emoji and stickers in every room.',
    full: 'Your emoji pack is full.',
    remove: (code: string) => `Remove :${code}: from your emoji?`,
    changeFailed: 'Couldn’t change your emoji. Try again.',
    taken: (code: string) =>
      `You already have :${code}:. Choose another shortcode.`,
    addTitle: 'Add to your emoji',
    adding: 'Adding to your emoji…',
  },
  room: {
    title: 'Room emoji',
    empty:
      'Add images to give everyone in this room its own emoji and stickers.',
    full: "This room's emoji pack is full.",
    remove: (code: string) => `Remove :${code}: from this room's emoji?`,
    changeFailed: "Couldn’t change this room's emoji. Try again.",
    taken: (code: string) =>
      `This room already has :${code}:. Choose another shortcode.`,
    addTitle: 'Add to room emoji',
    adding: 'Adding to room emoji…',
  },
} as const satisfies Record<PackRef['kind'], unknown>;

export const SHORTCODE_HINT =
  'Use 1–100 letters, digits, underscores or hyphens.';

/** The dialog's copy for a failed add of `shortcode`. */
export function addFailure(
  error: unknown,
  shortcode: string,
  kind: PackRef['kind'] = 'personal',
): Failure {
  const copy = PACK_COPY[kind];
  const plain = (message: string, field = false): Failure => ({
    message,
    field,
    retry: false,
  });
  if (error instanceof ImagePackEditError) {
    switch (error.code) {
      case 'shortcode-taken':
        return plain(copy.taken(shortcode), true);
      case 'invalid-shortcode':
        return plain(SHORTCODE_HINT, true);
      case 'pack-full':
        return plain(copy.full);
      case 'too-large-for-server':
        return plain(
          `This image is larger than your server allows (max ${error.limitMb} MB).`,
        );
      case 'not-signed-in':
        return plain('Sign in to add emoji.');
      case 'invalid-usage':
        return plain('Choose how to use this image.');
    }
  }
  if (error instanceof ImagePackImageError) {
    return plain(
      error.code === 'animated-too-large'
        ? 'This animated image is too large (max 1 MB).'
        : 'Use a PNG, JPEG, WebP or GIF image.',
    );
  }
  return { message: 'Couldn’t add the image.', field: false, retry: true };
}

/**
 * "Add to your emoji": names an image and adds it to the personal pack, or to `ref`'s room
 * pack. Shared by Settings, room settings and, through `ADD_TO_IMAGE_PACK_DIALOG`, the rooms
 * feature. Closes with the added entry, or null. For the personal pack, an account switch
 * closes it with null so nothing is written to the other account; an add already started
 * still finishes on the original account. A room ref pins its own account.
 */
@Component({
  selector: 'trn-add-to-pack-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormField,
    FormRoot,
    TrnButton,
    TrnDialogActions,
    TrnDialogShellComponent,
    TrnInput,
    TrnLabel,
    TrnRadioGroupComponent,
  ],
  templateUrl: './add-to-pack-dialog.component.html',
})
export class AddToPackDialogComponent {
  private readonly editor = inject(ImagePackEditorService);
  private readonly media = inject(MediaService);
  private readonly matrix = inject(MatrixClientService);
  private readonly dialogRef =
    inject<TrnDialogRef<PackEntry | null>>(TrnDialogRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly account = this.matrix.activeUserId();
  private running: Subscription | null = null;

  protected readonly useAsOptions: readonly TrnRadioOption<UseAs>[] = [
    { value: 'emoticon', label: 'Emoji', testId: 'add-to-pack-use-emoticon' },
    { value: 'sticker', label: 'Sticker', testId: 'add-to-pack-use-sticker' },
    { value: 'both', label: 'Both', testId: 'add-to-pack-use-both' },
  ];
  protected readonly model = linkedSignal(() => ({
    shortcode: sanitizeShortcode(this.suggestedName()),
    useAs: 'emoticon' as UseAs,
  }));
  protected readonly busy = signal(false);
  protected readonly addForm = form(this.model, (path) => {
    required(path.shortcode, { message: SHORTCODE_HINT });
    pattern(path.shortcode, SHORTCODE_PATTERN, {
      message: SHORTCODE_HINT,
    });
    disabled(path.shortcode, { when: () => this.busy() });
  });
  protected readonly failure = signal<
    (Failure & { readonly shortcode: string }) | null
  >(null);
  /** A clash or shortcode error, until the shortcode changes. */
  protected readonly shortcodeError = computed(() => {
    const failure = this.failure();
    if (failure?.field && failure.shortcode === this.model().shortcode) {
      return failure.message;
    }
    const field = this.addForm.shortcode();
    return field.touched() ? (field.errors()[0]?.message ?? null) : null;
  });
  protected readonly formError = computed(() => {
    const failure = this.failure();
    return failure && !failure.field ? failure : null;
  });
  protected readonly preview = signal<string | null>(null);
  protected readonly copy = computed(() => PACK_COPY[this.ref().kind]);

  readonly input = input.required<AddInput>();
  readonly suggestedName = input.required<string>();
  readonly ref = input<PackRef>(PERSONAL_PACK);

  constructor() {
    effect(() => {
      // A room ref pins its own account, so only the personal pack follows the active one.
      if (
        this.ref().kind === 'personal' &&
        this.matrix.activeUserId() !== this.account
      ) {
        this.close(null);
      }
    });
    effect((onCleanup) => {
      const source = this.input();
      if (source.kind === 'file') {
        const url = URL.createObjectURL(source.file);
        this.preview.set(url);
        onCleanup(() => URL.revokeObjectURL(url));
        return;
      }
      let pinned: string | null = null;
      const subscription = this.media
        .resolveMedia(
          packImagePayload(source.url, source.info, source.body),
          'thumbnail',
        )
        .subscribe({
          next: (url) => {
            this.media.pin(url);
            pinned = url;
            this.preview.set(url);
          },
          error: () => this.preview.set(null),
        });
      onCleanup(() => {
        subscription.unsubscribe();
        this.media.unpin(pinned);
      });
    });
  }

  /** The opener's dismiss guard: no Escape, backdrop or Back while an add runs. */
  canDismiss(): boolean {
    return !this.busy();
  }

  protected setUseAs(useAs: UseAs): void {
    this.model.update((value) => ({ ...value, useAs }));
  }

  protected add(): void {
    if (this.busy()) return;
    if (this.addForm.shortcode().invalid()) {
      this.addForm.shortcode().markAsTouched();
      return;
    }
    const { shortcode, useAs } = this.model();
    this.busy.set(true);
    this.failure.set(null);
    this.running = this.editor
      .add(this.input(), shortcode, USAGES[useAs], this.ref())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (entry) => this.close(entry),
        error: (error: unknown) => {
          this.busy.set(false);
          this.failure.set({
            ...addFailure(error, shortcode, this.ref().kind),
            shortcode,
          });
        },
      });
  }

  protected cancel(): void {
    if (!this.busy()) this.close(null);
  }

  private close(result: PackEntry | null): void {
    this.running?.unsubscribe();
    this.dialogRef.close(result);
  }
}
