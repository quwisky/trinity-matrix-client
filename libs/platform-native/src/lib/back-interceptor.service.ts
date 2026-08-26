import { Injectable, computed, signal } from '@angular/core';

/**
 * Feature-owned surfaces native Back should respect before it leaves the page.
 *
 * `AppComponent` owns Android's Back chain and iOS gesture gating, but it cannot see what a
 * feature has open: the rooms shell's right-hand panel is an inline `@if` block, not a CDK
 * dialog, so
 * `TrnDialogService.hasOpen()` has never known about it. That was already a live bug for the
 * members drawer — Back walked straight past an open drawer and out of the room — and it got
 * worse the moment threads, pinned messages and search stopped being dialogs too.
 *
 * The shell cannot simply ask the rooms feature either: `feature-shell` importing
 * `feature-rooms` is a boundary violation, and the panel state is page-scoped besides. So the
 * dependency is inverted — a feature REGISTERS what it can dismiss, and the shell asks
 * without knowing who answered.
 *
 * A stack rather than a single slot, and it unwinds from the top: if two features ever have
 * something open at once, Back should close the most recent, which is what a person means by
 * "back". Registration returns its own removal, so a page that is destroyed with a panel open
 * cannot leave a handler behind that closes something that no longer exists.
 */
export interface BackInterceptor {
  /** Whether this surface would consume Back right now. May read Angular signals. */
  readonly active: () => boolean;
  /** Dismiss the surface. Called only while {@link active} is true. */
  readonly dismiss: () => void;
}

@Injectable({ providedIn: 'root' })
export class BackInterceptorService {
  private readonly interceptors = signal<readonly BackInterceptor[]>([]);

  /**
   * Whether native navigation must yield to a registered surface.
   *
   * `computed` deliberately calls every `active` predicate. A feature predicate can read its
   * own page-scoped signals, so this root service reacts without importing the feature or
   * owning a duplicate boolean that could drift from what Android Back actually dismisses.
   */
  readonly hasActive = computed(() =>
    this.interceptors().some((interceptor) => interceptor.active()),
  );

  /**
   * Offer something Back can close. Returns the function that stops offering it.
   *
   * Availability and dismissal are one registration. Native gesture gating and Android Back
   * therefore consult the same `active` predicate rather than two booleans that can disagree.
   */
  register(interceptor: BackInterceptor): () => void {
    this.interceptors.update((current) => [...current, interceptor]);
    let registered = true;
    return () => {
      if (!registered) {
        return;
      }
      registered = false;
      this.interceptors.update((current) => {
        // Identity, and last occurrence: the same registration object may be offered twice
        // by pages mid-transition, and removing one must not drop the other.
        const at = current.lastIndexOf(interceptor);
        return at < 0
          ? current
          : [...current.slice(0, at), ...current.slice(at + 1)];
      });
    };
  }

  /**
   * Ask each registered interceptor, most recent first, until one handles it.
   *
   * The newest active registration owns the press. Dismissal cannot decline after claiming
   * availability: using one active predicate for this method and native gesture gating is
   * what keeps Android and iOS on the same state model.
   */
  handle(): boolean {
    for (const interceptor of [...this.interceptors()].reverse()) {
      if (interceptor.active()) {
        interceptor.dismiss();
        return true;
      }
    }
    return false;
  }
}
