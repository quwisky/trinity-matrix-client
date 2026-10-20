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
  sanitizeShortcode,
  type AddInput,
  type ImagePackUsage,
  type PackEntry,
} from '@trinity/data-access/media';
import type { Subscription } from 'rxjs';

type UseAs = 'emoticon' | 'sticker' | 'both';

interface Failure {
  readonly message: string;
  /** Shown under the shortcode field rather than above the actions. */
  readonly field: boolean;
  /** An upload or save failure; the service reuses an uploaded mxc on retry. */
  readonly retry: boolean;
}

const USAGES: Record<UseAs, readonly ImagePackUsage[]> = {
  emoticon: ['emoticon'],
  sticker: ['sticker'],
  both: ['emoticon', 'sticker'],
};

const SHORTCODE_HINT = 'Use 1–100 letters, digits, _ or -.';

/** The dialog's copy for a failed add of `shortcode`. */
export function addFailure(error: unknown, shortcode: string): Failure {
  const plain = (message: string, field = false): Failure => ({
    message,
    field,
    retry: false,
  });
  if (error instanceof ImagePackEditError) {
    switch (error.code) {
      case 'shortcode-taken':
        return plain(
          `You already have :${shortcode}:. Choose another shortcode.`,
          true,
        );
      case 'invalid-shortcode':
        return plain(SHORTCODE_HINT, true);
      case 'pack-full':
        return plain('Your emoji pack is full.');
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
 * "Add to your emoji": names an image and adds it to the personal pack. Shared by Settings and,
 * through `ADD_TO_IMAGE_PACK_DIALOG`, the rooms feature. Closes with the added entry, or null;
 * an account switch closes it with null so nothing is written to the other account.
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
    pattern(path.shortcode, /^[A-Za-z0-9_-]{1,100}$/, {
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

  readonly input = input.required<AddInput>();
  readonly suggestedName = input.required<string>();

  constructor() {
    effect(() => {
      if (this.matrix.activeUserId() !== this.account) this.close(null);
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
      const info = source.info ?? {};
      const subscription = this.media
        .resolveMedia(
          {
            kind: 'image',
            mxc: source.url,
            file: null,
            filename: source.body ?? '',
            mimeType:
              typeof info['mimetype'] === 'string'
                ? info['mimetype']
                : 'image/png',
            thumbnailMxc: null,
            thumbnailFile: null,
          },
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
      .add(this.input(), shortcode, USAGES[useAs])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (entry) => this.close(entry),
        error: (error: unknown) => {
          this.busy.set(false);
          this.failure.set({ ...addFailure(error, shortcode), shortcode });
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
