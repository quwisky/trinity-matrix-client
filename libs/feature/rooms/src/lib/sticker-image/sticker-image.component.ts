import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { MediaService, type ImagePackImage } from '@trinity/data-access/media';
import type { MediaPayload } from '@trinity/util/matrix';
import { Subscription } from 'rxjs';

/** Non-interactive image-pack thumbnail used inside the picker's own button. */
@Component({
  selector: 'trn-sticker-image',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sticker-image.component.html',
  styleUrl: './sticker-image.component.scss',
})
export class StickerImageComponent {
  readonly image = input.required<ImagePackImage>();
  protected readonly src = signal<string | null>(null);
  protected readonly failed = signal(false);
  private readonly media = inject(MediaService);
  private readonly destroyRef = inject(DestroyRef);
  private subscription?: Subscription;
  private pinned: string | null = null;

  constructor() {
    effect(() => {
      const image = this.image();
      this.subscription?.unsubscribe();
      this.repin(null);
      this.src.set(null);
      this.failed.set(false);
      this.subscription = this.media
        .resolveMedia(payload(image), 'thumbnail')
        .subscribe({
          next: (url) => {
            this.repin(url);
            this.src.set(url);
          },
          error: () => this.failed.set(true),
        });
    });
    this.destroyRef.onDestroy(() => {
      this.subscription?.unsubscribe();
      this.repin(null);
    });
  }

  private repin(url: string | null): void {
    if (this.pinned && this.pinned !== url) this.media.unpin(this.pinned);
    this.pinned = url;
    this.media.pin(url);
  }
}

function payload(image: ImagePackImage): MediaPayload {
  return {
    kind: 'image',
    mxc: image.url,
    file: null,
    filename: image.body,
    mimeType: image.mimetype ?? 'image/png',
    ...(image.width ? { width: image.width } : {}),
    ...(image.height ? { height: image.height } : {}),
    thumbnailMxc: null,
    thumbnailFile: null,
  };
}
