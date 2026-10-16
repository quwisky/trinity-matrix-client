import {
  Directive,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { AVATAR_RESOLVER } from './avatar-resolver';
import { AVATAR_FILLS, hashSlot } from './avatar-fills';

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

/**
 * The state behind an avatar's corner badge in a mixed-account view: its size, colour and
 * resolved image. A directive on the badge element, which `trn-avatar` renders only when it
 * has a badge, so an avatar without one (every timeline row) creates none of this state or
 * its resolve effect. The markup and styles stay with the avatar.
 */
@Directive({
  selector: '[trnAvatarAccountBadge]',
  exportAs: 'trnAvatarAccountBadge',
})
export class AvatarAccountBadgeDirective {
  private readonly resolver = inject(AVATAR_RESOLVER, { optional: true });

  // Not `input.required`: the element's own style bindings read this state, and Angular may
  // evaluate those before it has set the directive's inputs.
  readonly badge = input<AccountBadge | null>(null, {
    alias: 'trnAvatarAccountBadge',
  });
  /** The avatar's diameter in px, which the badge scales from. */
  readonly avatarSize = input(0);

  /** Diameter of the account badge, scaled to the avatar (floored so its letter fits). */
  readonly badgeSize = computed(() =>
    Math.max(14, Math.round(this.avatarSize() * 0.42)),
  );

  /** Account-hashed avatar slot for the badge. Hashed on the user id so two accounts with
   * the same display name stay visually distinct. */
  private readonly badgeSlot = computed(() => {
    const badge = this.badge();
    return hashSlot(badge?.id || badge?.name || '');
  });
  readonly badgeColor = computed(() => AVATAR_FILLS[this.badgeSlot()].fill);
  readonly badgeInk = computed(() => AVATAR_FILLS[this.badgeSlot()].ink);

  /**
   * The badge account's avatar mxc, isolated from the badge object's identity. The host
   * rebuilds its badge map (fresh objects, same contents) on every sync tick, so resolving
   * off `badge()` directly would re-run the effect several times a second — and, because
   * the resolver deliberately doesn't cache failures, re-fetch an unresolvable avatar
   * forever. A computed over the string collapses that to real changes only.
   */
  private readonly badgeMxc = computed(() => this.badge()?.avatarMxc ?? null);

  /** The owning account id, likewise isolated from the badge object's identity so the
   * resolve effect below stays keyed on primitives only. */
  private readonly badgeAccountId = computed(() => this.badge()?.id);

  /** The account badge's avatar, resolved via the resolver (null until resolved / no
   * resolver / the account has no avatar) — when null the badge falls back to its initial. */
  private readonly resolvedBadgeUrl = signal<string | null>(null);
  readonly badgeSrc = this.resolvedBadgeUrl.asReadonly();

  constructor() {
    // Keyed on the mxc rather than the badge object so it only re-resolves when the
    // account's avatar actually changes. The resolver caches by mxc+size, so the same
    // account avatar across many rows is one fetch. Resetting first clears a stale avatar
    // when the badge moves to a different account (it would otherwise show the previous
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

  /**
   * A resolved badge avatar that fails to decode falls back to the initial. The main image
   * gets this from `BrnAvatarImage`'s load/error handling; the badge's plain `<img>` has no
   * such guard, so an undecodable blob would otherwise pin a broken-image glyph in the
   * corner for the session.
   */
  onBadgeImageError(): void {
    this.resolvedBadgeUrl.set(null);
  }
}
