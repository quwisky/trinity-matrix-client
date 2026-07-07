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
import { type PresenceState, presenceLabel } from '@trinity/util-matrix';
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
  templateUrl: './avatar.component.html',
  styles: [
    `
      :host {
        display: inline-flex;
        position: relative;
      }
      .presence-dot {
        position: absolute;
        right: 0;
        bottom: 0;
        border-radius: 50%;
        /* Ring in the surrounding surface colour so the dot reads as an overlay. */
        box-shadow: 0 0 0 2px var(--trn-presence-ring, var(--background, #fff));
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
  /** Online-status indicator; omit (null) to render no presence dot. */
  readonly presence = input<PresenceState | null>(null);

  private readonly resolver = inject(AVATAR_RESOLVER, { optional: true });

  /** Diameter of the presence dot, scaled to the avatar (floored so it stays visible). */
  readonly dotSize = computed(() => Math.max(8, Math.round(this.size() * 0.3)));

  /** Fill colour for the presence dot, by state. */
  readonly presenceColor = computed(() => {
    switch (this.presence()) {
      case 'online':
        return '#23a55a';
      case 'unavailable':
        return '#f0b232';
      default:
        return '#80848e';
    }
  });

  /** Accessible label / tooltip for the presence dot (null when there's no dot). */
  readonly presenceTitle = computed(() => {
    const state = this.presence();
    return state ? presenceLabel(state) : null;
  });

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
