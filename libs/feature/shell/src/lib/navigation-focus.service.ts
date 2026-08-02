import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

/**
 * Moves keyboard/DOM focus into the entering page after each route change — the a11y
 * behaviour Ionic's focus manager gave us for free (removed with `provideIonicAngular`
 * in the app-shell migration). Without it, focus is left on whatever triggered the
 * navigation (e.g. a toolbar button that's now off-screen), stranding screen-reader
 * and keyboard users on the page they just left.
 *
 * The routed page renders as the sibling right after `<router-outlet>` (see
 * `app.component.html`); we focus its main heading, falling back to `<main>` then the
 * page root, making the target programmatically focusable (`tabindex="-1"`) without
 * leaving a persistent tab stop.
 */
@Injectable({ providedIn: 'root' })
export class NavigationFocusService {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  /** Wire the router subscription. Call once at bootstrap. */
  init(): void {
    this.router.events
      .pipe(
        filter(
          (event): event is NavigationEnd => event instanceof NavigationEnd,
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        // Defer to the next frame so the entering view is attached + painted before
        // we look for its heading. Pure DOM focus, no Angular state written.
        requestAnimationFrame(() => this.focusEnteringPage());
      });
  }

  /** Move focus into the newly-rendered routed page (the element after the outlet). */
  focusEnteringPage(): void {
    const page = this.document.querySelector<HTMLElement>('router-outlet + *');
    if (!page) {
      return;
    }
    const target =
      page.querySelector<HTMLElement>('[role="heading"], h1, main') ?? page;
    // Headings/<main> aren't focusable by default; make it programmatically
    // focusable without adding it to the tab order.
    if (target.tabIndex < 0) {
      target.tabIndex = -1;
    }
    target.focus({ preventScroll: true });
  }
}
