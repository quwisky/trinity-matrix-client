import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { MediaService, type PackEntry } from '@trinity/data-access/media';
import { packImagePayload } from '../pack-image-payload';

/** A personal-pack image, resolved through the media cache and pinned while shown. */
@Component({
  selector: 'trn-pack-image',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex size-12 items-center justify-center' },
  template: `
    @if (src(); as src) {
      <img
        class="max-h-full max-w-full object-contain"
        [src]="src"
        [alt]="entry().shortcode"
      />
    }
  `,
})
export class PackImageComponent {
  private readonly media = inject(MediaService);
  // A live pack re-emits every entry on each edit; only a new image needs resolving again.
  private readonly image = computed(() => this.entry(), {
    equal: (a, b) => a.url === b.url,
  });

  protected readonly src = signal<string | null>(null);

  readonly entry = input.required<PackEntry>();

  constructor() {
    // shortcut: resolves every tile at once, not only visible ones; add an IntersectionObserver
    // like the picker's sticker image if packs near the 500 cap load slowly.
    effect((onCleanup) => {
      const entry = this.image();
      let pinned: string | null = null;
      this.src.set(null);
      const subscription = this.media
        .resolveMedia(
          packImagePayload(entry.url, entry.info, entry.shortcode),
          'thumbnail',
        )
        .subscribe({
          next: (url) => {
            this.media.pin(url);
            this.media.unpin(pinned);
            pinned = url;
            this.src.set(url);
          },
          error: () => this.src.set(null),
        });
      onCleanup(() => {
        subscription.unsubscribe();
        this.media.unpin(pinned);
      });
    });
  }
}
