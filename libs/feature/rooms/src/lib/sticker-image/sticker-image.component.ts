import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
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
  protected readonly label = computed(
    () => this.image().body.slice(0, 256) || this.image().shortcode,
  );
  private readonly media = inject(MediaService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly visible = signal(
    typeof IntersectionObserver === 'undefined',
  );
  private subscription?: Subscription;
  private pinned: string | null = null;
  private observer?: IntersectionObserver;

  constructor() {
    afterNextRender(() => {
      if (typeof IntersectionObserver === 'undefined') return;
      this.observer = new IntersectionObserver(
        (entries) =>
          this.visible.set(entries.some((entry) => entry.isIntersecting)),
        { rootMargin: '160px 0px' },
      );
      this.observer.observe(this.host.nativeElement);
    });
    effect(() => {
      const image = this.image();
      const visible = this.visible();
      this.subscription?.unsubscribe();
      this.repin(null);
      this.src.set(null);
      this.failed.set(false);
      if (!visible) return;
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
      this.observer?.disconnect();
      this.subscription?.unsubscribe();
      this.repin(null);
    });
  }

  protected onImageError(): void {
    this.repin(null);
    this.src.set(null);
    this.failed.set(true);
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
