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

/** The two inks an initial may be drawn in; the higher-contrast one wins. */
const INK_DARK = '#1a1a1a';
const INK_LIGHT = '#ffffff';

/**
 * WCAG 2.x relative luminance of a full `#rrggbb` colour. Note this is *not* the
 * cheap YIQ "perceived brightness" — YIQ ranks these palette colours differently
 * from real luminance, so no YIQ threshold can pick the right ink for all of them.
 */
function relativeLuminance(hex: string): number {
  const linear = (offset: number) => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(1) + 0.7152 * linear(3) + 0.0722 * linear(5);
}

/** WCAG contrast ratio between two relative luminances (AA body text needs 4.5). */
function contrastRatio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Discord-style default-avatar palette (name-hashed). */
const PALETTE = [
  '#5865f2',
  '#3ba55d',
  '#faa81a',
  '#ed4245',
  '#eb459e',
  '#9b59b6',
];

/** Stable colour picked from a key, like Discord's default avatars. */
function hashColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/** Whichever ink (dark/light) scores the higher WCAG contrast against `hex`. */
function readableInk(hex: string): string {
  const bg = relativeLuminance(hex);
  return contrastRatio(bg, relativeLuminance(INK_DARK)) >=
    contrastRatio(bg, relativeLuminance(INK_LIGHT))
    ? INK_DARK
    : INK_LIGHT;
}

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
        box-shadow: 0 0 0 2px var(--trn-presence-ring, var(--background));
      }
      .account-badge {
        position: absolute;
        /* Bottom-LEFT: the presence dot owns bottom-right, and a DM row in the mixed view
           carries both — same corner would hide the online indicator entirely. */
        left: -2px;
        bottom: -2px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        font-weight: 700;
        line-height: 1;
        overflow: hidden;
        /* Ring in the surrounding surface colour so the badge reads as an overlay. */
        box-shadow: 0 0 0 2px var(--trn-presence-ring, var(--background));
      }
      .account-badge__img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: 50%;
      }
    `,
  ],
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
  readonly size = input(40);
  readonly square = input(false);
  /** Online-status indicator; omit (null) to render no presence dot. */
  readonly presence = input<PresenceState | null>(null);
  /**
   * A small owning-account badge in the corner (the mixed-account view): the account's real
   * avatar when it has one, else its initial coloured from its name, with the account name
   * as its label. Null = no badge.
   */
  readonly accountBadge = input<AccountBadge | null>(null);

  private readonly resolver = inject(AVATAR_RESOLVER, { optional: true });

  /** Diameter of the presence dot, scaled to the avatar (floored so it stays visible). */
  readonly dotSize = computed(() => Math.max(8, Math.round(this.size() * 0.3)));

  /** Diameter of the account badge, scaled to the avatar (floored so its letter fits). */
  readonly badgeSize = computed(() =>
    Math.max(14, Math.round(this.size() * 0.42)),
  );

  /** Account-hashed fill for the badge, and a readable ink for its letter. Hashed on the
   * user id so two accounts with the same display name stay visually distinct. */
  readonly badgeColor = computed(() => {
    const badge = this.accountBadge();
    return hashColor(badge?.id || badge?.name || '');
  });
  readonly badgeInk = computed(() => readableInk(this.badgeColor()));

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

  /** Stable color picked from the name, like Discord's default avatars. */
  readonly color = computed(() => hashColor(this.name() || this.initial()));

  /** Readable text colour for the initial on the hashed background: whichever ink
   * scores the higher WCAG contrast ratio against it — so a single letter always
   * meets contrast (every palette entry clears AA under that choice). */
  readonly initialColor = computed(() => readableInk(this.color()));

  constructor() {
    // Re-resolve when the bound avatar changes (instances are reused across @for
    // rows); the subscription is torn down on the next run/destroy.
    effect((onCleanup) => {
      const mxc = this.mxc();
      const size = this.size();
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
