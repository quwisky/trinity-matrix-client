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
import { AVATAR_RESOLVER } from './avatar-resolver';
import { resolveTrnAvatarSize, type TrnAvatarSize } from './trn-avatar-size';

/**
 * Owning-account badge for the mixed-account corner overlay: the account's real avatar
 * (`avatarMxc`, resolved to an image) with a name-hashed initial as the fallback while it
 * loads or when the account has no avatar set.
 */
export interface AccountBadge {
  /** The owning account's user id — the badge's stable identity. Two accounts can share a
   * display name, so the hashed colour and the resolver both key off this, not the name. */
  readonly id: string;
  readonly initial: string;
  readonly name: string;
  /** The account's raw `mxc://` avatar; resolved via the resolver, initial as fallback. */
  readonly avatarMxc?: string | null;
}

/** Semantic avatar geometry: identities are circular; rooms and spaces are squircles. */
export type AvatarShape = 'person' | 'place';

/** The six themed avatar fills, each with its own AA ink. Spelled out in full so the token guard sees every name. */
const AVATAR_FILLS = [
  { fill: 'var(--trinity-avatar-1)', ink: 'var(--trinity-avatar-1-ink)' },
  { fill: 'var(--trinity-avatar-2)', ink: 'var(--trinity-avatar-2-ink)' },
  { fill: 'var(--trinity-avatar-3)', ink: 'var(--trinity-avatar-3-ink)' },
  { fill: 'var(--trinity-avatar-4)', ink: 'var(--trinity-avatar-4-ink)' },
  { fill: 'var(--trinity-avatar-5)', ink: 'var(--trinity-avatar-5-ink)' },
  { fill: 'var(--trinity-avatar-6)', ink: 'var(--trinity-avatar-6-ink)' },
] as const;

/** Stable 0-based index into {@link AVATAR_FILLS} from a key, like Discord's default avatars. */
function hashSlot(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % AVATAR_FILLS.length;
}

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
  imports: [HlmAvatar, HlmAvatarImage, HlmAvatarFallback],
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

  /** Diameter of the account badge, scaled to the avatar (floored so its letter fits). */
  readonly badgeSize = computed(() =>
    Math.max(14, Math.round(this.resolvedSize() * 0.42)),
  );

  /** Account-hashed avatar slot for the badge. Hashed on the user id so two accounts with
   * the same display name stay visually distinct. */
  private readonly badgeSlot = computed(() => {
    const badge = this.accountBadge();
    return hashSlot(badge?.id || badge?.name || '');
  });
  readonly badgeColor = computed(() => AVATAR_FILLS[this.badgeSlot()].fill);
  readonly badgeInk = computed(() => AVATAR_FILLS[this.badgeSlot()].ink);

  /** Accessible label / tooltip for the presence dot (null when there's no dot). */
  readonly presenceTitle = computed(() => {
    const state = this.presence();
    return state ? presenceLabel(state) : null;
  });

  /** URL resolved from `mxc` via the resolver (null until resolved / no resolver). */
  private readonly resolvedUrl = signal<string | null>(null);

  /** The image source actually shown: a resolved mxc wins, else the direct `url`. */
  readonly src = computed(() => this.resolvedUrl() ?? this.url());

  /**
   * The badge account's avatar mxc, isolated from the badge object's identity. The host
   * rebuilds its badge map (fresh objects, same contents) on every sync tick, so resolving
   * off `accountBadge()` directly would re-run the effect several times a second — and,
   * because the resolver deliberately doesn't cache failures, re-fetch an unresolvable
   * avatar forever. A computed over the string collapses that to real changes only.
   */
  private readonly badgeMxc = computed(
    () => this.accountBadge()?.avatarMxc ?? null,
  );

  /** The owning account id, likewise isolated from the badge object's identity so the
   * resolve effect below stays keyed on primitives only. */
  private readonly badgeAccountId = computed(() => this.accountBadge()?.id);

  /** The account badge's avatar, resolved via the resolver (null until resolved / no
   * resolver / the account has no avatar) — when null the badge falls back to its initial. */
  private readonly resolvedBadgeUrl = signal<string | null>(null);
  readonly badgeSrc = this.resolvedBadgeUrl.asReadonly();

  /**
   * A resolved badge avatar that fails to decode falls back to the initial. The main image
   * gets this from `BrnAvatarImage`'s load/error handling; the badge's plain `<img>` has no
   * such guard, so an undecodable blob would otherwise pin a broken-image glyph in the
   * corner for the session.
   */
  protected onBadgeImageError(): void {
    this.resolvedBadgeUrl.set(null);
  }

  /** Name-hashed avatar slot; each themed fill carries its own AA ink. */
  private readonly slot = computed(() =>
    hashSlot(this.name() || this.initial()),
  );
  readonly color = computed(() => AVATAR_FILLS[this.slot()].fill);
  readonly initialColor = computed(() => AVATAR_FILLS[this.slot()].ink);

  constructor() {
    // Re-resolve when the bound avatar changes (instances are reused across @for
    // rows); the subscription is torn down on the next run/destroy.
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
    // Resolve the account badge's own avatar independently (mixed-account view), keyed on
    // the mxc rather than the badge object so it only re-resolves when the account's avatar
    // actually changes. The resolver caches by mxc+size, so the same account avatar across
    // many rows is one fetch. Resetting first clears a stale avatar when an instance is
    // recycled onto a row owned by a different account (it would otherwise show the previous
    // account's face under the new account's label).
    effect((onCleanup) => {
      const mxc = this.badgeMxc();
      const size = this.badgeSize();
      const accountId = this.badgeAccountId();
      this.resolvedBadgeUrl.set(null);
      if (mxc && this.resolver) {
        // Through the OWNING account's client: resolving a mixed-in account's avatar via
        // the active account would make its homeserver fetch (and log) the other identity's
        // media.
        const sub = this.resolver(mxc, size, accountId).subscribe((resolved) =>
          this.resolvedBadgeUrl.set(resolved),
        );
        onCleanup(() => sub.unsubscribe());
      }
    });
  }
}
