import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { Observable, filter } from 'rxjs';

/** Moves DOM focus into each entering routed page for keyboard and screen-reader users. */
@Injectable({ providedIn: 'root' })
export class NavigationFocusService {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);

  /** The Application Runtime owns this subscription for exactly one application session. */
  run(): Observable<void> {
    return new Observable((subscriber) => {
      const pendingFrames = new Set<number>();
      const navigation = this.router.events
        .pipe(
          filter(
            (event): event is NavigationEnd => event instanceof NavigationEnd,
          ),
        )
        .subscribe({
          next: () => {
            let completedSynchronously = false;
            let frameId = 0;
            frameId = requestAnimationFrame(() => {
              completedSynchronously = true;
              pendingFrames.delete(frameId);
              this.focusEnteringPage();
              subscriber.next();
            });
            if (!completedSynchronously) pendingFrames.add(frameId);
          },
          error: (error: unknown) => subscriber.error(error),
        });
      return () => {
        navigation.unsubscribe();
        for (const frameId of pendingFrames) cancelAnimationFrame(frameId);
        pendingFrames.clear();
      };
    });
  }

  focusEnteringPage(): void {
    const page = this.document.querySelector<HTMLElement>('router-outlet + *');
    if (!page) return;
    const target =
      page.querySelector<HTMLElement>('[data-route-focus]') ??
      page.querySelector<HTMLElement>('[role="heading"], h1, main') ??
      page;
    if (target.tabIndex < 0) target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
}
