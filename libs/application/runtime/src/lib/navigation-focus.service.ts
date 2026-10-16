import { DOCUMENT } from '@angular/common';
import { Injectable, inject, untracked } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { ROUTED_PAGE_CLASS, isBackgroundNavigation } from '@trinity/util/ui';
import { Observable, filter } from 'rxjs';

/** Landmarks focus can fall back to when the control holding it is removed. */
const LANDMARK =
  'main, nav, aside, [role="main"], [role="navigation"], [role="complementary"], ' +
  '[role="region"], [role="search"], section[aria-label], section[aria-labelledby]';

/** The element that last took focus, and the landmarks around it at that moment. */
interface FocusRecord {
  readonly element: Element;
  /** Nearest first; read while the element was still in the document. */
  readonly landmarks: readonly HTMLElement[];
}

/**
 * Moves DOM focus into each entering routed page for keyboard and screen-reader users.
 *
 * A navigation the person did not make (Router `info` marked as a background navigation,
 * such as a Workspace repair) leaves focus where it is. If that left focus nowhere, because
 * the control holding it was removed, focus moves to the nearest landmark that remains.
 */
@Injectable({ providedIn: 'root' })
export class NavigationFocusService {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);

  /** The Application Runtime owns this subscription for exactly one application session. */
  run(): Observable<void> {
    return new Observable((subscriber) => {
      const pendingFrames = new Set<number>();
      const frame = (work: () => void): void => {
        let completedSynchronously = false;
        let frameId = 0;
        frameId = requestAnimationFrame(() => {
          completedSynchronously = true;
          pendingFrames.delete(frameId);
          work();
        });
        if (!completedSynchronously) pendingFrames.add(frameId);
      };
      let lastFocus: FocusRecord | null = null;
      const onFocusIn = (event: FocusEvent): void => {
        if (event.target instanceof Element) {
          lastFocus = {
            element: event.target,
            landmarks: landmarksAround(event.target),
          };
        }
      };
      this.document.addEventListener('focusin', onFocusIn);
      const navigation = this.router.events
        .pipe(
          filter(
            (event): event is NavigationEnd => event instanceof NavigationEnd,
          ),
        )
        .subscribe({
          next: () => {
            // Router records the navigation just before NavigationEnd; read it now, before a
            // later navigation can replace it.
            const background = isBackgroundNavigation(
              untracked(this.router.lastSuccessfulNavigation)?.extras.info,
            );
            if (!background) {
              frame(() => {
                this.focusEnteringPage();
                subscriber.next();
              });
              return;
            }
            // Look once the navigation has settled, and again a frame later: the view it
            // commits can render after the first frame and remove the focused control then.
            frame(() => {
              this.recoverRemovedFocus(lastFocus);
              frame(() => {
                this.recoverRemovedFocus(lastFocus);
                subscriber.next();
              });
            });
          },
          error: (error: unknown) => subscriber.error(error),
        });
      return () => {
        navigation.unsubscribe();
        this.document.removeEventListener('focusin', onFocusIn);
        for (const frameId of pendingFrames) cancelAnimationFrame(frameId);
        pendingFrames.clear();
      };
    });
  }

  /**
   * Focus the entering page's feature-owned target, else its first heading or main,
   * else the page itself. A candidate inside a pane the current layout hides (the
   * compact Rooms list hides the conversation pane holding the shell's <h1>) cannot
   * take focus, so keep the first candidate the browser actually focuses (#859).
   */
  focusEnteringPage(): void {
    const page = this.document.querySelector<HTMLElement>(
      `.${ROUTED_PAGE_CLASS}`,
    );
    if (!page) return;
    const candidates = [
      ...page.querySelectorAll<HTMLElement>('[data-route-focus]'),
      ...page.querySelectorAll<HTMLElement>('[role="heading"], h1, main'),
      page,
    ];
    this.focusFirst(candidates);
  }

  /**
   * Keep focus where it is, unless the control holding it was removed and focus fell to
   * the document body: then move it to the nearest landmark that remains, else into the
   * page. Focus the person moved away from a control that is still there stays put.
   */
  private recoverRemovedFocus(lastFocus: FocusRecord | null): void {
    const active = this.document.activeElement;
    if (active && active !== this.document.body) return;
    if (!lastFocus || lastFocus.element.isConnected) return;
    const landmarks = lastFocus.landmarks.filter(
      (landmark) => landmark.isConnected,
    );
    if (!this.focusFirst(landmarks)) this.focusEnteringPage();
  }

  /** Focus the first candidate the browser accepts; whether one did. */
  private focusFirst(candidates: readonly HTMLElement[]): boolean {
    for (const target of candidates) {
      if (target.tabIndex < 0) target.tabIndex = -1;
      target.focus({ preventScroll: true });
      if (this.document.activeElement === target) return true;
    }
    return false;
  }
}

/** The landmarks enclosing `element`, nearest first. */
function landmarksAround(element: Element): readonly HTMLElement[] {
  const landmarks: HTMLElement[] = [];
  let landmark = element.parentElement?.closest<HTMLElement>(LANDMARK);
  while (landmark) {
    landmarks.push(landmark);
    landmark = landmark.parentElement?.closest<HTMLElement>(LANDMARK);
  }
  return landmarks;
}
