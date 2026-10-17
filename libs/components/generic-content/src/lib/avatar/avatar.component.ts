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
import { type PresenceState, presenceLabel } from '@trinity/util/matrix';
import {
  AvatarAccountBadgeDirective,
  type AccountBadge,
} from './avatar-account-badge.directive';
import { AVATAR_FILLS, hashSlot } from './avatar-fills';
import { AVATAR_RESOLVER } from './avatar-resolver';
import { resolveTrnAvatarSize, type TrnAvatarSize } from './trn-avatar-size';

/** Semantic avatar geometry: identities are circular; rooms and spaces are squircles. */
export type AvatarShape = 'person' | 'place';

export type { AccountBadge } from './avatar-account-badge.directive';

/**
 * Discord-style avatar over the spartan {@link HlmAvatar}: the image shows once it
 * loads (BrnAvatar swaps to the initials fallback while loading or on error). Bind
 * either a ready `url`, or an `mxc` which is resolved via the injected
 * {@link AVATAR_RESOLVER} (authenticated blob URL) when one is provided.
 *
 * The helm avatar is fixed-size, circular, and neutral-filled, so named `size`, the bounded
 * `exactSize` escape, semantic `shape`, and the name-hashed fallback colour are applied
 * through this wrapper. The shape rule also covers Helm's decorative `::after` outline.
 */
@Component({
  selector: 'trn-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.data-shape]': 'shape()',
    '[attr.data-size]': 'size()',
    '[attr.data-exact-size]': 'exactSize()',
    '[style.--trn-avatar-radius]': 'shapeRadius()',
  },
  imports: [
    HlmAvatar,
    HlmAvatarImage,
    HlmAvatarFallback,
    AvatarAccountBadgeDirective,
  ],
  templateUrl: './avatar.component.html',
  styleUrl: './avatar.component.scss',
})
export class AvatarComponent {
  readonly url = input<string | null>(null);
  /** Raw `mxc://`; resolved via {@link AVATAR_RESOLVER} when one is provided. */
  readonly mxc = input<string | null>(null);
  /**
   * Account that owns this avatar's media. Resolves through THAT account's client, so a
   * mixed-account view never asks one homeserver for another identity's media (which would
   * both leak the association and fail wherever the two servers don't federate media).
   * Null = the active account, which is right for every single-account surface.
   */
  readonly accountId = input<string | null>(null);
  readonly name = input('');
  readonly initial = input('?');
  /** Named geometry from Trinity's ordinal scale. */
  readonly size = input<TrnAvatarSize>('xl');
  /** Bounded 16–256px escape for layouts whose geometry cannot use an ordinal size. */
  readonly exactSize = input<number | null>(null);
  readonly shape = input<AvatarShape>('person');
  /** Online-status indicator; omit (null) to render no presence dot. */
  readonly presence = input<PresenceState | null>(null);
  /**
   * A small owning-account badge in the corner (the mixed-account view): the account's real
   * avatar when it has one, else its initial coloured from its name, with the account name
   * as its label. Null = no badge.
   */
  readonly accountBadge = input<AccountBadge | null>(null);

  private readonly resolver = inject(AVATAR_RESOLVER, { optional: true });

  readonly resolvedSize = computed(() =>
    resolveTrnAvatarSize(this.size(), this.exactSize()),
  );
  /** One inherited radius drives the Helm host, image, fallback and outline together. */
  readonly shapeRadius = computed(() =>
    this.shape() === 'place'
      ? 'var(--trinity-shape-place-radius, 30%)'
      : 'var(--trinity-shape-person-radius, 50%)',
  );

  /** Diameter of the presence dot, scaled to the avatar (floored so it stays visible). */
  readonly dotSize = computed(() =>
    Math.max(8, Math.round(this.resolvedSize() * 0.3)),
  );

  /** Accessible label / tooltip for the presence dot (null when there's no dot). */
  readonly presenceTitle = computed(() => {
    const state = this.presence();
    return state ? presenceLabel(state) : null;
  });

  /** URL resolved from `mxc` via the resolver (null until resolved / no resolver). */
  private readonly resolvedUrl = signal<string | null>(null);

  /** The image source actually shown: a resolved mxc wins, else the direct `url`. */
  readonly src = computed(() => this.resolvedUrl() ?? this.url());

  /** Name-hashed avatar slot; each themed fill carries its own AA ink. */
  private readonly slot = computed(() =>
    hashSlot(this.name() || this.initial()),
  );
  readonly color = computed(() => AVATAR_FILLS[this.slot()].fill);
  readonly initialColor = computed(() => AVATAR_FILLS[this.slot()].ink);

  constructor() {
    // Instances are reused across @for rows, so re-resolve when the bound avatar changes.
    effect((onCleanup) => {
      const mxc = this.mxc();
      const size = this.resolvedSize();
      const accountId = this.accountId() ?? undefined;
      this.resolvedUrl.set(null);
      if (mxc && this.resolver) {
        const sub = this.resolver(mxc, size, accountId).subscribe((resolved) =>
          this.resolvedUrl.set(resolved),
        );
        onCleanup(() => sub.unsubscribe());
      }
    });
  }
}
