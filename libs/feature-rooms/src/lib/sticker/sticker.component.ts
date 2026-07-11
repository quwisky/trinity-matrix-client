import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { AVATAR_RESOLVER } from '@trinity/ui';

/**
 * Renders a single sticker/pack image from its `mxc://` URL, resolving it to a
 * displayable (authenticated) URL through the {@link AVATAR_RESOLVER}. Used both in a
 * timeline sticker message and in the composer's sticker picker; `size` sets the
 * rendered edge in pixels. Renders nothing until the image resolves.
 */
@Component({
  selector: 'trn-sticker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (src(); as resolved) {
      <img
        class="sticker"
        [src]="resolved"
        [alt]="label()"
        [style.width.px]="size()"
        [style.height.px]="size()"
        loading="lazy"
        data-testid="sticker-image"
      />
    }
  `,
  styles: `
    :host {
      display: inline-flex;
    }
    .sticker {
      object-fit: contain;
      max-width: 100%;
    }
  `,
})
export class StickerComponent {
  /** `mxc://` URL of the sticker image. */
  readonly mxc = input<string | null>(null);
  /** Accessible label / alt text (the sticker's body or shortcode). */
  readonly label = input('Sticker');
  /** Rendered edge length in pixels. */
  readonly size = input(120);

  private readonly resolver = inject(AVATAR_RESOLVER, { optional: true });

  /** The resolved (authenticated) image URL, or null while loading / unresolved. */
  readonly src = signal<string | null>(null);

  constructor() {
    effect((onCleanup) => {
      const mxc = this.mxc();
      const size = this.size();
      this.src.set(null);
      if (!mxc || !this.resolver) {
        return;
      }
      const sub: Subscription = this.resolver(mxc, size).subscribe((resolved) =>
        this.src.set(resolved),
      );
      onCleanup(() => sub.unsubscribe());
    });
  }
}
