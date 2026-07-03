import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  HlmAvatar,
  HlmAvatarFallback,
  HlmAvatarImage,
} from '@trinity/helm/avatar';
import { AVATAR_RESOLVER } from './avatar-resolver';

/**
 * Discord-style avatar over the spartan {@link HlmAvatar}: the image shows once it
 * loads (BrnAvatar swaps to the initials fallback while loading or on error). Bind
 * either a ready `url`, or an `mxc` which is resolved via the injected
 * {@link AVATAR_RESOLVER} (authenticated blob URL) when one is provided.
 *
 * The helm avatar is fixed-size, circular, and neutral-filled, so `size` (arbitrary
 * px), `square` (rounded-rect for spaces), and the name-hashed fallback colour are
 * applied as inline styles, which win over hlm's utility classes.
 */
@Component({
  selector: 'trn-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmAvatar, HlmAvatarImage, HlmAvatarFallback],
  template: `
    <hlm-avatar
      [style.width.px]="size()"
      [style.height.px]="size()"
      [style.borderRadius]="square() ? '30%' : null"
    >
      @if (src()) {
        <img
          hlmAvatarImage
          [src]="src()"
          [alt]="name()"
          [style.borderRadius]="square() ? '30%' : null"
        />
      }
      <span
        hlmAvatarFallback
        class="leading-none font-semibold"
        [style.background]="color()"
        [style.color]="'#fff'"
        [style.font-size.px]="size() * 0.4"
        [style.borderRadius]="square() ? '30%' : null"
        >{{ initial() }}</span
      >
    </hlm-avatar>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
      }
    `,
  ],
})
export class AvatarComponent {
  readonly url = input<string | null>(null);
  /** Raw `mxc://`; resolved via {@link AVATAR_RESOLVER} when one is provided. */
  readonly mxc = input<string | null>(null);
  readonly name = input('');
  readonly initial = input('?');
  readonly size = input(40);
  readonly square = input(false);

  private readonly resolver = inject(AVATAR_RESOLVER, { optional: true });

  /** URL resolved from `mxc` via the resolver (null until resolved / no resolver). */
  private readonly resolvedUrl = signal<string | null>(null);

  /** The image source actually shown: a resolved mxc wins, else the direct `url`. */
  readonly src = computed(() => this.resolvedUrl() ?? this.url());

  /** Stable color picked from the name, like Discord's default avatars. */
  readonly color = computed(() => {
    const palette = [
      '#5865f2',
      '#3ba55d',
      '#faa81a',
      '#ed4245',
      '#eb459e',
      '#9b59b6',
    ];
    const key = this.name() || this.initial();
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) | 0;
    }
    return palette[Math.abs(hash) % palette.length];
  });

  constructor() {
    // Re-resolve when the bound avatar changes (instances are reused across @for
    // rows); the subscription is torn down on the next run/destroy.
    effect((onCleanup) => {
      const mxc = this.mxc();
      const size = this.size();
      this.resolvedUrl.set(null);
      if (mxc && this.resolver) {
        const sub = this.resolver(mxc, size).subscribe((resolved) =>
          this.resolvedUrl.set(resolved),
        );
        onCleanup(() => sub.unsubscribe());
      }
    });
  }
}
