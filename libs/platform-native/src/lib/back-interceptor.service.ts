import { Injectable } from '@angular/core';

/**
 * Things Android's hardware Back should close before it leaves the page.
 *
 * `AppComponent` owns the Back chain, but it cannot see what a feature has open: the rooms
 * shell's right-hand panel is an inline `@if` block, not a CDK dialog, so
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
export type BackInterceptor = () => boolean;

@Injectable({ providedIn: 'root' })
export class BackInterceptorService {
  private readonly interceptors: BackInterceptor[] = [];

  /**
   * Offer something Back can close. Returns the function that stops offering it.
   *
   * The interceptor returns `true` if it handled the press — it had something open and closed
   * it — and `false` if it did not, in which case the next one down is asked.
   */
  register(interceptor: BackInterceptor): () => void {
    this.interceptors.push(interceptor);
    return () => {
      // `lastIndexOf`, and guarded: the same function may be registered twice by two pages
      // mid-transition, and calling a removal twice must not drop somebody else's.
      const at = this.interceptors.lastIndexOf(interceptor);
      if (at >= 0) {
        this.interceptors.splice(at, 1);
      }
    };
  }

  /**
   * Ask each registered interceptor, most recent first, until one handles it.
   *
   * Iterated over a COPY: an interceptor is free to unregister itself as it closes — which is
   * the normal case, since closing the last panel means there is nothing left to intercept —
   * and mutating the array mid-loop would skip its neighbour.
   */
  handle(): boolean {
    for (const interceptor of [...this.interceptors].reverse()) {
      if (interceptor()) {
        return true;
      }
    }
    return false;
  }
}
